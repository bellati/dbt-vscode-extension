import * as path from "node:path";
import * as vscode from "vscode";
import { ManifestStore, type LineageDirection, type LineageNode } from "./manifestStore";

type TreeItemKind = "root" | "branch" | "node" | "placeholder" | "message";

type LineageBranchTreeItem = {
  kind: "branch";
  direction: LineageDirection;
  label: string;
  items: MaterializedBranchNode[];
  truncated: boolean;
};

type LineageNodeTreeItem = {
  kind: "node";
  direction: LineageDirection;
  lineageNode: LineageNode;
  children: MaterializedBranchNode[];
  truncated: boolean;
};

type PlaceholderTreeItem = {
  kind: "placeholder";
  label: string;
};

type MessageTreeItem = {
  kind: "message";
  label: string;
};

type RootTreeItem = {
  kind: "root";
  lineageNode: LineageNode;
};

type MaterializedBranchNode = {
  kind: TreeItemKind;
  label?: string;
  direction?: LineageDirection;
  lineageNode?: LineageNode;
  children?: MaterializedBranchNode[];
  truncated?: boolean;
};

type TreeItemElement = RootTreeItem | LineageBranchTreeItem | LineageNodeTreeItem | PlaceholderTreeItem | MessageTreeItem;

type MaterializedBranch = {
  items: MaterializedBranchNode[];
  truncatedByNodeLimit: boolean;
};

type TraversalState = {
  remainingNodes: number;
};

type LineageSettings = {
  maxNodes: number;
};

function clampSetting(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}

function describeNodeKind(node: LineageNode): string {
  if (node.resourceType === "source") {
    return "dbt source";
  }

  return `dbt ${node.resourceType}`;
}

function createPathKey(ancestors: Iterable<string>): Set<string> {
  return new Set(ancestors);
}

function countMaterializedNodes(items: MaterializedBranchNode[]): number {
  let count = 0;
  for (const item of items) {
    if (item.kind !== "node") {
      continue;
    }

    count += 1;
    count += countMaterializedNodes(item.children ?? []);
  }

  return count;
}

function getDirectionGlyph(direction: LineageDirection): string {
  return direction === "upstream" ? "↑" : "↓";
}

function getNodeGlyph(node: LineageNode): string {
  if (node.resourceType === "source") {
    return "◌";
  }

  return node.isLocal ? "●" : "○";
}

function createDescription(
  node: LineageNode,
  direction: LineageDirection,
  rootPackageName?: string
): string {
  if (node.packageName && node.packageName !== rootPackageName) {
    return `${getDirectionGlyph(direction)} ${node.packageName}`;
  }

  return getDirectionGlyph(direction);
}

function getHoverIdentifier(node: LineageNode): string {
  return node.packageName ? `${node.packageName}.${node.displayName}` : node.displayName;
}

