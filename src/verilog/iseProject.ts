// @index verilog-ise-project — ISE PRJ/TCL生成与项目签名
import * as path from 'path';
import * as vscode from 'vscode';
import { CO_ISIM_DIR } from '../constants';
import { ensureConcreteProfile, getSimTime, getTestbench } from '../config';
import { ensureDirectory, workspaceFolderFor, writeTextFile } from '../fsUtil';
import { AppServices } from '../types';
import {
  buildIseProjectText,
  buildIsimRunTcl,
  verilogProjectExcludeGlob
} from '../verilogSimulationFiles';
import { dedupeUris, normalizePathKey } from '../pathUtils';
import {
  orderIseProjectFiles,
  parseXiseVerilogFileOrder
} from './iseProjectOrder';

export const maximumIseProjectDiscoveryCacheWorkspaces = 8;
// FileSystemWatcher has no exclude argument. Derive the directory group from
// the authoritative discovery glob instead of maintaining a second list.
const iseProjectDiscoveryExcludedDirectoryNames = new Set(
  (/\{([^{}]+)\}/.exec(verilogProjectExcludeGlob)?.[1] ?? '').split(',').filter(Boolean)
);

interface IseProjectDiscoveryBaseline {
  discovered: readonly vscode.Uri[];
  xiseFileOrder: readonly string[];
  cacheable: boolean;
}

interface IseProjectDiscoveryCacheEntry {
  promise: Promise<IseProjectDiscoveryBaseline>;
  invalidation: IseProjectDiscoveryInvalidation;
}

interface IseProjectDiscoveryInvalidation {
  invalidated: boolean;
}

/**
 * Session-only LRU. It caches only workspace discovery and XISE ordering;
 * caller-specific generated files and exclusions are deliberately applied
 * after lookup on every resolution.
 */
const discoveryByWorkspace = new Map<string, IseProjectDiscoveryCacheEntry>();
/** Transiently tracks scans evicted from the LRU while a caller still awaits them. */
const activeInvalidationsByWorkspace = new Map<string, Set<IseProjectDiscoveryInvalidation>>();

export interface IseProjectFiles {
  prj: vscode.Uri;
  tcl: vscode.Uri;
  outDir: vscode.Uri;
}

export interface IseProjectOptions {
  resource?: vscode.Uri;
  showMessages?: boolean;
  revealOutput?: boolean;
  testbenchName?: string;
  projectFileBaseName?: string;
  extraVerilogFiles?: vscode.Uri[];
  projectFiles?: vscode.Uri[];
  tclFileName?: string;
  tclText?: string;
  /** Internal automation lane: generate artifacts without exposing their private paths. */
  nonInteractive?: boolean;
}

export async function generateIseProject(
  services: AppServices,
  options: IseProjectOptions = {}
): Promise<IseProjectFiles | undefined> {
  const activeUri = options.resource ?? vscode.window.activeTextEditor?.document.uri;
  const nonInteractive = options.nonInteractive === true;
  const showMessages = !nonInteractive && options.showMessages !== false;
  if (!await ensureConcreteProfile(activeUri, '生成 ISE 工程需要先确定项目 Profile')) {
    return undefined;
  }
  const folder = workspaceFolderFor(activeUri);
  if (!folder) {
    if (!nonInteractive) {
      vscode.window.showErrorMessage('生成 ISE 文件前请先打开一个工作区文件夹');
    }
    return undefined;
  }
  const top = getTestbench(activeUri);
  const testbenchName = options.testbenchName ?? top;
  const projectFileBaseName = options.projectFileBaseName ?? testbenchName;
  const projectFiles = options.projectFiles ?? await resolveIseProjectFiles(folder, options.extraVerilogFiles);
  if (!projectFiles.length) {
    if (!nonInteractive) {
      vscode.window.showErrorMessage('工作区中未找到 Verilog 文件');
    }
    return undefined;
  }

  const outDir = vscode.Uri.file(path.join(folder.uri.fsPath, CO_ISIM_DIR));
  await ensureDirectory(outDir);
  const prj = vscode.Uri.file(path.join(outDir.fsPath, `${projectFileBaseName}.prj`));
  const tcl = vscode.Uri.file(path.join(outDir.fsPath, options.tclFileName ?? `${projectFileBaseName}.tcl`));
  const prjText = buildIseProjectText(projectFiles.map((uri) => uri.fsPath));
  const tclText = options.tclText ?? buildIsimRunTcl(getSimTime(activeUri));
  await writeTextFile(prj, prjText);
  await writeTextFile(tcl, tclText);
  if (!nonInteractive) {
    services.output.appendLine(`已生成 ${prj.fsPath}`);
    services.output.appendLine(`已生成 ${tcl.fsPath}`);
  }
  if (showMessages) {
    vscode.window.showInformationMessage('已生成 ISE PRJ/TCL 文件');
  }
  return { prj, tcl, outDir };
}

