import * as vscode from "vscode";
import { CompiledModelService } from "./compiledModelService";
import { LineageTreeProvider } from "./lineageTree";
import {
  ManifestStore,
  type HoverTarget,
  type MacroHoverTarget,
  type ManifestPickerItem,
  type RefTarget,
  type SourceTarget
} from "./manifestStore";
import { createMacroTooltip, createResourceTooltip } from "./tooltip";

type CompletionInsertText = string | vscode.SnippetString;

type CompletionOption = {
  label: string;
  detail: string;
  insertText: CompletionInsertText;
  filterText?: string;
  kind?: vscode.CompletionItemKind;
  scopeHint?: string;
};

type CompletionContextResolver = {
  matches(prefix: string): boolean;
  resolveItems(prefix: string, quoteCharacter: string, store: ManifestStore): CompletionOption[];
};

function createCompletionItem(option: CompletionOption, quoteCharacter?: string): vscode.CompletionItem {
  const { label, detail, insertText, filterText, kind = vscode.CompletionItemKind.Value, scopeHint } = option;
  const item = new vscode.CompletionItem({ label, description: scopeHint }, kind);
  item.detail = detail;
  item.insertText = insertText;
  item.filterText = filterText;
  item.commitCharacters = quoteCharacter ? [quoteCharacter] : undefined;
  return item;
}

function createPackageCompletionOption(
  packageName: string,
  quoteCharacter: string,
  detail: string
): CompletionOption {
  return {
    label: packageName,
    detail,
    insertText: new vscode.SnippetString(`${packageName}${quoteCharacter}, ${quoteCharacter}$1`),
    kind: vscode.CompletionItemKind.Module,
    scopeHint: "package"
  };
}

function createScopedTargetCompletionOption(
  name: string,
  scopeName: string | undefined,
  quoteCharacter: string,
  detailWithoutScope: string,
  detailWithScope: string
): CompletionOption {
  return {
    label: name,
    detail: scopeName ? `${detailWithScope} ${scopeName}` : detailWithoutScope,
    insertText: scopeName ? new vscode.SnippetString(`${scopeName}${quoteCharacter}, ${quoteCharacter}${name}`) : name,
    filterText: name,
    kind: vscode.CompletionItemKind.Reference,
    scopeHint: scopeName
  };
}

function createRefTargetCompletionOption(target: RefTarget, quoteCharacter: string): CompletionOption {
  return createScopedTargetCompletionOption(target.name, target.packageName, quoteCharacter, "dbt ref", "dbt ref from");
}

function createSourceTargetCompletionOption(target: SourceTarget, quoteCharacter: string): CompletionOption {
  return createScopedTargetCompletionOption(
    target.name,
    target.sourceName,
    quoteCharacter,
    "dbt source table",
    "dbt source table from"
  );
}

function createScopedNameCompletionOption(
  name: string,
  scopeName: string,
  detailPrefix: string
): CompletionOption {
  return {
    label: name,
    detail: `${detailPrefix} ${scopeName}`,
    insertText: name,
    kind: vscode.CompletionItemKind.Value,
    scopeHint: scopeName
  };
}

function getActiveQuoteCharacter(prefix: string): string {
  const singleQuote = prefix.lastIndexOf("'");
  const doubleQuote = prefix.lastIndexOf("\"");
  return singleQuote > doubleQuote ? "'" : "\"";
}

function getSourceNameFromCallPrefix(prefix: string): string | undefined {
  const match = prefix.match(/source\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]*$/);
  return match?.[1];
}

function getRefPackageFromCallPrefix(prefix: string): string | undefined {
  const match = prefix.match(/ref\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]*$/);
  return match?.[1];
}

