import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { ManifestStore } from "./manifestStore";

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
    if (!(await this.isDbtInstalled(workspaceRoot))) {
      return;
    }

    const compiledPath = path.join(workspaceRoot, "target", "compiled", node.packageName, node.originalFilePath);
    if (forceRecompile || !(await this.pathExists(compiledPath))) {
      try {
        await this.compileModel(workspaceRoot, node.displayName, node.originalFilePath, forceRecompile);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `dbt Auto Complete could not compile ${node.displayName}: ${this.formatError(error)}`
        );
        return;
      }

      if (!(await this.pathExists(compiledPath))) {
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
      ? `dbt Auto Complete: Recompiling ${displayName}`
      : `dbt Auto Complete: Compiling ${displayName}`;
    const statusMessage = forceRecompile
      ? `dbt Auto Complete: recompiling ${displayName}...`
      : `dbt Auto Complete: compiling ${displayName}...`;

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
        "dbt Auto Complete requires the dbt CLI to be installed and available on PATH."
      );
      return false;
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
}
