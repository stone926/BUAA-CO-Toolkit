import { CO_DIR, CO_TMP_DIR } from './constants';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
export { fileMtimeMs, isDirectory, isFile, pathExists, yieldEventLoop } from './nodeFs';

export function workspaceFolderFor(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  if (uri) {
    return vscode.workspace.getWorkspaceFolder(uri);
  }
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    return vscode.workspace.getWorkspaceFolder(editor.document.uri);
  }
  return vscode.workspace.workspaceFolders?.[0];
}

export function workspaceFolderForOrFirst(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return workspaceFolderFor(uri) ?? vscode.workspace.workspaceFolders?.[0];
}

export function workspaceRootFor(uri?: vscode.Uri): string | undefined {
  return workspaceFolderFor(uri)?.uri.fsPath;
}

export function dirname(uri: vscode.Uri): string {
  return path.dirname(uri.fsPath);
}

export function basenameNoExt(uri: vscode.Uri): string {
  return path.basename(uri.fsPath, path.extname(uri.fsPath));
}

export async function ensureDirectory(uri: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(uri);
}

export async function writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
  const bytes = Buffer.from(content, 'utf8');
  await vscode.workspace.fs.writeFile(uri, bytes);
}

export async function readTextFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

export function toUri(file: string): vscode.Uri {
  return vscode.Uri.file(file);
}

/**
 * Return a `.co/tmp/<prefix>XXXXXX` temp directory inside the workspace that
 * owns `resource`. Falls back to `os.tmpdir()` when no workspace is open.
 */
export function coTmpDir(resource: vscode.Uri | undefined, prefix: string): string {
  const folder = resource
    ? vscode.workspace.getWorkspaceFolder(resource)
    : vscode.workspace.workspaceFolders?.[0];
  const base = folder ? path.join(folder.uri.fsPath, CO_TMP_DIR) : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

/**
 * Best-effort cleanup of a directory created by {@link coTmpDir}.
 * Removes `dir`, then removes its parent `.co/tmp/` if it became empty.
 */
export async function cleanupCoTmp(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
  const parent = path.dirname(dir);
  try {
    if (path.basename(parent) === 'tmp' && path.basename(path.dirname(parent)) === CO_DIR) {
      const entries = await fs.promises.readdir(parent);
      if (entries.length === 0) {
        await fs.promises.rm(parent, { recursive: true, force: true });
      }
    }
  } catch {
    // Best-effort cleanup only.
  }
}
