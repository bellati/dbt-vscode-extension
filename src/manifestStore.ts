import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import * as vscode from "vscode";

type DbtManifestNode = {
  name?: string;
  package_name?: string;
  resource_type?: string;
  original_file_path?: string;
  path?: string;
};

type DbtManifestSource = {
  source_name?: string;
  name?: string;
  package_name?: string;
  original_file_path?: string;
  path?: string;
};

type DbtManifest = {
  nodes?: Record<string, DbtManifestNode>;
  sources?: Record<string, DbtManifestSource>;
  parent_map?: Record<string, string[]>;
  child_map?: Record<string, string[]>;
};

export type RefTarget = {
  name: string;
  packageName?: string;
};

export type SourceTarget = {
  sourceName: string;
  name: string;
  packageName?: string;
};

export type LineageDirection = "upstream" | "downstream";

export type LineageNode = {
  uniqueId: string;
  displayName: string;
  packageName?: string;
  resourceType: "model" | "seed" | "snapshot" | "source";
  sourceName?: string;
  filePath?: string;
  originalFilePath?: string;
  isLocal: boolean;
};

type CompletionState = {
  refs: string[];
  refTargets: RefTarget[];
  refPackages: string[];
  refsByPackage: Map<string, string[]>;
  sourceTargets: SourceTarget[];
  sourcesByName: Map<string, string[]>;
};