export async function resolveIseProjectFiles(
  folder: vscode.WorkspaceFolder,
  extraVerilogFiles: readonly vscode.Uri[] | undefined,
  exclusions: {
    excludedFiles?: readonly vscode.Uri[];
    excludedBasenames?: readonly string[];
    protectedFiles?: readonly vscode.Uri[];
  } = {}
): Promise<vscode.Uri[]> {
  const baseline = await resolveIseProjectDiscoveryBaseline(folder);
  const protectedKeys = new Set([
    ...(extraVerilogFiles ?? []),
    ...(exclusions.protectedFiles ?? [])
  ].map((uri) => normalizePathKey(uri.fsPath)));
  const excludedKeys = new Set((exclusions.excludedFiles ?? []).map((uri) => normalizePathKey(uri.fsPath)));
  const excludedBasenames = new Set((exclusions.excludedBasenames ?? []).map((name) => name.toLowerCase()));
  const files = baseline.discovered.filter((uri) => {
    const key = normalizePathKey(uri.fsPath);
    return protectedKeys.has(key)
      || (!excludedKeys.has(key) && !excludedBasenames.has(path.basename(uri.fsPath).toLowerCase()));
  });
  return orderIseProjectFiles(files, baseline.xiseFileOrder, dedupeUris(extraVerilogFiles ?? []));
}

/**
 * Invalidate one workspace's discovery baseline. Omitting the root clears all
 * entries, which is used only when an event cannot be attributed to a folder.
 */
export function clearIseProjectDiscoveryCache(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) {
    for (const entry of discoveryByWorkspace.values()) {
      entry.invalidation.invalidated = true;
    }
    for (const invalidations of activeInvalidationsByWorkspace.values()) {
      for (const invalidation of invalidations) {
        invalidation.invalidated = true;
      }
    }
    discoveryByWorkspace.clear();
    return;
  }

  const workspaceKey = iseProjectDiscoveryWorkspaceKey(workspaceRoot);
  const entry = discoveryByWorkspace.get(workspaceKey);
  if (entry) {
    entry.invalidation.invalidated = true;
    discoveryByWorkspace.delete(workspaceKey);
  }
  for (const invalidation of activeInvalidationsByWorkspace.get(workspaceKey) ?? []) {
    invalidation.invalidated = true;
  }
}

/**
 * File watchers cannot take the discovery exclude glob. Filter their events to
 * the same `.v`/`.xise` baseline so generated `.co` testbenches do not turn a
 * continuous-test cache into one full workspace scan per case.
 */
