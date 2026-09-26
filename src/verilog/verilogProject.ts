// @index verilog-project — cached workspace Verilog source discovery
import * as path from 'path';
import * as vscode from 'vscode';
import { isCustomTestbenchPath, verilogProjectExcludeGlob } from '../verilogSimulationFiles';
import { dedupeUris, normalizePathKey } from '../pathUtils';
import { orderVerilogProjectFiles } from './verilogProjectOrder';

export const maximumVerilogProjectDiscoveryCacheWorkspaces = 8;
// FileSystemWatcher has no exclude argument. Derive the directory group from
// the authoritative discovery glob instead of maintaining a second list.
const verilogProjectDiscoveryExcludedDirectoryNames = new Set(
  (/\{([^{}]+)\}/.exec(verilogProjectExcludeGlob)?.[1] ?? '').split(',').filter(Boolean)
);

interface VerilogProjectDiscoveryBaseline {
  discovered: readonly vscode.Uri[];
}

interface VerilogProjectDiscoveryCacheEntry {
  promise: Promise<VerilogProjectDiscoveryBaseline>;
  invalidation: VerilogProjectDiscoveryInvalidation;
}

interface VerilogProjectDiscoveryInvalidation {
  invalidated: boolean;
}

/**
 * Session-only LRU. It caches only workspace discovery;
 * caller-specific generated files and exclusions are deliberately applied
 * after lookup on every resolution.
 */
const discoveryByWorkspace = new Map<string, VerilogProjectDiscoveryCacheEntry>();
/** Transiently tracks scans evicted from the LRU while a caller still awaits them. */
const activeInvalidationsByWorkspace = new Map<string, Set<VerilogProjectDiscoveryInvalidation>>();

export async function resolveVerilogProjectFiles(
  folder: vscode.WorkspaceFolder,
  extraVerilogFiles: readonly vscode.Uri[] | undefined,
  exclusions: {
    excludedFiles?: readonly vscode.Uri[];
    excludedBasenames?: readonly string[];
    protectedFiles?: readonly vscode.Uri[];
    excludeCustomTestbenches?: boolean;
  } = {}
): Promise<vscode.Uri[]> {
  const baseline = await resolveVerilogProjectDiscoveryBaseline(folder);
  const protectedKeys = new Set([
    ...(extraVerilogFiles ?? []),
    ...(exclusions.protectedFiles ?? [])
  ].map((uri) => normalizePathKey(uri.fsPath)));
  const excludedKeys = new Set((exclusions.excludedFiles ?? []).map((uri) => normalizePathKey(uri.fsPath)));
  const excludedBasenames = new Set((exclusions.excludedBasenames ?? []).map((name) => name.toLowerCase()));
  const files = baseline.discovered.filter((uri) => {
    const key = normalizePathKey(uri.fsPath);
    return protectedKeys.has(key)
      || (!excludedKeys.has(key)
        && !excludedBasenames.has(path.basename(uri.fsPath).toLowerCase())
        && !(exclusions.excludeCustomTestbenches && isCustomTestbenchPath(uri.fsPath)));
  });
  return orderVerilogProjectFiles(files, dedupeUris(extraVerilogFiles ?? []));
}

/**
 * Invalidate one workspace's discovery baseline. Omitting the root clears all
 * entries, which is used only when an event cannot be attributed to a folder.
 */
export function clearVerilogProjectDiscoveryCache(workspaceRoot?: string): void {
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

  const workspaceKey = verilogProjectDiscoveryWorkspaceKey(workspaceRoot);
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
 * the same `.v` baseline so generated `.co` testbenches do not turn a
 * continuous-test cache into one full workspace scan per case.
 */
export function isVerilogProjectDiscoveryCandidate(
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri
): boolean {
  const extension = path.extname(uri.fsPath).toLowerCase();
  if (extension !== '.v') {
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
  return !directories.some((directory) => verilogProjectDiscoveryExcludedDirectoryNames.has(
    caseInsensitive ? directory.toLowerCase() : directory
  ));
}

/**
 * In nested multi-root workspaces one path can belong to both a child and its
 * parent RelativePattern. Invalidate every affected baseline, not only VS
 * Code's most-specific `getWorkspaceFolder` result.
 */
export function invalidateVerilogProjectDiscoveryCachesForUri(
  folders: readonly vscode.WorkspaceFolder[],
  uri: vscode.Uri
): number {
  let invalidated = 0;
  for (const folder of folders) {
    if (!isVerilogProjectDiscoveryCandidate(folder, uri)) continue;
    clearVerilogProjectDiscoveryCache(folder.uri.fsPath);
    invalidated++;
  }
  return invalidated;
}

async function resolveVerilogProjectDiscoveryBaseline(
  folder: vscode.WorkspaceFolder
): Promise<VerilogProjectDiscoveryBaseline> {
  const workspaceKey = verilogProjectDiscoveryWorkspaceKey(folder.uri.fsPath);
  while (true) {
    let entry = discoveryByWorkspace.get(workspaceKey);
    if (entry) {
      touchVerilogProjectDiscoveryEntry(workspaceKey, entry);
    } else {
      entry = createVerilogProjectDiscoveryEntry(workspaceKey, folder);
      touchVerilogProjectDiscoveryEntry(workspaceKey, entry);
    }

    let baseline: VerilogProjectDiscoveryBaseline;
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
      return baseline;
    }
  }
}

function createVerilogProjectDiscoveryEntry(
  workspaceKey: string,
  folder: vscode.WorkspaceFolder
): VerilogProjectDiscoveryCacheEntry {
  const invalidation: VerilogProjectDiscoveryInvalidation = { invalidated: false };
  let active = activeInvalidationsByWorkspace.get(workspaceKey);
  if (!active) {
    active = new Set();
    activeInvalidationsByWorkspace.set(workspaceKey, active);
  }
  active.add(invalidation);
  const promise = discoverVerilogProjectBaseline(folder).finally(() => {
    const current = activeInvalidationsByWorkspace.get(workspaceKey);
    current?.delete(invalidation);
    if (current?.size === 0) {
      activeInvalidationsByWorkspace.delete(workspaceKey);
    }
  });
  return { promise, invalidation };
}

async function discoverVerilogProjectBaseline(
  folder: vscode.WorkspaceFolder
): Promise<VerilogProjectDiscoveryBaseline> {
  const discovered = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*.v'),
    verilogProjectExcludeGlob,
    5000
  );
  return { discovered: [...discovered] };
}

function touchVerilogProjectDiscoveryEntry(
  workspaceKey: string,
  entry: VerilogProjectDiscoveryCacheEntry
): void {
  discoveryByWorkspace.delete(workspaceKey);
  discoveryByWorkspace.set(workspaceKey, entry);
  while (discoveryByWorkspace.size > maximumVerilogProjectDiscoveryCacheWorkspaces) {
    const oldestWorkspace = discoveryByWorkspace.keys().next().value as string | undefined;
    if (oldestWorkspace === undefined) {
      break;
    }
    discoveryByWorkspace.delete(oldestWorkspace);
  }
}

function verilogProjectDiscoveryWorkspaceKey(workspaceRoot: string): string {
  return normalizePathKey(path.resolve(workspaceRoot));
}
