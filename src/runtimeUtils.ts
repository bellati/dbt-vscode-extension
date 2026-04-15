import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";

export function execFileAsync(command: string, args: string[], cwd: string): Promise<void> {
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

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