export function isIseProjectDiscoveryCandidate(
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri
): boolean {
  const extension = path.extname(uri.fsPath).toLowerCase();
  if (extension !== '.v' && extension !== '.xise') {
    return false;
  }

  const relative = path.relative(folder.uri.fsPath, uri.fsPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  const caseInsensitive = process.platform === 'win32'
    || /^[A-Za-z]:[\\/]/.test(folder.uri.fsPath)
    || folder.uri.fsPath.includes('\\');
  const directories = path.dirname(relative) === '.'
    ? []
    : path.dirname(relative).split(/[\\/]+/);
  return !directories.some((directory) => iseProjectDiscoveryExcludedDirectoryNames.has(
    caseInsensitive ? directory.toLowerCase() : directory
  ));
}

/**
 * In nested multi-root workspaces one path can belong to both a child and its
 * parent RelativePattern. Invalidate every affected baseline, not only VS
 * Code's most-specific `getWorkspaceFolder` result.
 */
export function invalidateIseProjectDiscoveryCachesForUri(
  folders: readonly vscode.WorkspaceFolder[],
  uri: vscode.Uri
): number {
  let invalidated = 0;
  for (const folder of folders) {
    if (!isIseProjectDiscoveryCandidate(folder, uri)) continue;
    clearIseProjectDiscoveryCache(folder.uri.fsPath);
    invalidated++;
  }
  return invalidated;
}

async function resolveIseProjectDiscoveryBaseline(
  folder: vscode.WorkspaceFolder
): Promise<IseProjectDiscoveryBaseline> {
  const workspaceKey = iseProjectDiscoveryWorkspaceKey(folder.uri.fsPath);
  while (true) {
    let entry = discoveryByWorkspace.get(workspaceKey);
    if (entry) {
      touchIseProjectDiscoveryEntry(workspaceKey, entry);
    } else {
      entry = createIseProjectDiscoveryEntry(workspaceKey, folder);
      touchIseProjectDiscoveryEntry(workspaceKey, entry);
    }

    let baseline: IseProjectDiscoveryBaseline;
    try {
      baseline = await entry.promise;
    } catch (error) {
      if (discoveryByWorkspace.get(workspaceKey) === entry) {
        discoveryByWorkspace.delete(workspaceKey);
      }
      throw error;
    }

    // A watcher can invalidate a scan while findFiles/readFile is pending.
    // Do not publish that stale snapshot to the caller; retry against the new
    // cache generation instead. Ordinary LRU eviction does not mark the entry.
    if (!entry.invalidation.invalidated) {
      if (!baseline.cacheable && discoveryByWorkspace.get(workspaceKey) === entry) {
        discoveryByWorkspace.delete(workspaceKey);
      }
      return baseline;
    }
  }
}

function createIseProjectDiscoveryEntry(
  workspaceKey: string,
  folder: vscode.WorkspaceFolder
): IseProjectDiscoveryCacheEntry {
  const invalidation: IseProjectDiscoveryInvalidation = { invalidated: false };
  let active = activeInvalidationsByWorkspace.get(workspaceKey);
  if (!active) {
    active = new Set();
    activeInvalidationsByWorkspace.set(workspaceKey, active);
  }
  active.add(invalidation);
  const promise = discoverIseProjectBaseline(folder).finally(() => {
    const current = activeInvalidationsByWorkspace.get(workspaceKey);
    current?.delete(invalidation);
    if (current?.size === 0) {
      activeInvalidationsByWorkspace.delete(workspaceKey);
    }
  });
  return { promise, invalidation };
}

async function discoverIseProjectBaseline(
  folder: vscode.WorkspaceFolder
): Promise<IseProjectDiscoveryBaseline> {
  const [discovered, xiseFiles] = await Promise.all([
    vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*.v'),
      verilogProjectExcludeGlob,
      5000
    ),
    vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*.xise'),
      verilogProjectExcludeGlob,
      2
    )
  ]);
  let xiseFileOrder: string[] = [];
  let cacheable = true;
  if (xiseFiles.length === 1) {
    try {
      const bytes = await vscode.workspace.fs.readFile(xiseFiles[0]);
      xiseFileOrder = parseXiseVerilogFileOrder(Buffer.from(bytes).toString('utf8'), xiseFiles[0].fsPath);
    } catch {
      // An unreadable project file must not make ISim unavailable. Stable path
      // ordering below is the deterministic fallback used for this call. Do not
      // retain a possibly transient read failure as the session baseline.
      cacheable = false;
    }
  }
  return {
    discovered: [...discovered],
    xiseFileOrder,
    cacheable
  };
}

function touchIseProjectDiscoveryEntry(
  workspaceKey: string,
  entry: IseProjectDiscoveryCacheEntry
): void {
  discoveryByWorkspace.delete(workspaceKey);
  discoveryByWorkspace.set(workspaceKey, entry);
  while (discoveryByWorkspace.size > maximumIseProjectDiscoveryCacheWorkspaces) {
    const oldestWorkspace = discoveryByWorkspace.keys().next().value as string | undefined;
    if (oldestWorkspace === undefined) {
      break;
    }
    discoveryByWorkspace.delete(oldestWorkspace);
  }
}

function iseProjectDiscoveryWorkspaceKey(workspaceRoot: string): string {
  return normalizePathKey(path.resolve(workspaceRoot));
}

export async function verilogProjectSignature(files: readonly vscode.Uri[], contentSignatures = new Map<string, string>()): Promise<string> {
  const entries: string[] = [];
  for (const uri of files) {
    const key = normalizePathKey(uri.fsPath);
    const contentSignature = contentSignatures.get(key);
    if (contentSignature) {
      entries.push(`${key}:sha:${contentSignature}`);
      continue;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      entries.push(`${key}:${stat.size}:${Math.trunc(stat.mtime)}`);
    } catch {
      entries.push(`${key}:missing`);
    }
  }
  return entries.join('|');
}
