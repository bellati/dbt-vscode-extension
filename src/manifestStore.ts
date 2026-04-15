import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { execFileAsync, formatError, pathExists } from "./runtimeUtils";

type DbtManifestNode = {
  name?: string;
  package_name?: string;
  resource_type?: string;
  original_file_path?: string;
  path?: string;
  fqn?: string[];
  depends_on?: {
    nodes?: string[];
    macros?: string[];
  };
};

type DbtManifestSource = {
  source_name?: string;
  name?: string;
  package_name?: string;
  original_file_path?: string;
  path?: string;
  fqn?: string[];
  depends_on?: {
    nodes?: string[];
    macros?: string[];
  };
};

type DbtManifestMacro = {
  name?: string;
  package_name?: string;
  original_file_path?: string;
  path?: string;
  fqn?: string[];
};

type DbtManifest = {
  nodes?: Record<string, DbtManifestNode>;
  sources?: Record<string, DbtManifestSource>;
  macros?: Record<string, DbtManifestMacro>;
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
  fullyQualifiedName?: string;
  macroUniqueIds: string[];
  isLocal: boolean;
};

export type MacroNode = {
  uniqueId: string;
  name: string;
  packageName?: string;
  filePath?: string;
  originalFilePath?: string;
  fullyQualifiedName?: string;
  isLocal: boolean;
};

export type HoverTarget = {
  node: LineageNode;
  parents: LineageNode[];
  children: LineageNode[];
  macros: MacroNode[];
};

export type MacroHoverTarget = {
  macro: MacroNode;
};

export type ManifestPickerItem = {
  label: string;
  description: string;
  detail: string;
  filePath: string;
};

