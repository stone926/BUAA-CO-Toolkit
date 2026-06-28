import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getMachineCode } from './config';
import { workspaceFolderFor } from './fsUtil';
import { normalizePathKey } from './pathUtils';

export interface ResolveWorkspaceFileOptions {
  title: string;
  include: string;
  exclude?: string;
  maxResults?: number;
  filters: Record<string, string[]>;
  activeFile?: (uri: vscode.Uri) => boolean;
  saveActive?: boolean;
}

export interface ResolveActiveFileOptions {
  predicate?: (uri: vscode.Uri) => boolean | Promise<boolean>;
  saveDirty?: boolean;
}

export interface WorkspaceFileCandidate {
  uri: vscode.Uri;
  rank: number;
}

export interface FindWorkspaceFileCandidatesOptions {
  folder?: vscode.WorkspaceFolder;
  include?: string;
  exclude?: string;
  maxResults?: number;
  candidatePaths?: string[];
  predicate?: (uri: vscode.Uri) => boolean | Promise<boolean>;
  rank?: (uri: vscode.Uri) => number | Promise<number>;
}

export interface ResolveFileInputOptions extends FindWorkspaceFileCandidatesOptions {
  title: string;
  filters: Record<string, string[]>;
  active?: ResolveActiveFileOptions | false;
  pick?: 'auto-one' | 'best' | 'quickPick';
  fallbackOpenDialog?: boolean;
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
  return await resolveFileInput({
    title: options.title,
    include: options.include,
    exclude: options.exclude,
    maxResults: options.maxResults,
    filters: options.filters,
    active: options.activeFile ? {
      predicate: options.activeFile,
      saveDirty: options.saveActive
    } : false
  });
}

export async function resolveWorkspaceFiles(options: ResolveWorkspaceFileOptions): Promise<vscode.Uri[]> {
  const candidates = await findWorkspaceFileCandidates({
    include: options.include,
    exclude: options.exclude,
    maxResults: options.maxResults ?? 500
  });
  if (candidates.length) {
    const picked = await vscode.window.showQuickPick(
      candidates.map((candidate) => ({
        label: vscode.workspace.asRelativePath(candidate.uri),
        description: path.dirname(candidate.uri.fsPath),
        uri: candidate.uri
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

export async function resolveActiveFile(options: ResolveActiveFileOptions = {}): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return undefined;
  }
  if (options.predicate && !await options.predicate(editor.document.uri)) {
    return undefined;
  }
  if (options.saveDirty && editor.document.isDirty) {
    await editor.document.save();
  }
  return editor.document.uri;
}

export async function findWorkspaceFileCandidates(options: FindWorkspaceFileCandidatesOptions): Promise<WorkspaceFileCandidate[]> {
  const seen = new Set<string>();
  const uris: vscode.Uri[] = [];
  const add = async (uri: vscode.Uri): Promise<void> => {
    if (uri.scheme !== 'file') {
      return;
    }
    const key = normalizePathKey(uri.fsPath);
    if (seen.has(key)) {
      return;
    }
    if (options.predicate && !await options.predicate(uri)) {
      return;
    }
    seen.add(key);
    uris.push(uri);
  };

  for (const candidatePath of options.candidatePaths ?? []) {
    if (!candidatePath || !fs.existsSync(candidatePath)) {
      continue;
    }
    await add(vscode.Uri.file(candidatePath));
  }

  if (options.include) {
    const pattern = options.folder
      ? new vscode.RelativePattern(options.folder, options.include)
      : options.include;
    const found = await vscode.workspace.findFiles(pattern, options.exclude, options.maxResults ?? 200);
    for (const uri of found) {
      await add(uri);
    }
  }

  const ranked = await Promise.all(uris.map(async (uri) => ({
    uri,
    rank: options.rank ? await options.rank(uri) : 0
  })));
  return ranked.sort((left, right) => left.rank - right.rank || left.uri.fsPath.localeCompare(right.uri.fsPath));
}

export async function resolveFileInput(options: ResolveFileInputOptions): Promise<vscode.Uri | undefined> {
  if (options.active !== false) {
    const active = await resolveActiveFile(options.active ?? {});
    if (active) {
      return active;
    }
  }

  const candidates = await findWorkspaceFileCandidates(options);
  const pick = options.pick ?? 'auto-one';
  if (candidates.length && pick === 'best') {
    return candidates[0].uri;
  }
  if (candidates.length === 1 && pick === 'auto-one') {
    return candidates[0].uri;
  }
  if (candidates.length) {
    const picked = await vscode.window.showQuickPick(
      candidates.map((candidate) => ({
        label: vscode.workspace.asRelativePath(candidate.uri),
        description: path.dirname(candidate.uri.fsPath),
        uri: candidate.uri
      })),
      {
        title: options.title,
        matchOnDescription: true
      }
    );
    return picked?.uri;
  }

  return options.fallbackOpenDialog === false ? undefined : await pickOneFile(options.title, options.filters);
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
