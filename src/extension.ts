import * as vscode from "vscode";
import { LineageTreeProvider } from "./lineageTree";
import { ManifestStore, type RefTarget } from "./manifestStore";

function createCompletionItem(
  label: string,
  detail: string,
  quoteCharacter?: string,
  kind: vscode.CompletionItemKind = vscode.CompletionItemKind.Value
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(label, kind);
  item.detail = detail;
  item.insertText = label;
  item.commitCharacters = quoteCharacter ? [quoteCharacter] : undefined;
  return item;
}

function createRefPackageCompletionItem(packageName: string, quoteCharacter: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(packageName, vscode.CompletionItemKind.Module);
  item.detail = "dbt ref package";
  item.insertText = new vscode.SnippetString(`${packageName}${quoteCharacter}, ${quoteCharacter}$1`);
  return item;
}

function createRefTargetCompletionItem(target: RefTarget, quoteCharacter: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(target.name, vscode.CompletionItemKind.Reference);
  item.detail = target.packageName ? `dbt ref from ${target.packageName}` : "dbt ref";
  item.insertText = target.packageName
    ? new vscode.SnippetString(`${target.packageName}${quoteCharacter}, ${quoteCharacter}${target.name}`)
    : target.name;
  item.filterText = target.name;
  return item;
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
  return (
    isRefContext(prefix) ||
    isRefSecondArgumentContext(prefix) ||
    isSourceNameContext(prefix) ||
    isSourceTableContext(prefix)
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new ManifestStore(context);
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

  const provider = vscode.languages.registerCompletionItemProvider(
    [
      { language: "sql", scheme: "file" },
      { language: "jinja-sql", scheme: "file" }
    ],
    {
      provideCompletionItems(document, position) {
        const prefix = document.lineAt(position.line).text.slice(0, position.character);
        const quoteCharacter = getActiveQuoteCharacter(prefix);

        if (isRefContext(prefix)) {
          return [
            ...store.refPackages.map((packageName) => createRefPackageCompletionItem(packageName, quoteCharacter)),
            ...store.refTargets.map((target) => createRefTargetCompletionItem(target, quoteCharacter))
          ];
        }

        if (isRefSecondArgumentContext(prefix)) {
          const packageName = getRefPackageFromCallPrefix(prefix);
          if (!packageName) {
            return [];
          }

          return store
            .getRefsForPackage(packageName)
            .map((refName) => createCompletionItem(refName, `dbt ref from ${packageName}`, quoteCharacter));
        }

        if (isSourceNameContext(prefix)) {
          return store.sourceNames.map((sourceName) => createCompletionItem(sourceName, "dbt source", quoteCharacter));
        }

        if (isSourceTableContext(prefix)) {
          const sourceName = getSourceNameFromCallPrefix(prefix);
          if (!sourceName) {
            return [];
          }

          return store
            .getTablesForSource(sourceName)
            .map((tableName) => createCompletionItem(tableName, `dbt source table from ${sourceName}`, quoteCharacter));
        }

        return [];
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

    const deletedInsideCompletionContext = event.contentChanges.some((change) => {
      if (change.text !== "" || change.rangeLength === 0) {
        return false;
      }

      const linePrefix = event.document.lineAt(change.range.start.line).text.slice(0, change.range.start.character);
      return isCompletionContext(linePrefix);
    });

    if (!deletedInsideCompletionContext) {
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
