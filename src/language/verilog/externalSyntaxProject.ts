// @index verilog-external-syntax-project — 为外部 Verilog 编译器发现并确定性排序工作区源码
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceFolder } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { CO_DIR } from '../../constants';
import { yieldEventLoop } from '../../nodeFs';
import { orderIseProjectFiles, parseXiseVerilogFileOrder } from '../../verilog/iseProjectOrder';

export interface ExternalSyntaxProject {
  root: string;
  sources: string[];
}

export async function resolveExternalSyntaxProject(
  workspaceFolders: WorkspaceFolder[] | null | undefined,
  triggerUri: string,
  limit = 5000
): Promise<ExternalSyntaxProject | undefined> {
  const root = workspaceRootFor(workspaceFolders, triggerUri);
  if (!root) {
    return undefined;
  }
  const discovered = await scanProjectFiles(root, limit);
  let xiseFileOrder: string[] = [];
  if (discovered.xiseFiles.length === 1) {
    try {
      const xiseText = await fs.promises.readFile(discovered.xiseFiles[0], 'utf8');
      xiseFileOrder = parseXiseVerilogFileOrder(xiseText, discovered.xiseFiles[0]);
    } catch {
      // An unreadable XISE file uses the same stable fallback as a project
      // without a unique XISE file.
    }
  }
  const sources = orderIseProjectFiles(
    discovered.verilogFiles.map((fsPath) => ({ fsPath })),
    xiseFileOrder
  ).map((file) => file.fsPath);
  return { root, sources };
}

export function workspaceRootFor(
  workspaceFolders: WorkspaceFolder[] | null | undefined,
  triggerUri: string
): string | undefined {
  const triggerPath = fsPathFromUri(triggerUri);
  const matching = workspaceFolders
    ?.map((folder) => fsPathFromUri(folder.uri))
    .filter((folder): folder is string => Boolean(folder))
    .sort((left, right) => right.length - left.length)
    .find((folder) => triggerPath ? isInsideDirectory(triggerPath, folder) : true);
  return matching ?? (triggerPath ? path.dirname(triggerPath) : undefined);
}

interface ScannedProjectFiles {
  verilogFiles: string[];
  xiseFiles: string[];
}

async function scanProjectFiles(root: string, limit: number): Promise<ScannedProjectFiles> {
  const verilogFiles: string[] = [];
  const xiseFiles: string[] = [];
  const stack = [root];
  while (stack.length && verilogFiles.length < limit) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
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
      const lowerName = entry.name.toLowerCase();
      if (lowerName.endsWith('.v')) {
        verilogFiles.push(fullPath);
        if (verilogFiles.length >= limit) {
          break;
        }
      } else if (lowerName.endsWith('.xise') && xiseFiles.length < 2) {
        xiseFiles.push(fullPath);
      }
    }
    await yieldEventLoop();
  }
  return { verilogFiles, xiseFiles };
}

function shouldSkipDirectory(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === '.git' ||
    normalized === CO_DIR.toLowerCase() ||
    normalized === '.vscode' ||
    normalized === '.vscode-test' ||
    normalized === 'node_modules' ||
    normalized === 'out' ||
    normalized === 'dist' ||
    normalized === 'build' ||
    normalized === 'coverage';
}

function fsPathFromUri(uri: string): string | undefined {
  try {
    return URI.parse(uri).fsPath;
  } catch {
    return undefined;
  }
}

function isInsideDirectory(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
