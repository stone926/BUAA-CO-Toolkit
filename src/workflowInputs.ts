import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getMachineCode } from './config';
import { workspaceFolderFor } from './fsUtil';

export interface ResolveWorkspaceFileOptions {
  title: string;
  include: string;
  exclude?: string;
  maxResults?: number;
  filters: Record<string, string[]>;
  activeFile?: (uri: vscode.Uri) => boolean;
  saveActive?: boolean;
}

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

export async function resolveWorkspaceFile(options: ResolveWorkspaceFileOptions): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme === 'file' && options.activeFile?.(editor.document.uri)) {
    if (options.saveActive && editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }

  const files = await vscode.workspace.findFiles(options.include, options.exclude, options.maxResults ?? 200);
  if (files.length === 1) {
    return files[0];
  }
  if (files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      })),
      {
        title: options.title,
        matchOnDescription: true
      }
    );
    return picked?.uri;
  }

  return await pickOneFile(options.title, options.filters);
}

export async function resolveWorkspaceFiles(options: ResolveWorkspaceFileOptions): Promise<vscode.Uri[]> {
  const files = await vscode.workspace.findFiles(options.include, options.exclude, options.maxResults ?? 500);
  if (files.length) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      })),
      {
        title: options.title,
        matchOnDescription: true,
        canPickMany: true
      }
    );
    return picked?.map((item) => item.uri) ?? [];
  }

  const picked = await vscode.window.showOpenDialog({
    title: options.title,
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    filters: options.filters
  });
  return picked ?? [];
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