type CompletionState = {
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

type DefinitionState = {
  refsByName: Map<string, string[]>;
  refsByPackageAndName: Map<string, string[]>;
  macrosByName: Map<string, string[]>;
  macrosByPackageAndName: Map<string, string[]>;
};

type HoverState = {
  refUniqueIdsByName: Map<string, string[]>;
  refUniqueIdsByPackageAndName: Map<string, string[]>;
  sourceUniqueIdsBySourceAndName: Map<string, string[]>;
  macroUniqueIdsByName: Map<string, string[]>;
  macroUniqueIdsByPackageAndName: Map<string, string[]>;
  macrosByUniqueId: Map<string, MacroNode>;
};

const MANIFEST_VARIANTS = ["target/manifest.json", "target/manifests.json"];
const DBT_PROJECT_FILE_NAME = "dbt_project.yml";

function createScopedDefinitionKey(name: string, packageName?: string): string {
  return `${packageName ?? ""}:${name}`;
}

function addDefinitionPath(index: Map<string, string[]>, key: string, filePath: string): void {
  const existingPaths = index.get(key) ?? [];
  existingPaths.push(filePath);
  index.set(key, dedupeAndSort(existingPaths));
}

function addUniqueId(index: Map<string, string[]>, key: string, uniqueId: string): void {
  const existingUniqueIds = index.get(key) ?? [];
  existingUniqueIds.push(uniqueId);
  index.set(key, dedupeAndSort(existingUniqueIds));
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
    refTargets: [],
    refPackages: [],
    refsByPackage: new Map(),
    sourceTargets: [],
    sourcesByName: new Map()
  };
  private definitionState: DefinitionState = {
    refsByName: new Map(),
    refsByPackageAndName: new Map(),
    macrosByName: new Map(),
    macrosByPackageAndName: new Map()
  };
  private hoverState: HoverState = {
    refUniqueIdsByName: new Map(),
    refUniqueIdsByPackageAndName: new Map(),
    sourceUniqueIdsBySourceAndName: new Map(),
    macroUniqueIdsByName: new Map(),
    macroUniqueIdsByPackageAndName: new Map(),
    macrosByUniqueId: new Map()
  };
  private lineageState: LineageState = {
    nodesByUniqueId: new Map(),
    fileToUniqueId: new Map(),
    parentMap: new Map(),
    childMap: new Map()
  };
  private pickerItems: ManifestPickerItem[] = [];
  private manifestPath?: string;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.name = "Light dbt";
    this.statusBar.command = "dbtAutoComplete.refreshManifest";
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

  public getDefinitionPathsForRef(name: string, packageName?: string): string[] {
    if (packageName) {
      return this.definitionState.refsByPackageAndName.get(createScopedDefinitionKey(name, packageName)) ?? [];
    }

    return this.definitionState.refsByName.get(name) ?? [];
  }

  public getDefinitionPathsForMacro(name: string, packageName?: string): string[] {
    if (packageName) {
      return this.definitionState.macrosByPackageAndName.get(createScopedDefinitionKey(name, packageName)) ?? [];
    }

    return this.definitionState.macrosByName.get(name) ?? [];
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

  public getHoverTargetsForRef(name: string, packageName?: string): HoverTarget[] {
    const uniqueIds = packageName
      ? this.hoverState.refUniqueIdsByPackageAndName.get(createScopedDefinitionKey(name, packageName)) ?? []
      : this.hoverState.refUniqueIdsByName.get(name) ?? [];

    return uniqueIds.map((uniqueId) => this.createHoverTarget(uniqueId)).filter((target): target is HoverTarget => Boolean(target));
  }

  public getHoverTargetsForSource(sourceName: string, name: string): HoverTarget[] {
    const uniqueIds = this.hoverState.sourceUniqueIdsBySourceAndName.get(createScopedDefinitionKey(name, sourceName)) ?? [];
    return uniqueIds.map((uniqueId) => this.createHoverTarget(uniqueId)).filter((target): target is HoverTarget => Boolean(target));
  }

  public getHoverTargetsForMacro(name: string, packageName?: string): MacroHoverTarget[] {
    const uniqueIds = packageName
      ? this.hoverState.macroUniqueIdsByPackageAndName.get(createScopedDefinitionKey(name, packageName)) ?? []
      : this.hoverState.macroUniqueIdsByName.get(name) ?? [];

    return uniqueIds
      .map((uniqueId) => this.hoverState.macrosByUniqueId.get(uniqueId))
      .filter((macro): macro is MacroNode => Boolean(macro))
      .map((macro) => ({ macro }));
  }

  public getHoverTargetForUniqueId(uniqueId: string): HoverTarget | undefined {
    return this.createHoverTarget(uniqueId);
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

  public getManifestPickerItems(): ManifestPickerItem[] {
    return this.pickerItems;
  }

  public async initialize(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.hideStatus();
      return;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    const hasProjectFile = await this.ensureDbtProjectFile(workspaceRoot);
    if (!hasProjectFile) {
      return;
    }

    const dbtAvailable = await this.ensureDbtInstalled();
    if (!dbtAvailable) {
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

    const workspaceRoot = workspaceFolder.uri.fsPath;
    const hasProjectFile = await this.ensureDbtProjectFile(workspaceRoot, true);
    if (!hasProjectFile) {
      return;
    }

    const dbtAvailable = await this.ensureDbtInstalled();
    if (!dbtAvailable) {
      return;
    }

    this.manifestPath = await this.ensureManifest(workspaceRoot, true);
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

  private async ensureDbtProjectFile(workspaceRoot: string, showWarning = false): Promise<boolean> {
    const projectFilePath = path.join(workspaceRoot, DBT_PROJECT_FILE_NAME);
    if (await pathExists(projectFilePath)) {
      return true;
    }

    this.clearState();
    this.manifestPath = undefined;
    this.hideStatus();
    if (showWarning) {
      void vscode.window.showWarningMessage(
        `Light dbt requires ${DBT_PROJECT_FILE_NAME} in the workspace root before it can refresh the manifest.`
      );
    }

    return false;
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
      if (!forceRefresh && (await pathExists(candidate))) {
        return candidate;
      }
    }

    this.setStatus("dbt: generating manifest");

    try {
      await execFileAsync("dbt", ["parse"], workspaceRoot);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Light dbt could not generate a manifest with "dbt parse": ${formatError(error)}`
      );
      this.setStatus("dbt: parse failed");
      return undefined;
    }

    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
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
      for (const target of refTargets) {
        if (!target.packageName) {
          continue;
        }

        refPackages.add(target.packageName);
        const packageRefs = refsByPackage.get(target.packageName) ?? [];
        packageRefs.push(target.name);
        refsByPackage.set(target.packageName, dedupeAndSort(packageRefs));
      }

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
        refTargets,
        refPackages: dedupeAndSort(refPackages),
        refsByPackage,
        sourceTargets,
        sourcesByName
      };
      this.definitionState = await this.buildDefinitionState(parsed, workspaceRoot);
      this.lineageState = await this.buildLineageState(parsed, workspaceRoot);
      this.hoverState = await this.buildHoverState(parsed, workspaceRoot);
      this.pickerItems = this.buildPickerItems();
      this.setStatus(
        `dbt: ${refTargets.length} refs, ${parsed.sources ? Object.keys(parsed.sources).length : 0} sources`
      );
      this.onDidChangeEmitter.fire();
    } catch (error) {
      this.clearState();
      this.setStatus("dbt: manifest parse failed");
      void vscode.window.showWarningMessage(
        `Light dbt could not parse ${path.basename(manifestPath)}: ${formatError(error)}`
      );
    }
  }

  private async buildDefinitionState(parsed: DbtManifest, workspaceRoot?: string): Promise<DefinitionState> {
    const refsByName = new Map<string, string[]>();
    const refsByPackageAndName = new Map<string, string[]>();
    const macrosByName = new Map<string, string[]>();
    const macrosByPackageAndName = new Map<string, string[]>();

    for (const node of Object.values(parsed.nodes ?? {})) {
      if (!this.isRefableNode(node)) {
        continue;
      }

      const resolvedFilePath = await this.resolveLocalPath(workspaceRoot, node.original_file_path ?? node.path);
      if (!resolvedFilePath) {
        continue;
      }

      addDefinitionPath(refsByName, node.name, resolvedFilePath);
      addDefinitionPath(
        refsByPackageAndName,
        createScopedDefinitionKey(node.name, node.package_name),
        resolvedFilePath
      );
    }

    for (const macro of Object.values(parsed.macros ?? {})) {
      if (!macro.name) {
        continue;
      }

      const resolvedFilePath = await this.resolveLocalPath(workspaceRoot, macro.original_file_path ?? macro.path);
      if (!resolvedFilePath) {
        continue;
      }

      addDefinitionPath(macrosByName, macro.name, resolvedFilePath);
      addDefinitionPath(
        macrosByPackageAndName,
        createScopedDefinitionKey(macro.name, macro.package_name),
        resolvedFilePath
      );
    }

    return {
      refsByName,
      refsByPackageAndName,
      macrosByName,
      macrosByPackageAndName
    };
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
        fullyQualifiedName: node.fqn?.join("."),
        macroUniqueIds: dedupeAndSort(node.depends_on?.macros ?? []),
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
        originalFilePath: source.original_file_path ?? source.path,
        fullyQualifiedName: source.fqn?.join("."),
        macroUniqueIds: dedupeAndSort(source.depends_on?.macros ?? []),
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

  private async buildHoverState(parsed: DbtManifest, workspaceRoot?: string): Promise<HoverState> {
    const refUniqueIdsByName = new Map<string, string[]>();
    const refUniqueIdsByPackageAndName = new Map<string, string[]>();
    const sourceUniqueIdsBySourceAndName = new Map<string, string[]>();
    const macroUniqueIdsByName = new Map<string, string[]>();
    const macroUniqueIdsByPackageAndName = new Map<string, string[]>();
    const macrosByUniqueId = new Map<string, MacroNode>();

    for (const [uniqueId, node] of Object.entries(parsed.nodes ?? {})) {
      if (!this.isRefableNode(node)) {
        continue;
      }

      addUniqueId(refUniqueIdsByName, node.name, uniqueId);
      addUniqueId(refUniqueIdsByPackageAndName, createScopedDefinitionKey(node.name, node.package_name), uniqueId);
    }

    for (const [uniqueId, source] of Object.entries(parsed.sources ?? {})) {
      if (!source.source_name || !source.name) {
        continue;
      }

      addUniqueId(sourceUniqueIdsBySourceAndName, createScopedDefinitionKey(source.name, source.source_name), uniqueId);
    }

    for (const [uniqueId, macro] of Object.entries(parsed.macros ?? {})) {
      if (!macro.name) {
        continue;
      }

      addUniqueId(macroUniqueIdsByName, macro.name, uniqueId);
      addUniqueId(macroUniqueIdsByPackageAndName, createScopedDefinitionKey(macro.name, macro.package_name), uniqueId);
      const resolvedFilePath = await this.resolveLocalPath(workspaceRoot, macro.original_file_path ?? macro.path);
      macrosByUniqueId.set(uniqueId, {
        uniqueId,
        name: macro.name,
        packageName: macro.package_name,
        filePath: resolvedFilePath,
        originalFilePath: macro.original_file_path ?? macro.path,
        fullyQualifiedName: macro.fqn?.join("."),
        isLocal: Boolean(resolvedFilePath)
      });
    }

    return {
      refUniqueIdsByName,
      refUniqueIdsByPackageAndName,
      sourceUniqueIdsBySourceAndName,
      macroUniqueIdsByName,
      macroUniqueIdsByPackageAndName,
      macrosByUniqueId
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

    if (!(await pathExists(absolutePath))) {
      return undefined;
    }

    return absolutePath;
  }

  private clearState(): void {
    this.completionState = {
      refTargets: [],
      refPackages: [],
      refsByPackage: new Map(),
      sourceTargets: [],
      sourcesByName: new Map()
    };
    this.definitionState = {
      refsByName: new Map(),
      refsByPackageAndName: new Map(),
      macrosByName: new Map(),
      macrosByPackageAndName: new Map()
    };
    this.hoverState = {
      refUniqueIdsByName: new Map(),
      refUniqueIdsByPackageAndName: new Map(),
      sourceUniqueIdsBySourceAndName: new Map(),
      macroUniqueIdsByName: new Map(),
      macroUniqueIdsByPackageAndName: new Map(),
      macrosByUniqueId: new Map()
    };
    this.lineageState = {
      nodesByUniqueId: new Map(),
      fileToUniqueId: new Map(),
      parentMap: new Map(),
      childMap: new Map()
    };
    this.pickerItems = [];
    this.onDidChangeEmitter.fire();
  }

  private setStatus(text: string): void {
    this.statusBar.text = text;
    this.statusBar.show();
  }

  private hideStatus(): void {
    this.statusBar.hide();
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

  private createHoverTarget(uniqueId: string): HoverTarget | undefined {
    const node = this.getLineageNode(uniqueId);
    if (!node) {
      return undefined;
    }

    const parents = this.getLineageParents(uniqueId)
      .map((parentUniqueId) => this.getLineageNode(parentUniqueId))
      .filter((parent): parent is LineageNode => Boolean(parent));
    const children = this.getLineageChildren(uniqueId)
      .map((childUniqueId) => this.getLineageNode(childUniqueId))
      .filter((child): child is LineageNode => Boolean(child));
    const macros = node.macroUniqueIds
      .map((macroUniqueId) => this.hoverState.macrosByUniqueId.get(macroUniqueId))
      .filter((macro): macro is MacroNode => Boolean(macro));

    return {
      node,
      parents,
      children,
      macros
    };
  }

  private buildPickerItems(): ManifestPickerItem[] {
    const lineageItems = [...this.lineageState.nodesByUniqueId.values()]
      .filter((node) => Boolean(node.filePath))
      .map((node) => ({
        label: node.displayName,
        description: node.resourceType,
        detail: [node.packageName, node.fullyQualifiedName, node.originalFilePath].filter(Boolean).join(" • "),
        filePath: node.filePath as string
      }));

    const macroItems = [...this.hoverState.macrosByUniqueId.values()]
      .filter((macro) => Boolean(macro.filePath))
      .map((macro) => ({
        label: macro.name,
        description: "macro",
        detail: [macro.packageName, macro.fullyQualifiedName, macro.originalFilePath].filter(Boolean).join(" • "),
        filePath: macro.filePath as string
      }));

    return [...lineageItems, ...macroItems].sort((left, right) => {
      const labelOrder = left.label.localeCompare(right.label);
      if (labelOrder !== 0) {
        return labelOrder;
      }

      const descriptionOrder = left.description.localeCompare(right.description);
      if (descriptionOrder !== 0) {
        return descriptionOrder;
      }

      return left.detail.localeCompare(right.detail);
    });
  }
}
