import * as vscode from "vscode";
import { CompiledModelService } from "./compiledModelService";
import { LineageTreeProvider } from "./lineageTree";
import { ManifestStore, type RefTarget, type SourceTarget } from "./manifestStore";

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
  detailPrefix: string,
  quoteCharacter: string
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
    resolveItems(prefix, quoteCharacter, store) {
      const packageName = getRefPackageFromCallPrefix(prefix);
      if (!packageName) {
        return [];
      }

      return store
        .getRefsForPackage(packageName)
        .map((refName) => createScopedNameCompletionOption(refName, packageName, "dbt ref from", quoteCharacter));
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
    resolveItems(prefix, quoteCharacter, store) {
      const sourceName = getSourceNameFromCallPrefix(prefix);
      if (!sourceName) {
        return [];
      }

      return store
        .getTablesForSource(sourceName)
        .map((tableName) =>
          createScopedNameCompletionOption(tableName, sourceName, "dbt source table from", quoteCharacter)
        );
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
    provider,
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
