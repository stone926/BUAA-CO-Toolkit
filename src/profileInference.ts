import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProfileResolverFile, ProfileResolverInput } from './profileResolver';
import type { VerilogModuleProvider } from './language/verilog/moduleProvider';

const scanTtlMs = 2000;
const maxProfileFiles = 3000;
const scanCache = new Map<string, { timestamp: number; files: ProfileResolverFile[] }>();

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
    files: folder ? workspaceProfileFiles(folder.uri.fsPath) : activeResource ? [{ path: activeResource.fsPath }] : [],
    modules,
    verilogTexts: modules.map((module) => module.bodyText).filter(Boolean)
  };
}

export function clearProfileInferenceCache(): void {
  scanCache.clear();
}

function workspaceProfileFiles(root: string): ProfileResolverFile[] {
  const cached = scanCache.get(root);
  const now = Date.now();
  if (cached && now - cached.timestamp < scanTtlMs) {
    return cached.files;
  }
  const files = collectProfileFiles(root);
  scanCache.set(root, { timestamp: now, files });
  return files;
}

function collectProfileFiles(root: string): ProfileResolverFile[] {
  const files: ProfileResolverFile[] = [];
  const stack = [root];
  while (stack.length && files.length < maxProfileFiles) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // 无法读取的目录不参与 Profile 推断
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (isProfileRelevantFile(entry.name)) {
        files.push({
          path: fullPath,
          languageId: languageIdForPath(fullPath)
        });
        if (files.length >= maxProfileFiles) {
          break;
        }
      }
    }
  }
  return files;
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