type LineageState = {
  nodesByUniqueId: Map<string, LineageNode>;
  fileToUniqueId: Map<string, string>;
  parentMap: Map<string, string[]>;
  childMap: Map<string, string[]>;
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

function normalizePathCase(filePath: string): string {
  return path.normalize(filePath);
}

function mapToSortedArrays(input: Record<string, string[] | undefined>): Map<string, string[]> {
  const mapped = new Map<string, string[]>();
  for (const [key, values] of Object.entries(input)) {
    mapped.set(key, dedupeAndSort(values ?? []));
  }

  return mapped;
}

export class ManifestStore implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private completionState: CompletionState = {
    refs: [],
    refTargets: [],
    refPackages: [],
    refsByPackage: new Map(),
    sourceTargets: [],
    sourcesByName: new Map()
  };
  private lineageState: LineageState = {
    nodesByUniqueId: new Map(),
    fileToUniqueId: new Map(),
    parentMap: new Map(),
    childMap: new Map()
  };
  private manifestPath?: string;
  private dbtAvailable = false;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.name = "Light dbt";
    this.statusBar.command = "dbtAutoComplete.refreshManifest";
    this.statusBar.show();
  }

  public dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }

    this.onDidChangeEmitter.dispose();
    this.statusBar.dispose();
  }

  public get onDidChange(): vscode.Event<void> {
    return this.onDidChangeEmitter.event;
  }

  public get refs(): string[] {
    return this.completionState.refs;
  }

  public get sourceNames(): string[] {
    return dedupeAndSort(this.completionState.sourcesByName.keys());
  }

  public get sourceTargets(): SourceTarget[] {
    return this.completionState.sourceTargets;
  }

  public get refTargets(): RefTarget[] {
    return this.completionState.refTargets;
  }

  public get refPackages(): string[] {
    return this.completionState.refPackages;
  }

  public getRefsForPackage(packageName: string): string[] {
    return this.completionState.refsByPackage.get(packageName) ?? [];
  }

  public getTablesForSource(sourceName: string): string[] {
    return this.completionState.sourcesByName.get(sourceName) ?? [];
  }

  public getLineageNode(uniqueId: string): LineageNode | undefined {
    return this.lineageState.nodesByUniqueId.get(uniqueId);
  }

  public getLineageParents(uniqueId: string): string[] {
    return this.lineageState.parentMap.get(uniqueId) ?? [];
  }

  public getLineageChildren(uniqueId: string): string[] {
    return this.lineageState.childMap.get(uniqueId) ?? [];
  }

  public getUniqueIdForFile(filePath: string): string | undefined {
    return this.lineageState.fileToUniqueId.get(normalizePathCase(filePath));
  }

  public getModelForFile(filePath: string): LineageNode | undefined {
    const uniqueId = this.getUniqueIdForFile(filePath);
    if (!uniqueId) {
      return undefined;
    }

    const node = this.getLineageNode(uniqueId);
    if (!node || node.resourceType !== "model") {
      return undefined;
    }

    return node;
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
        "Light dbt requires the dbt CLI to be installed and available on PATH."
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
        this.clearState();
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

    const candidates = dedupeAndSort([configuredRelativePath, ...MANIFEST_VARIANTS]).map((relativePath) =>
      path.join(workspaceRoot, relativePath)
    );

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
        `Light dbt could not generate a manifest with "dbt parse": ${this.formatError(error)}`
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
      "Light dbt ran \"dbt parse\" but no manifest.json or manifests.json file was found."
    );
    return undefined;
  }

  private async reloadManifest(manifestPath: string): Promise<void> {
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as DbtManifest;
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

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
      const sourceTargets = Object.values(parsed.sources ?? {})
        .filter((source): source is DbtManifestSource & { source_name: string; name: string } =>
          Boolean(source.source_name && source.name)
        )
        .map((source) => ({
          sourceName: source.source_name,
          name: source.name,
          packageName: source.package_name
        }))
        .sort((left, right) => {
          const nameOrder = left.name.localeCompare(right.name);
          if (nameOrder !== 0) {
            return nameOrder;
          }

          const sourceOrder = left.sourceName.localeCompare(right.sourceName);
          if (sourceOrder !== 0) {
            return sourceOrder;
          }

          return (left.packageName ?? "").localeCompare(right.packageName ?? "");
        });

      for (const source of sourceTargets) {
        const tables = sourcesByName.get(source.sourceName) ?? [];
        tables.push(source.name);
        sourcesByName.set(source.sourceName, dedupeAndSort(tables));
      }

      this.completionState = {
        refs,
        refTargets,
        refPackages: dedupeAndSort(refPackages),
        refsByPackage,
        sourceTargets,
        sourcesByName
      };
      this.lineageState = await this.buildLineageState(parsed, workspaceRoot);
      this.manifestPath = manifestPath;
      this.setStatus(`dbt: ${refs.length} refs, ${parsed.sources ? Object.keys(parsed.sources).length : 0} sources`);
      this.onDidChangeEmitter.fire();
    } catch (error) {
      this.clearState();
      this.setStatus("dbt: manifest parse failed");
      void vscode.window.showWarningMessage(
        `Light dbt could not parse ${path.basename(manifestPath)}: ${this.formatError(error)}`
      );
    }
  }

  private async buildLineageState(parsed: DbtManifest, workspaceRoot?: string): Promise<LineageState> {
    const nodesByUniqueId = new Map<string, LineageNode>();
    const fileToUniqueId = new Map<string, string>();

    for (const [uniqueId, node] of Object.entries(parsed.nodes ?? {})) {
      if (!this.isRefableNode(node)) {
        continue;
      }

      const resolvedFilePath = await this.resolveLocalPath(workspaceRoot, node.original_file_path ?? node.path);
      const resourceType = node.resource_type;
      const lineageNode: LineageNode = {
        uniqueId,
        displayName: node.name,
        packageName: node.package_name,
        resourceType,
        filePath: resolvedFilePath,
        originalFilePath: node.original_file_path ?? node.path,
        isLocal: Boolean(resolvedFilePath)
      };
      nodesByUniqueId.set(uniqueId, lineageNode);
      if (resolvedFilePath) {
        fileToUniqueId.set(normalizePathCase(resolvedFilePath), uniqueId);
      }
    }

    for (const [uniqueId, source] of Object.entries(parsed.sources ?? {})) {
      if (!source.source_name || !source.name) {
        continue;
      }

      const resolvedFilePath = await this.resolveLocalPath(workspaceRoot, source.original_file_path ?? source.path);
      const lineageNode: LineageNode = {
        uniqueId,
        displayName: `${source.source_name}.${source.name}`,
        packageName: source.package_name,
        resourceType: "source",
        sourceName: source.source_name,
        filePath: resolvedFilePath,
        isLocal: Boolean(resolvedFilePath)
      };
      nodesByUniqueId.set(uniqueId, lineageNode);
      if (resolvedFilePath) {
        fileToUniqueId.set(normalizePathCase(resolvedFilePath), uniqueId);
      }
    }

    return {
      nodesByUniqueId,
      fileToUniqueId,
      parentMap: mapToSortedArrays(parsed.parent_map ?? {}),
      childMap: mapToSortedArrays(parsed.child_map ?? {})
    };
  }

  private async resolveLocalPath(
    workspaceRoot: string | undefined,
    relativePath: string | undefined
  ): Promise<string | undefined> {
    if (!workspaceRoot || !relativePath) {
      return undefined;
    }

    const absolutePath = path.resolve(workspaceRoot, relativePath);
    const relativeToWorkspace = path.relative(workspaceRoot, absolutePath);
    if (relativeToWorkspace.startsWith("..") || path.isAbsolute(relativeToWorkspace)) {
      return undefined;
    }

    if (!(await this.pathExists(absolutePath))) {
      return undefined;
    }

    return absolutePath;
  }

  private clearState(): void {
    this.completionState = {
      refs: [],
      refTargets: [],
      refPackages: [],
      refsByPackage: new Map(),
      sourceTargets: [],
      sourcesByName: new Map()
    };
    this.lineageState = {
      nodesByUniqueId: new Map(),
      fileToUniqueId: new Map(),
      parentMap: new Map(),
      childMap: new Map()
    };
    this.onDidChangeEmitter.fire();
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

  private isRefableNode(node: DbtManifestNode): node is DbtManifestNode & {
    name: string;
    resource_type: "model" | "seed" | "snapshot";
  } {
    if (!node.name || !node.resource_type) {
      return false;
    }

    return node.resource_type === "model" || node.resource_type === "seed" || node.resource_type === "snapshot";
  }
}
