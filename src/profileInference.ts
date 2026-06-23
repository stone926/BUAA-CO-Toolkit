import * as path from 'path';
import * as vscode from 'vscode';
import { ProfileResolverFile, ProfileResolverInput } from './profileResolver';
import type { VerilogModuleProvider } from './language/verilog/moduleProvider';

const scanTtlMs = 30000;
const maxProfileFiles = 3000;
const profileFileExcludeGlob = '**/{.git,.co,.vscode,.vscode-test,node_modules,out,dist,build,coverage}/**';
const scanCache = new Map<string, { timestamp: number; files: ProfileResolverFile[]; pending?: Promise<void> }>();
const onDidChangeEmitter = new vscode.EventEmitter<void>();
let scanGeneration = 0;

export const onDidChangeProfileInferenceCache = onDidChangeEmitter.event;

export function buildProfileInferenceInput(
  resource: vscode.Uri | undefined,
  moduleRegistry: VerilogModuleProvider
): Omit<ProfileResolverInput, 'configuredProfile' | 'configuredSource' | 'topModule'> {
  const activeResource = resource ?? currentTextDocument()?.uri;
  const activeDocument = documentFor(activeResource);
  const folder = workspaceFolderFor(activeResource);
  const modules = moduleRegistry.allModules();
  return {
    activeLanguageId: activeDocument?.languageId ?? languageIdForPath(activeResource?.fsPath),
    activeFilePath: activeResource?.fsPath,
    files: folder ? workspaceProfileFiles(folder.uri.fsPath, activeResource) : activeResource ? profileFileForUri(activeResource) : [],
    modules,
    verilogTexts: modules.map((module) => module.bodyText).filter(Boolean)
  };
}

export function clearProfileInferenceCache(): void {
  scanCache.clear();
  scanGeneration++;
}

function workspaceProfileFiles(root: string, activeResource?: vscode.Uri): ProfileResolverFile[] {
  const cached = scanCache.get(root);
  const now = Date.now();
  if (cached && now - cached.timestamp < scanTtlMs) {
    return withActiveProfileFile(cached.files, activeResource);
  }
  const entry = cached ?? {
    timestamp: 0,
    files: visibleProfileFiles(root, activeResource)
  };
  if (!cached) {
    scanCache.set(root, entry);
  }
  scheduleProfileFileScan(root, entry);
  return withActiveProfileFile(entry.files, activeResource);
}

function scheduleProfileFileScan(
  root: string,
  entry: { timestamp: number; files: ProfileResolverFile[]; pending?: Promise<void> }
): void {
  if (entry.pending) {
    return;
  }
  const generation = scanGeneration;
  entry.pending = scanWorkspaceProfileFiles(root)
    .then((files) => {
      if (generation !== scanGeneration || scanCache.get(root) !== entry) {
        return;
      }
      entry.files = files;
      entry.timestamp = Date.now();
      onDidChangeEmitter.fire();
    })
    .finally(() => {
      if (scanCache.get(root) === entry) {
        entry.pending = undefined;
      }
    });
}

async function scanWorkspaceProfileFiles(root: string): Promise<ProfileResolverFile[]> {
  const result: ProfileResolverFile[] = [];
  const append = (uri: vscode.Uri): void => {
    if (result.length >= maxProfileFiles || shouldSkipPath(uri.fsPath)) {
      return;
    }
    const file = profileFileForUri(uri);
    if (file.length) {
      result.push(file[0]);
    }
  };

  try {
    const sourceFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, '**/*.{v,asm,s,mips,circ}'),
      profileFileExcludeGlob,
      maxProfileFiles
    );
    sourceFiles.forEach(append);
    if (result.length < maxProfileFiles) {
      const codeFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, '**/code.txt'),
        profileFileExcludeGlob,
        maxProfileFiles - result.length
      );
      codeFiles.forEach(append);
    }
  } catch {
    // Workspace file search can fail on virtual or partially unavailable folders.
  }
  return dedupeProfileFiles(result);
}

function visibleProfileFiles(root: string, activeResource?: vscode.Uri): ProfileResolverFile[] {
  const files = vscode.workspace.textDocuments
    .filter((document) => document.uri.scheme === 'file')
    .filter((document) => isInsideDirectory(document.uri.fsPath, root))
    .flatMap((document) => profileFileForUri(document.uri, document.languageId));
  return withActiveProfileFile(files, activeResource);
}

function withActiveProfileFile(files: ProfileResolverFile[], activeResource?: vscode.Uri): ProfileResolverFile[] {
  return dedupeProfileFiles([
    ...files,
    ...(activeResource ? profileFileForUri(activeResource) : [])
  ]);
}

function profileFileForUri(uri: vscode.Uri, languageId = languageIdForPath(uri.fsPath)): ProfileResolverFile[] {
  if (uri.scheme !== 'file' || !isProfileRelevantFile(path.basename(uri.fsPath))) {
    return [];
  }
  return [{
    path: uri.fsPath,
    languageId
  }];
}

function dedupeProfileFiles(files: ProfileResolverFile[]): ProfileResolverFile[] {
  const seen = new Set<string>();
  const result: ProfileResolverFile[] = [];
  for (const file of files) {
    const key = normalizePathKey(file.path);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(file);
    }
  }
  return result;
}

function currentTextDocument(): vscode.TextDocument | undefined {
  const active = vscode.window.activeTextEditor?.document;
  if (active?.uri.scheme === 'file') {
    return active;
  }
  return vscode.window.visibleTextEditors
    .map((editor) => editor.document)
    .find((document) => document.uri.scheme === 'file') ?? active;
}

function documentFor(uri: vscode.Uri | undefined): vscode.TextDocument | undefined {
  if (!uri) {
    return currentTextDocument();
  }
  const active = vscode.window.activeTextEditor?.document;
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
    ?? (active?.uri.toString() === uri.toString() ? active : undefined);
}

function workspaceFolderFor(resource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  if (resource) {
    return vscode.workspace.getWorkspaceFolder(resource) ?? vscode.workspace.workspaceFolders?.[0];
  }
  return vscode.workspace.workspaceFolders?.[0];
}

function languageIdForPath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.v')) {
    return 'verilog';
  }
  if (/\.(asm|s|mips)$/.test(lower)) {
    return 'mipsasm';
  }
  if (lower.endsWith('.circ')) {
    return 'logisim-circ';
  }
  return undefined;
}

function isProfileRelevantFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.v')
    || lower.endsWith('.asm')
    || lower.endsWith('.s')
    || lower.endsWith('.mips')
    || lower.endsWith('.circ')
    || lower === 'code.txt';
}

function shouldSkipDirectory(name: string): boolean {
  return name === '.git'
    || name === '.co'
    || name === '.vscode'
    || name === '.vscode-test'
    || name === 'node_modules'
    || name === 'out'
    || name === 'dist'
    || name === 'build'
    || name === 'coverage';
}

function shouldSkipPath(filePath: string): boolean {
  return filePath.split(/[\\/]+/).some(shouldSkipDirectory);
}

function isInsideDirectory(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePathKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}
