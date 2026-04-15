import * as path from "node:path";
import * as vscode from "vscode";
import { ManifestStore } from "./manifestStore";
import { execFileAsync, formatError, pathExists } from "./runtimeUtils";

const DBT_PROJECT_FILE_NAME = "dbt_project.yml";

export class CompiledModelService {
  public constructor(private readonly store: ManifestStore) {}

  public async openCompiledModelForFile(filePath: string, forceRecompile = false): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      void vscode.window.showWarningMessage("Open a dbt project folder to view a compiled model.");
      return;
    }

    const node = this.store.getModelForFile(filePath);
    if (!node) {
      void vscode.window.showWarningMessage("The active file is not a dbt model from the manifest.");
      return;
    }

    if (!node.originalFilePath || !node.packageName) {
      void vscode.window.showWarningMessage("The manifest does not include enough information to locate the compiled model.");
      return;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    if (!(await this.hasDbtProjectFile(workspaceRoot))) {
      return;
    }

    if (!(await this.isDbtInstalled(workspaceRoot))) {
      return;
    }

    const compiledPath = path.join(workspaceRoot, "target", "compiled", node.packageName, node.originalFilePath);
    if (forceRecompile || !(await pathExists(compiledPath))) {
      try {
        await this.compileModel(workspaceRoot, node.displayName, node.originalFilePath, forceRecompile);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Light dbt could not compile ${node.displayName}: ${formatError(error)}`
        );
        return;
      }

      if (!(await pathExists(compiledPath))) {
        void vscode.window.showWarningMessage(
          `dbt compiled ${node.displayName}, but no compiled SQL was found at ${path.relative(workspaceRoot, compiledPath)}.`
        );
        return;
      }
    }

    const document = await vscode.workspace.openTextDocument(compiledPath);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async compileModel(
    workspaceRoot: string,
    displayName: string,
    originalFilePath: string,
    forceRecompile: boolean
  ): Promise<void> {
    const title = forceRecompile
      ? `Light dbt: Recompiling ${displayName}`
      : `Light dbt: Compiling ${displayName}`;
    const statusMessage = forceRecompile
      ? `Light dbt: recompiling ${displayName}...`
      : `Light dbt: compiling ${displayName}...`;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false
      },
      async () => {
        const statusBarMessage = vscode.window.setStatusBarMessage(statusMessage);
        try {
          await execFileAsync("dbt", ["compile", "--select", `path:${originalFilePath}`], workspaceRoot);
        } finally {
          statusBarMessage.dispose();
        }
      }
    );
  }

  private async isDbtInstalled(cwd: string): Promise<boolean> {
    try {
      await execFileAsync("dbt", ["--version"], cwd);
      return true;
    } catch {
      void vscode.window.showErrorMessage(
        "Light dbt requires the dbt CLI to be installed and available on PATH."
      );
      return false;
    }
  }

  private async hasDbtProjectFile(workspaceRoot: string): Promise<boolean> {
    const projectFilePath = path.join(workspaceRoot, DBT_PROJECT_FILE_NAME);
    if (await pathExists(projectFilePath)) {
      return true;
    }

    void vscode.window.showWarningMessage(
      `Light dbt requires ${DBT_PROJECT_FILE_NAME} in the workspace root before it can compile models.`
    );
    return false;
  }

}
