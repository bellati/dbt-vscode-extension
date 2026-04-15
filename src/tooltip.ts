import * as vscode from "vscode";
import { type HoverTarget, type LineageNode, type MacroHoverTarget, type MacroNode } from "./manifestStore";

type TooltipResource = LineageNode;

function describeNodeKind(node: TooltipResource): string {
  if (node.resourceType === "source") {
    return "dbt source";
  }

  return `dbt ${node.resourceType}`;
}

function getHoverIdentifier(node: TooltipResource): string {
  return node.packageName ? `${node.packageName}.${node.displayName}` : node.displayName;
}

function formatDisplayPath(resource: { filePath?: string; originalFilePath?: string }): string | undefined {
  if (resource.filePath) {
    return vscode.workspace.asRelativePath(resource.filePath, false);
  }

  return resource.originalFilePath;
}

function formatMacroLabel(macro: MacroNode): string {
  if (macro.packageName) {
    return `${macro.packageName}.${macro.name}`;
  }

  return macro.name;
}

function appendList(
  tooltip: vscode.MarkdownString,
  label: string,
  values: string[],
  emptyValue: string,
  limit = 5
): void {
  if (values.length === 0) {
    tooltip.appendMarkdown(`- ${label}: ${emptyValue}\n`);
    return;
  }

  const visibleValues = values.slice(0, limit).map((value) => `\`${value}\``);
  const remainingCount = values.length - visibleValues.length;
  const summary = remainingCount > 0 ? `${visibleValues.join(", ")}, +${remainingCount} more` : visibleValues.join(", ");
  tooltip.appendMarkdown(`- ${label}: ${summary}\n`);
}

export function createResourceTooltip(
  target: HoverTarget,
  options?: {
    title?: string;
    directionLabel?: string;
  }
): vscode.MarkdownString {
  const { node, parents, children, macros } = target;
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${options?.title ?? node.displayName}**\n\n`);
  tooltip.appendMarkdown(`- Name: \`${getHoverIdentifier(node)}\`\n`);
  tooltip.appendMarkdown(`- Kind: ${describeNodeKind(node)}\n`);
  if (node.sourceName) {
    tooltip.appendMarkdown(`- Source: \`${node.sourceName}\`\n`);
  }
  if (node.packageName) {
    tooltip.appendMarkdown(`- Package: \`${node.packageName}\`\n`);
  }
  if (node.fullyQualifiedName) {
    tooltip.appendMarkdown(`- FQN: \`${node.fullyQualifiedName}\`\n`);
  }

  const displayPath = formatDisplayPath(node);
  if (displayPath) {
    tooltip.appendMarkdown(`- File: \`${displayPath}\`\n`);
  }

  tooltip.appendMarkdown(`- Unique ID: \`${node.uniqueId}\`\n`);
  if (options?.directionLabel) {
    tooltip.appendMarkdown(`- Direction: ${options.directionLabel}\n`);
  }
  tooltip.appendMarkdown(`- Location: ${node.isLocal ? "Local" : "External"}\n`);
  appendList(
    tooltip,
    "Parents",
    parents.map((parent) => getHoverIdentifier(parent)),
    "None"
  );
  appendList(
    tooltip,
    "Children",
    children.map((child) => getHoverIdentifier(child)),
    "None"
  );
  appendList(
    tooltip,
    "Macros",
    macros.map((macro) => macro.fullyQualifiedName ?? formatMacroLabel(macro)),
    "None"
  );

  return tooltip;
}

export function createMacroTooltip(
  target: MacroHoverTarget,
  options?: {
    title?: string;
  }
): vscode.MarkdownString {
  const { macro } = target;
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${options?.title ?? macro.name}**\n\n`);
  tooltip.appendMarkdown(`- Name: \`${formatMacroLabel(macro)}\`\n`);
  tooltip.appendMarkdown(`- Kind: dbt macro\n`);
  if (macro.packageName) {
    tooltip.appendMarkdown(`- Package: \`${macro.packageName}\`\n`);
  }
  if (macro.fullyQualifiedName) {
    tooltip.appendMarkdown(`- FQN: \`${macro.fullyQualifiedName}\`\n`);
  }

  const displayPath = formatDisplayPath(macro);
  if (displayPath) {
    tooltip.appendMarkdown(`- File: \`${displayPath}\`\n`);
  }

  tooltip.appendMarkdown(`- Unique ID: \`${macro.uniqueId}\`\n`);
  tooltip.appendMarkdown(`- Location: ${macro.isLocal ? "Local" : "External"}\n`);
  return tooltip;
}
