import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getMachineCode } from './config';
import { workspaceFolderFor } from './fsUtil';

export async function resolveMachineCodeInput(title = 'Select MARS HexText machine code file'): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file' && path.basename(editor.document.uri.fsPath).toLowerCase() === getMachineCode(editor.document.uri).toLowerCase()) {
    return editor.document.uri;
  }
  const base = editor?.document.uri.scheme === 'file'
    ? path.dirname(editor.document.uri.fsPath)
    : workspaceFolderFor()?.uri.fsPath;
  if (base) {
    const candidate = path.join(base, getMachineCode(editor?.document.uri));
    if (fs.existsSync(candidate)) {
      return vscode.Uri.file(candidate);
    }
  }
  return await pickOneFile(title, {
    Code: ['txt'],
    All: ['*']
  });
}

export async function resolveActiveOrPickedTextFile(title: string): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    return editor.document.uri;
  }
  return await pickOneFile(title, {
    Text: ['txt', 'log'],
    All: ['*']
  });
}

export async function pickOneFile(title: string, filters: Record<string, string[]>): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title,
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters
  });
  return picked?.[0];
}