function isRefContext(prefix: string): boolean {
  return /ref\s*\(\s*['"][^'"]*$/.test(prefix);
}

function isRefSecondArgumentContext(prefix: string): boolean {
  return /ref\s*\(\s*['"][^'"]+['"]\s*,\s*['"][^'"]*$/.test(prefix);
}

function isSourceNameContext(prefix: string): boolean {
  return /source\s*\(\s*['"][^'"]*$/.test(prefix);
}

function isSourceTableContext(prefix: string): boolean {
  return /source\s*\(\s*['"][^'"]+['"]\s*,\s*['"][^'"]*$/.test(prefix);
}

function isCompletionContext(prefix: string): boolean {
  return COMPLETION_CONTEXT_RESOLVERS.some((resolver) => resolver.matches(prefix));
}

type CallArgument = {
  value: string;
  range: vscode.Range;
};

function getCallArguments(lineText: string, lineNumber: number, callName: string): CallArgument[][] {
  const matches: CallArgument[][] = [];
  const callPattern = new RegExp(`${callName}\\s*\\(([^)]*)\\)`, "g");
  let callMatch = callPattern.exec(lineText);

  while (callMatch) {
    const fullMatch = callMatch[0];
    const rawArguments = callMatch[1];
    const argumentsStartOffset = callMatch.index + fullMatch.indexOf(rawArguments);
    const argumentsForCall: CallArgument[] = [];
    const argumentPattern = /(['"])([^'"]*)\1/g;
    let argumentMatch = argumentPattern.exec(rawArguments);

    while (argumentMatch) {
      const value = argumentMatch[2];
      const startCharacter = argumentsStartOffset + argumentMatch.index + 1;
      const endCharacter = startCharacter + value.length;
      argumentsForCall.push({
        value,
        range: new vscode.Range(lineNumber, startCharacter, lineNumber, endCharacter)
      });
      argumentMatch = argumentPattern.exec(rawArguments);
    }

    matches.push(argumentsForCall);
    callMatch = callPattern.exec(lineText);
  }

  return matches;
}

function containsPosition(range: vscode.Range, position: vscode.Position): boolean {
  return range.start.isBeforeOrEqual(position) && range.end.isAfterOrEqual(position);
}

function createDefinitionLocations(filePaths: string[]): vscode.Location[] {
  return filePaths.map((filePath) => new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(0, 0)));
}

function createManifestQuickPickItem(item: ManifestPickerItem): vscode.QuickPickItem & { filePath: string } {
  return {
    label: item.label,
    description: item.description,
    detail: item.detail,
    filePath: item.filePath
  };
}

function createHoverForTargets(kind: "ref" | "source", targets: HoverTarget[]): vscode.Hover | undefined {
  if (targets.length === 0) {
    return undefined;
  }

  const markdownBlocks = targets.map((target, index) =>
    createResourceTooltip(target, {
      title: targets.length > 1 ? `${kind} target ${index + 1}` : target.node.displayName
    }).value
  );

  return new vscode.Hover(markdownBlocks.map((value) => new vscode.MarkdownString(value, true)));
}

function createMacroHover(targets: MacroHoverTarget[]): vscode.Hover | undefined {
  if (targets.length === 0) {
    return undefined;
  }

  const markdownBlocks = targets.map((target, index) =>
    createMacroTooltip(target, {
      title: targets.length > 1 ? `macro target ${index + 1}` : target.macro.name
    }).value
  );

  return new vscode.Hover(markdownBlocks.map((value) => new vscode.MarkdownString(value, true)));
}

function getRefHoverAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  store: ManifestStore
): vscode.Hover | undefined {
  const lineText = document.lineAt(position.line).text;
  const refCalls = getCallArguments(lineText, position.line, "ref");

  for (const args of refCalls) {
    if (args.length === 1 && containsPosition(args[0].range, position)) {
      return createHoverForTargets("ref", store.getHoverTargetsForRef(args[0].value));
    }

    if (args.length >= 2 && (containsPosition(args[0].range, position) || containsPosition(args[1].range, position))) {
      return createHoverForTargets("ref", store.getHoverTargetsForRef(args[1].value, args[0].value));
    }
  }

  return undefined;
}

function getSourceHoverAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  store: ManifestStore
): vscode.Hover | undefined {
  const lineText = document.lineAt(position.line).text;
  const sourceCalls = getCallArguments(lineText, position.line, "source");

  for (const args of sourceCalls) {
    if (
      args.length >= 2 &&
      (containsPosition(args[0].range, position) || containsPosition(args[1].range, position))
    ) {
      return createHoverForTargets("source", store.getHoverTargetsForSource(args[0].value, args[1].value));
    }
  }

  return undefined;
}

function getMacroHoverAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  store: ManifestStore
): vscode.Hover | undefined {
  const lineText = document.lineAt(position.line).text;
  const macroCallPattern = /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)\s*\(/g;
  let macroCallMatch = macroCallPattern.exec(lineText);

  while (macroCallMatch) {
    const identifier = macroCallMatch[1];
    const startCharacter = macroCallMatch.index;
    const endCharacter = startCharacter + identifier.length;
    const range = new vscode.Range(position.line, startCharacter, position.line, endCharacter);

    if (containsPosition(range, position)) {
      const [packageName, name] = identifier.includes(".")
        ? (identifier.split(".", 2) as [string, string])
        : [undefined, identifier];
      return createMacroHover(store.getHoverTargetsForMacro(name, packageName));
    }

    macroCallMatch = macroCallPattern.exec(lineText);
  }

  return undefined;
}

function getRefDefinitionsAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  store: ManifestStore
): vscode.Location[] {
  const lineText = document.lineAt(position.line).text;
  const refCalls = getCallArguments(lineText, position.line, "ref");

  for (const args of refCalls) {
    if (args.length === 1 && containsPosition(args[0].range, position)) {
      return createDefinitionLocations(store.getDefinitionPathsForRef(args[0].value));
    }

    if (args.length >= 2 && containsPosition(args[1].range, position)) {
      return createDefinitionLocations(store.getDefinitionPathsForRef(args[1].value, args[0].value));
    }
  }

  return [];
}

function getMacroDefinitionsAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  store: ManifestStore
): vscode.Location[] {
  const lineText = document.lineAt(position.line).text;
  const macroCallPattern = /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)\s*\(/g;
  let macroCallMatch = macroCallPattern.exec(lineText);

  while (macroCallMatch) {
    const identifier = macroCallMatch[1];
    const startCharacter = macroCallMatch.index;
    const endCharacter = startCharacter + identifier.length;
    const range = new vscode.Range(position.line, startCharacter, position.line, endCharacter);

    if (containsPosition(range, position)) {
      const [packageName, name] = identifier.includes(".")
        ? (identifier.split(".", 2) as [string, string])
        : [undefined, identifier];
      return createDefinitionLocations(store.getDefinitionPathsForMacro(name, packageName));
    }

    macroCallMatch = macroCallPattern.exec(lineText);
  }

  return [];
}

function shouldTriggerSuggestForChange(change: vscode.TextDocumentContentChangeEvent, document: vscode.TextDocument): boolean {
  const prefix = document.lineAt(change.range.start.line).text.slice(0, change.range.start.character + change.text.length);
  if (isCompletionContext(prefix)) {
    return true;
  }

  if (change.rangeLength > 0) {
    const replacementPrefix = document.lineAt(change.range.start.line).text.slice(0, change.range.start.character);
    return isCompletionContext(replacementPrefix);
  }

  return false;
}

const COMPLETION_CONTEXT_RESOLVERS: CompletionContextResolver[] = [
  {
    matches: isRefContext,
    resolveItems(_prefix, quoteCharacter, store) {
      return [
        ...store.refPackages.map((packageName) =>
          createPackageCompletionOption(packageName, quoteCharacter, "dbt ref package")
        ),
        ...store.refTargets.map((target) => createRefTargetCompletionOption(target, quoteCharacter))
      ];
    }
  },
  {
    matches: isRefSecondArgumentContext,
    resolveItems(prefix, _quoteCharacter, store) {
      const packageName = getRefPackageFromCallPrefix(prefix);
      if (!packageName) {
        return [];
      }

      return store
        .getRefsForPackage(packageName)
        .map((refName) => createScopedNameCompletionOption(refName, packageName, "dbt ref from"));
    }
  },
  {
    matches: isSourceNameContext,
    resolveItems(_prefix, quoteCharacter, store) {
      return store.sourceTargets.map((target) => createSourceTargetCompletionOption(target, quoteCharacter));
    }
  },
  {
    matches: isSourceTableContext,
    resolveItems(prefix, _quoteCharacter, store) {
      const sourceName = getSourceNameFromCallPrefix(prefix);
      if (!sourceName) {
        return [];
      }

      return store
        .getTablesForSource(sourceName)
        .map((tableName) => createScopedNameCompletionOption(tableName, sourceName, "dbt source table from"));
    }
  }
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new ManifestStore(context);
  const compiledModelService = new CompiledModelService(store);
  const lineageTreeProvider = new LineageTreeProvider(store);
  context.subscriptions.push(store);
  context.subscriptions.push(lineageTreeProvider);

  const refreshCommand = vscode.commands.registerCommand("dbtAutoComplete.refreshManifest", async () => {
    await store.refresh();
  });
  const refreshLineageCommand = vscode.commands.registerCommand("dbtAutoComplete.refreshLineage", async () => {
    await store.refresh();
    await lineageTreeProvider.revealActiveEditor();
  });
  const showLineageCommand = vscode.commands.registerCommand("dbtAutoComplete.showLineage", async () => {
    await lineageTreeProvider.revealActiveEditor(true);
  });
  const showCompiledModelCommand = vscode.commands.registerCommand("dbtAutoComplete.showCompiledModel", async () => {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      void vscode.window.showWarningMessage("Open a dbt model file to view its compiled SQL.");
      return;
    }

    await compiledModelService.openCompiledModelForFile(activeEditor.document.uri.fsPath);
  });
  const recompileAndShowModelCommand = vscode.commands.registerCommand(
    "dbtAutoComplete.recompileAndShowModel",
    async () => {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        void vscode.window.showWarningMessage("Open a dbt model file to recompile and view its compiled SQL.");
        return;
      }

      await compiledModelService.openCompiledModelForFile(activeEditor.document.uri.fsPath, true);
    }
  );
  const showManifestPickerCommand = vscode.commands.registerCommand("dbtAutoComplete.showManifestPicker", async () => {
    const items = store.getManifestPickerItems();
    if (items.length === 0) {
      void vscode.window.showWarningMessage("Light dbt manifest entries are unavailable. Refresh the manifest and try again.");
      return;
    }

    const selection = await vscode.window.showQuickPick(items.map(createManifestQuickPickItem), {
      title: "Light dbt: Picker",
      placeHolder: "Search models, sources, seeds, snapshots, and macros",
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (!selection) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(selection.filePath);
    await vscode.window.showTextDocument(document, { preview: false });
  });

  const provider = vscode.languages.registerCompletionItemProvider(
    [
      { language: "sql", scheme: "file" },
      { language: "jinja-sql", scheme: "file" }
    ],
    {
      provideCompletionItems(document, position) {
        const prefix = document.lineAt(position.line).text.slice(0, position.character);
        const quoteCharacter = getActiveQuoteCharacter(prefix);
        const resolver = COMPLETION_CONTEXT_RESOLVERS.find((candidate) => candidate.matches(prefix));
        if (!resolver) {
          return [];
        }

        return resolver.resolveItems(prefix, quoteCharacter, store).map((option) => createCompletionItem(option, quoteCharacter));
      }
    },
    "'",
    "\""
  );

  const definitionProvider = vscode.languages.registerDefinitionProvider(
    [
      { language: "sql", scheme: "file" },
      { language: "jinja-sql", scheme: "file" }
    ],
    {
      provideDefinition(document, position) {
        const refDefinitions = getRefDefinitionsAtPosition(document, position, store);
        if (refDefinitions.length > 0) {
          return refDefinitions;
        }

        const macroDefinitions = getMacroDefinitionsAtPosition(document, position, store);
        if (macroDefinitions.length > 0) {
          return macroDefinitions;
        }

        return undefined;
      }
    }
  );

  const hoverProvider = vscode.languages.registerHoverProvider(
    [
      { language: "sql", scheme: "file" },
      { language: "jinja-sql", scheme: "file" }
    ],
    {
      provideHover(document, position) {
        const refHover = getRefHoverAtPosition(document, position, store);
        if (refHover) {
          return refHover;
        }

        const sourceHover = getSourceHoverAtPosition(document, position, store);
        if (sourceHover) {
          return sourceHover;
        }

        return getMacroHoverAtPosition(document, position, store);
      }
    }
  );

  const triggerSuggestOnDelete = vscode.workspace.onDidChangeTextDocument((event) => {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || activeEditor.document.uri.toString() !== event.document.uri.toString()) {
      return;
    }

    const changedInsideCompletionContext = event.contentChanges.some((change) => {
      if (change.text.includes("\n") || change.range.start.line !== change.range.end.line) {
        return false;
      }

      return shouldTriggerSuggestForChange(change, event.document);
    });

    if (!changedInsideCompletionContext) {
      return;
    }

    void vscode.commands.executeCommand("editor.action.triggerSuggest");
  });

  const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => {
    void lineageTreeProvider.revealActiveEditor();
  });
  const manifestListener = store.onDidChange(() => {
    void lineageTreeProvider.revealActiveEditor();
  });
  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("dbtAutoComplete.lineage.maxNodes")) {
      lineageTreeProvider.refresh();
    }
  });

  context.subscriptions.push(
    refreshCommand,
    refreshLineageCommand,
    showLineageCommand,
    showCompiledModelCommand,
    recompileAndShowModelCommand,
    showManifestPickerCommand,
    provider,
    definitionProvider,
    hoverProvider,
    triggerSuggestOnDelete,
    activeEditorListener,
    manifestListener,
    configListener
  );
  await store.initialize();
  await lineageTreeProvider.revealActiveEditor();
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered during activation.
}
