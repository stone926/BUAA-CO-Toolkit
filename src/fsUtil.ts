import * as path from 'path';
import * as vscode from 'vscode';

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