export class LineageTreeProvider implements vscode.TreeDataProvider<TreeItemElement> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeItemElement | undefined>();
  private rootNode?: LineageNode;
  private readonly treeView: vscode.TreeView<TreeItemElement>;

  public constructor(private readonly store: ManifestStore) {
    this.treeView = vscode.window.createTreeView("dbtAutoComplete.lineage", {
      treeDataProvider: this,
      showCollapseAll: true
    });
  }

  public dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
    this.treeView.dispose();
  }

  public get onDidChangeTreeData(): vscode.Event<TreeItemElement | undefined> {
    return this.onDidChangeTreeDataEmitter.event;
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public async revealActiveEditor(forceReveal = false): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const nextRoot = editor ? this.store.getModelForFile(editor.document.uri.fsPath) : undefined;
    this.rootNode = nextRoot;
    this.refresh();

    if (forceReveal) {
      await vscode.commands.executeCommand("workbench.view.extension.dbtAutoComplete");
    }
  }

  public getTreeItem(element: TreeItemElement): vscode.TreeItem {
    switch (element.kind) {
      case "root":
        return this.createNodeTreeItem(
          element.lineageNode,
          "Lineage root",
          vscode.TreeItemCollapsibleState.Expanded,
          true,
          true
        );
      case "branch": {
        const item = new vscode.TreeItem(
          element.label,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.contextValue = `lineage-branch-${element.direction}`;
        item.description = element.direction === "upstream" ? "dependencies" : "dependents";
        item.iconPath = new vscode.ThemeIcon(
          element.direction === "upstream" ? "arrow-up" : "arrow-down"
        );
        return item;
      }
      case "node":
        return this.createNodeTreeItem(
          element.lineageNode,
          element.direction === "upstream" ? "Upstream lineage" : "Downstream lineage",
          element.children.length > 0 || element.truncated ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
          false,
          element.children.length > 0 || element.truncated
        );
      case "placeholder": {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "lineage-placeholder";
        item.iconPath = new vscode.ThemeIcon("ellipsis");
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "lineage-message";
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }
    }
  }

  public async getChildren(element?: TreeItemElement): Promise<TreeItemElement[]> {
    if (!element) {
      if (!this.rootNode) {
        return [{ kind: "message", label: "Open a dbt model file to view lineage." }];
      }

      return [{ kind: "root", lineageNode: this.rootNode }];
    }

    if (element.kind === "message" || element.kind === "placeholder") {
      return [];
    }

    if (element.kind === "root") {
      const rootNode = element.lineageNode;
      const settings = this.getSettings();
      const traversalState: TraversalState = { remainingNodes: settings.maxNodes };
      const upstreamBranch = this.materializeBranch(rootNode, "upstream", traversalState);
      const downstreamBranch = this.materializeBranch(rootNode, "downstream", traversalState);
      return [
        {
          kind: "branch",
          direction: "upstream",
          label: `Upstream (${countMaterializedNodes(upstreamBranch.items)})`,
          items: upstreamBranch.items,
          truncated: upstreamBranch.truncatedByNodeLimit
        },
        {
          kind: "branch",
          direction: "downstream",
          label: `Downstream (${countMaterializedNodes(downstreamBranch.items)})`,
          items: downstreamBranch.items,
          truncated: downstreamBranch.truncatedByNodeLimit
        }
      ];
    }

    if (element.kind === "branch") {
      return this.toTreeItems(element.items, element.direction, element.truncated);
    }

    if (element.kind === "node") {
      return this.toTreeItems(element.children, element.direction, element.truncated);
    }

    return [];
  }

  private createNodeTreeItem(
    node: LineageNode,
    directionLabel: string,
    collapsibleState = vscode.TreeItemCollapsibleState.None,
    isRoot = false,
    hasChildren = false
  ): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `${isRoot ? "◎" : getNodeGlyph(node)} ${node.displayName}`,
      hasChildren ? collapsibleState : vscode.TreeItemCollapsibleState.None
    );

    item.contextValue = node.resourceType === "source" ? "lineage-source" : "lineage-node";
    item.description = isRoot
      ? undefined
      : createDescription(
          node,
          directionLabel === "Upstream lineage" ? "upstream" : "downstream",
          this.rootNode?.packageName
        );
    item.tooltip = this.createTooltip(node, directionLabel);
    if (node.filePath) {
      item.command = {
        command: "vscode.open",
        title: "Open dbt file",
        arguments: [vscode.Uri.file(node.filePath)]
      };
    }

    return item;
  }

  private createTooltip(node: LineageNode, directionLabel: string): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${node.displayName}**\n\n`);
    tooltip.appendMarkdown(`- Name: \`${getHoverIdentifier(node)}\`\n`);
    tooltip.appendMarkdown(`- Kind: ${describeNodeKind(node)}\n`);
    if (node.sourceName) {
      tooltip.appendMarkdown(`- Source: ${node.sourceName}\n`);
    }
    if (node.packageName) {
      tooltip.appendMarkdown(`- Package: ${node.packageName}\n`);
    }
    tooltip.appendMarkdown(`- Unique ID: \`${node.uniqueId}\`\n`);
    tooltip.appendMarkdown(`- Direction: ${directionLabel}\n`);
    tooltip.appendMarkdown(`- Location: ${node.isLocal ? "Local" : "External"}\n`);
    if (node.filePath) {
      tooltip.appendMarkdown(`- File: \`${path.basename(node.filePath)}\`\n`);
    }

    return tooltip;
  }

  private getSettings(): LineageSettings {
    const config = vscode.workspace.getConfiguration("dbtAutoComplete.lineage");
    return {
      maxNodes: clampSetting(config.get<number>("maxNodes"), 30)
    };
  }

  private materializeBranch(
    rootNode: LineageNode,
    direction: LineageDirection,
    traversalState: TraversalState
  ): MaterializedBranch {
    return this.materializeNodeChildren(rootNode, direction, traversalState, createPathKey([rootNode.uniqueId]));
  }

  private materializeNodeChildren(
    node: LineageNode,
    direction: LineageDirection,
    traversalState: TraversalState,
    ancestorPath: Set<string>
  ): MaterializedBranch {
    const adjacentUniqueIds =
      direction === "upstream" ? this.store.getLineageParents(node.uniqueId) : this.store.getLineageChildren(node.uniqueId);
    const candidates = adjacentUniqueIds
      .map((uniqueId) => this.store.getLineageNode(uniqueId))
      .filter((candidate): candidate is LineageNode => Boolean(candidate))
      .filter((candidate) => direction === "upstream" || candidate.resourceType !== "source");

    if (candidates.length === 0) {
      return { items: [], truncatedByNodeLimit: false };
    }

    const items: MaterializedBranchNode[] = [];
    let truncatedByNodeLimit = false;

    for (const candidate of candidates) {
      if (ancestorPath.has(candidate.uniqueId)) {
        continue;
      }

      if (traversalState.remainingNodes <= 0) {
        truncatedByNodeLimit = true;
        break;
      }

      traversalState.remainingNodes -= 1;
      const nextAncestors = createPathKey(ancestorPath);
      nextAncestors.add(candidate.uniqueId);
      const childBranch =
        candidate.resourceType === "source"
          ? { items: [], truncatedByNodeLimit: false }
          : this.materializeNodeChildren(candidate, direction, traversalState, nextAncestors);
      items.push({
        kind: "node",
        direction,
        lineageNode: candidate,
        children: childBranch.items,
        truncated: childBranch.truncatedByNodeLimit
      });
      truncatedByNodeLimit = truncatedByNodeLimit || childBranch.truncatedByNodeLimit;
    }

    return { items, truncatedByNodeLimit };
  }

  private toTreeItems(
    items: MaterializedBranchNode[],
    direction: LineageDirection,
    truncated: boolean
  ): TreeItemElement[] {
    const treeItems = items.map((item) => this.toTreeItemElement(item, direction));
    if (truncated) {
      treeItems.push({ kind: "placeholder", label: "… more nodes not shown" });
    }

    return treeItems;
  }

  private toTreeItemElement(item: MaterializedBranchNode, direction: LineageDirection): TreeItemElement {
    if (item.kind !== "node" || !item.lineageNode) {
      return { kind: "placeholder", label: item.label ?? "… more nodes not shown" };
    }

    return {
      kind: "node",
      direction,
      lineageNode: item.lineageNode,
      children: item.children ?? [],
      truncated: Boolean(item.truncated)
    };
  }
}
