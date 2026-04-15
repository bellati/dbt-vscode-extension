import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import * as vscode from "vscode";

type DbtManifest = {
  nodes?: Record<string, { name?: string; package_name?: string; resource_type?: string }>;
  sources?: Record<string, { source_name?: string; name?: string }>;
};

export type RefTarget = {
  name: string;
  packageName?: string;
};

type CompletionState = {
  refs: string[];
  refTargets: RefTarget[];
  refPackages: string[];
  refsByPackage: Map<string, string[]>;
  sourcesByName: Map<string, string[]>;
};

const MANIFEST_VARIANTS = ["target/manifest.json", "target/manifests.json"];

function execFileAsync(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function dedupeAndSort(items: Iterable<string>): string[] {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}

export class ManifestStore implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private state: CompletionState = {
    refs: [],
    refTargets: [],
    refPackages: [],
    refsByPackage: new Map(),
    sourcesByName: new Map()
  };
  private manifestPath?: string;
  private dbtAvailable = false;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.name = "dbt Auto Complete";
    this.statusBar.command = "dbtAutoComplete.refreshManifest";
    this.statusBar.show();
  }

  public dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }

    this.statusBar.dispose();
  }

  public get refs(): string[] {
    return this.state.refs;
  }

  public get sourceNames(): string[] {
    return dedupeAndSort(this.state.sourcesByName.keys());
  }

  public get refTargets(): RefTarget[] {
    return this.state.refTargets;
  }

  public get refPackages(): string[] {
    return this.state.refPackages;
  }

  public getRefsForPackage(packageName: string): string[] {
    return this.state.refsByPackage.get(packageName) ?? [];
  }

  public getTablesForSource(sourceName: string): string[] {
    return this.state.sourcesByName.get(sourceName) ?? [];
  }

  public async initialize(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.setStatus("dbt: open a workspace folder");
      return;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    this.dbtAvailable = await this.ensureDbtInstalled();
    if (!this.dbtAvailable) {
      return;
    }

    this.createWatchers();
    this.manifestPath = await this.ensureManifest(workspaceRoot);
    if (!this.manifestPath) {
      this.setStatus("dbt: manifest unavailable");
      return;
    }

    await this.reloadManifest(this.manifestPath);
  }

  public async refresh(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    this.dbtAvailable = await this.ensureDbtInstalled();
    if (!this.dbtAvailable) {
      return;
    }

    this.manifestPath = await this.ensureManifest(workspaceFolder.uri.fsPath, true);
    if (this.manifestPath) {
      await this.reloadManifest(this.manifestPath);
    }
  }

  private async ensureDbtInstalled(): Promise<boolean> {
    try {
      await execFileAsync("dbt", ["--version"], process.cwd());
      this.setStatus("dbt: ready");
      return true;
    } catch {
      this.setStatus("dbt: CLI missing");
      void vscode.window.showErrorMessage(
        "dbt Auto Complete requires the dbt CLI to be installed and available on PATH."
      );
      return false;
    }
  }

  private createWatchers(): void {
    if (this.watchers.length > 0) {
      return;
    }

    const configuredRelativePath = vscode.workspace
      .getConfiguration("dbtAutoComplete")
      .get<string>("manifestRelativePath", "target/manifest.json");

    for (const relativePattern of dedupeAndSort([configuredRelativePath, ...MANIFEST_VARIANTS])) {
      const pattern = new vscode.RelativePattern(vscode.workspace.workspaceFolders?.[0] ?? "", relativePattern);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate((uri) => void this.reloadManifest(uri.fsPath));
      watcher.onDidChange((uri) => void this.reloadManifest(uri.fsPath));
      watcher.onDidDelete(() => {
        this.state = {
          refs: [],
          refTargets: [],
          refPackages: [],
          refsByPackage: new Map(),
          sourcesByName: new Map()
        };
        this.manifestPath = undefined;
        this.setStatus("dbt: manifest deleted");
      });
      this.watchers.push(watcher);
      this.context.subscriptions.push(watcher);
    }
  }

  private async ensureManifest(workspaceRoot: string, forceRefresh = false): Promise<string | undefined> {
    const configuredRelativePath = vscode.workspace
      .getConfiguration("dbtAutoComplete")
      .get<string>("manifestRelativePath", "target/manifest.json");

    const candidates = dedupeAndSort([
      configuredRelativePath,
      ...MANIFEST_VARIANTS
    ]).map((relativePath) => path.join(workspaceRoot, relativePath));

    for (const candidate of candidates) {
      if (!forceRefresh && (await this.pathExists(candidate))) {
        return candidate;
      }
    }

    this.setStatus("dbt: generating manifest");

    try {
      await execFileAsync("dbt", ["parse"], workspaceRoot);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `dbt Auto Complete could not generate a manifest with "dbt parse": ${this.formatError(error)}`
      );
      this.setStatus("dbt: parse failed");
      return undefined;
    }

    for (const candidate of candidates) {
      if (await this.pathExists(candidate)) {
        return candidate;
      }
    }

    this.setStatus("dbt: manifest missing");
    void vscode.window.showWarningMessage(
      "dbt Auto Complete ran \"dbt parse\" but no manifest.json or manifests.json file was found."
    );
    return undefined;
  }

  private async reloadManifest(manifestPath: string): Promise<void> {
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as DbtManifest;

      const refPackages = new Set<string>();
      const refsByPackage = new Map<string, string[]>();
      const refTargets = Object.values(parsed.nodes ?? {})
        .filter((node) => this.isRefableNode(node))
        .map((node) => ({ name: node.name, packageName: node.package_name }))
        .sort((left, right) => {
          const nameOrder = left.name.localeCompare(right.name);
          if (nameOrder !== 0) {
            return nameOrder;
          }

          return (left.packageName ?? "").localeCompare(right.packageName ?? "");
        });
      const refs = dedupeAndSort(
        refTargets.map((target) => {
          if (target.packageName) {
            refPackages.add(target.packageName);
            const packageRefs = refsByPackage.get(target.packageName) ?? [];
            packageRefs.push(target.name);
            refsByPackage.set(target.packageName, dedupeAndSort(packageRefs));
          }

          return target.name;
        })
      );

      const sourcesByName = new Map<string, string[]>();
      for (const source of Object.values(parsed.sources ?? {})) {
        if (!source.source_name || !source.name) {
          continue;
        }

        const tables = sourcesByName.get(source.source_name) ?? [];
        tables.push(source.name);
        sourcesByName.set(source.source_name, dedupeAndSort(tables));
      }

      this.state = {
        refs,
        refTargets,
        refPackages: dedupeAndSort(refPackages),
        refsByPackage,
        sourcesByName
      };
      this.manifestPath = manifestPath;
      this.setStatus(`dbt: ${refs.length} refs, ${parsed.sources ? Object.keys(parsed.sources).length : 0} sources`);
    } catch (error) {
      this.setStatus("dbt: manifest parse failed");
      void vscode.window.showWarningMessage(
        `dbt Auto Complete could not parse ${path.basename(manifestPath)}: ${this.formatError(error)}`
      );
    }
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private setStatus(text: string): void {
    this.statusBar.text = text;
  }

  private isRefableNode(node: {
    name?: string;
    package_name?: string;
    resource_type?: string;
  }): node is { name: string; package_name?: string; resource_type?: string } {
    if (!node.name) {
      return false;
    }

    return node.resource_type === "model" || node.resource_type === "seed" || node.resource_type === "snapshot";
  }
}
