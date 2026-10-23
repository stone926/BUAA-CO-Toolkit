// @index verilog-external-syntax-project — 为外部 Verilog 编译器发现并确定性排序工作区源码
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceFolder } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { CO_DIR } from '../../constants';
import { yieldEventLoop } from '../../nodeFs';
import { orderVerilogProjectFiles } from '../../verilog/verilogProjectOrder';
import { isUserTestbenchPath } from '../../verilogSimulationFiles';
import { VerilogProjectContext, VerilogProjects } from './projectContext';

export interface ExternalSyntaxProject {
  root: string;
  sources: string[];
}

export async function resolveExternalSyntaxProject(
  workspaceFolders: WorkspaceFolder[] | null | undefined,
  triggerUri: string,
  limit = 5000,
  projects: VerilogProjects = {}
): Promise<ExternalSyntaxProject | undefined> {
  const root = workspaceRootFor(workspaceFolders, triggerUri);
  if (!root) {
    return undefined;
  }
  const context = new VerilogProjectContext([URI.file(root).toString()], projects);
  if (!context.hasUniqueProject(triggerUri)) {
    throw new Error('当前文件属于多个 Verilog 源集合；请从目标工程的入口文件执行检查。');
  }
  const discovered = await scanProjectFiles(context.sourcePaths(triggerUri) ?? [root], limit);
  const sources = orderVerilogProjectFiles(
    discovered.filter((file) => context.sharesProject(triggerUri, URI.file(file).toString())).map((fsPath) => ({ fsPath })),
    userTestbenchTrigger(root, triggerUri)
  ).map((file) => file.fsPath);
  return { root, sources };
}

/**
 * Discovery skips `.co`, but a saved `.co/tb` testbench should still be checked
 * together with the project modules it instantiates, after all of them.
 */
function userTestbenchTrigger(root: string, triggerUri: string): Array<{ fsPath: string }> {
  const triggerPath = fsPathFromUri(triggerUri);
  return triggerPath && triggerPath.toLowerCase().endsWith('.v') && isUserTestbenchPath(root, triggerPath)
    ? [{ fsPath: triggerPath }]
    : [];
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

async function scanProjectFiles(roots: string[], limit: number): Promise<string[]> {
  const verilogFiles: string[] = [];
  const stack = [...roots];
  const seen = new Set<string>();
  while (stack.length && verilogFiles.length < limit) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (seen.has(current)) continue;
    seen.add(current);
    let entries: fs.Dirent[];
    try {
      const stat = await fs.promises.stat(current);
      if (stat.isFile()) {
        if (current.toLowerCase().endsWith('.v')) verilogFiles.push(current);
        continue;
      }
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
      }
    }
    await yieldEventLoop();
  }
  return verilogFiles;
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
