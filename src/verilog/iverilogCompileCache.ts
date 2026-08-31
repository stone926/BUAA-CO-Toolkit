// @index verilog-iverilog-compile-cache — content-verified, single-entry-per-workspace Icarus compile cache
import * as fs from 'fs';
import * as path from 'path';
import { normalizePathKey } from '../pathUtils';
import type { RunResult } from '../types';
import {
  FileFingerprint,
  fileContentSignature,
  fingerprintDependencies,
  fingerprintFile,
  fingerprintOrderedFiles,
  readFileBounded,
  resolveCompilerPath,
  sameFileObservation,
  sameFileObservations,
  sameFingerprints,
  throwIfAborted
} from './iverilogCompileCacheIo';
import {
  IncludePathObservation,
  buildIverilogIncludeResolutionGuards,
  validateIverilogIncludeResolutionGuards
} from './iverilogIncludeResolution';

const cacheSchemaRevision = 2;
const maximumDependencyFileBytes = 4 * 1024 * 1024;
const maximumDependencyEntries = 20_000;
export const maximumIverilogCompileCacheWorkspaces = 8;

export interface IverilogCompileRuntimeIdentity {
  rootDir: string;
  binDir: string;
  libDir: string;
  iverilogPath: string;
  vvpPath: string;
  version: string;
}

export interface IverilogCompileCacheInput {
  workspaceRoot: string;
  compileCwd: string;
  runtime: IverilogCompileRuntimeIdentity;
  /** Exact ordered compiler argv, including language/target/top/include/source semantics. */
  compileArguments: readonly string[];
  /** Ordered compiler source inputs, including generated testbench and watchdog sources. */
  directSourceFiles: readonly string[];
  compiledFile: string;
  dependencyFile: string;
}

/** Opaque pre-compile source snapshot reused only when publishing a successful compile. */
export interface IverilogCompileCacheSnapshot {
  readonly workspaceKey: string;
  readonly key: string;
  readonly input: IverilogCompileCacheInput;
  readonly directFiles: readonly FileFingerprint[];
}

export interface IverilogCompileCacheHit {
  compileResult: RunResult;
}

export interface IverilogCompileCacheLookup {
  /** Missing only when direct inputs could not be read reliably; compilation should still run. */
  snapshot?: IverilogCompileCacheSnapshot;
  hit?: IverilogCompileCacheHit;
}

interface IverilogCompileCacheEntry {
  key: string;
  dependencies: readonly FileFingerprint[];
  includeResolutionGuards: readonly IncludePathObservation[];
  compiled: FileFingerprint;
  compileResult: RunResult;
}

/** Exactly one entry per workspace; misses replace it instead of accumulating disk artifacts. */
const entriesByWorkspace = new Map<string, IverilogCompileCacheEntry>();

/**
 * Build and validate the current direct-input snapshot, then check the single
 * workspace entry. Any unreadable/missing/corrupt input is a cache miss rather
 * than a simulation failure.
 */
export async function lookupIverilogCompileCache(
  input: IverilogCompileCacheInput,
  signal?: AbortSignal
): Promise<IverilogCompileCacheLookup> {
  const workspaceKey = workspaceCacheKey(input.workspaceRoot);
  let snapshot: IverilogCompileCacheSnapshot;
  try {
    snapshot = await createCompileSnapshot(input, workspaceKey, signal);
  } catch {
    if (signal?.aborted) return {};
    entriesByWorkspace.delete(workspaceKey);
    return {};
  }

  const entry = entriesByWorkspace.get(workspaceKey);
  if (!entry || entry.key !== snapshot.key || !entry.compileResult.ok) {
    if (entry) entriesByWorkspace.delete(workspaceKey);
    return { snapshot };
  }

  try {
    // Direct sources were read for the semantic key. Hash dependency-only files
    // here, then validate include shadows and the fixed VVP artifact last.
    const dependencies = await fingerprintDependencies(
      entry.dependencies.map((dependency) => dependency.path),
      snapshot.directFiles,
      signal
    );
    if (!sameFingerprints(dependencies, entry.dependencies)) {
      entriesByWorkspace.delete(workspaceKey);
      return { snapshot };
    }
    if (!await validateIverilogIncludeResolutionGuards(entry.includeResolutionGuards, signal)) {
      entriesByWorkspace.delete(workspaceKey);
      return { snapshot };
    }
    const compiled = await fingerprintFile(snapshot.input.compiledFile, signal);
    if (!sameFileObservation(compiled, entry.compiled)) {
      entriesByWorkspace.delete(workspaceKey);
      return { snapshot };
    }
  } catch {
    if (signal?.aborted) return {};
    entriesByWorkspace.delete(workspaceKey);
    return { snapshot };
  }

  setWorkspaceEntry(workspaceKey, entry);
  return {
    snapshot,
    hit: { compileResult: { ...entry.compileResult } }
  };
}

/**
 * Invalidate the prior entry and clear the two fixed compiler outputs before a
 * miss. Failure to clear only disables publishing this compile; the compiler is
 * still allowed to run and report its authoritative result.
 */
export async function prepareIverilogCompileCacheMiss(
  input: IverilogCompileCacheInput
): Promise<boolean> {
  const normalizedInput = cloneInput(input);
  entriesByWorkspace.delete(workspaceCacheKey(normalizedInput.workspaceRoot));
  // Wait for both removals even if one fails. Returning early from Promise.all
  // could let the surviving rm race the compiler and delete its new output.
  const removals = await Promise.allSettled([
    fs.promises.rm(normalizedInput.compiledFile, { force: true }),
    fs.promises.rm(normalizedInput.dependencyFile, { force: true })
  ]);
  return removals.every((removal) => removal.status === 'fulfilled');
}

/**
 * Publish only an unquestionably successful compile whose direct inputs still
 * match the pre-compile snapshot and whose complete `-Mall` dependency closure
 * and VVP artifact can be content-fingerprinted.
 */
export async function storeIverilogCompileCache(
  snapshot: IverilogCompileCacheSnapshot,
  compileResult: RunResult,
  signal?: AbortSignal
): Promise<boolean> {
  if (!compileResult.ok || compileResult.timedOut || compileResult.stopped) {
    entriesByWorkspace.delete(snapshot.workspaceKey);
    return false;
  }

  const { input, workspaceKey } = snapshot;
  try {
    throwIfAborted(signal);
    const dependencyPaths = await readIverilogDependencyFile(
      input.dependencyFile,
      input.compileCwd,
      signal
    );
    const dependencyKeys = new Set(dependencyPaths.map(normalizePathKey));
    if (snapshot.directFiles.some((source) => !dependencyKeys.has(source.path))) {
      entriesByWorkspace.delete(workspaceKey);
      return false;
    }

    // Hash the compiler-reported closure once after compilation. Selecting the
    // direct inputs back out detects edits that raced the compiler.
    const dependencies = await fingerprintOrderedFiles(dependencyPaths, signal);
    const dependencyByPath = new Map(dependencies.map((dependency) => [dependency.path, dependency]));
    const currentDirectFiles = snapshot.directFiles.map((source) => dependencyByPath.get(source.path));
    if (currentDirectFiles.some((source) => source === undefined)
      || !sameFileObservations(currentDirectFiles as FileFingerprint[], snapshot.directFiles)) {
      entriesByWorkspace.delete(workspaceKey);
      return false;
    }
    const includeResolutionGuards = await buildIverilogIncludeResolutionGuards(
      input,
      dependencyPaths,
      signal
    );
    const compiled = await fingerprintFile(input.compiledFile, signal);
    throwIfAborted(signal);
    setWorkspaceEntry(workspaceKey, {
      key: snapshot.key,
      dependencies,
      includeResolutionGuards,
      compiled,
      compileResult: compactSuccessfulCompileResult(compileResult)
    });
    return true;
  } catch {
    entriesByWorkspace.delete(workspaceKey);
    return false;
  }
}

/** Test/session lifecycle hook; omitting a root clears in-memory entries only. */
export function clearIverilogCompileCache(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) {
    entriesByWorkspace.clear();
    return;
  }
  entriesByWorkspace.delete(workspaceCacheKey(workspaceRoot));
}

export async function readIverilogDependencyFile(
  dependencyFile: string,
  compileCwd: string,
  signal?: AbortSignal
): Promise<string[]> {
  const bytes = await readFileBounded(
    dependencyFile,
    maximumDependencyFileBytes,
    'Icarus dependency file',
    signal
  );
  const seen = new Map<string, string>();
  const dependencies: string[] = [];
  for (const rawLine of bytes.toString('utf8').split(/\r?\n/)) {
    throwIfAborted(signal);
    const dependency = rawLine.trim();
    if (!dependency) continue;
    if (dependency.includes('\0')) {
      throw new Error('Icarus dependency file contains a NUL byte');
    }
    const absolute = path.isAbsolute(dependency)
      ? path.normalize(dependency)
      : path.resolve(compileCwd, dependency);
    const key = normalizePathKey(absolute);
    const previous = seen.get(key);
    if (previous !== undefined && previous !== absolute) {
      throw new Error(`Icarus dependency paths collide after Windows normalization: ${previous} / ${absolute}`);
    }
    if (previous === undefined) {
      seen.set(key, absolute);
      dependencies.push(absolute);
      if (dependencies.length > maximumDependencyEntries) {
        throw new Error(`Icarus dependency file exceeds ${maximumDependencyEntries} entries`);
      }
    }
  }
  if (!dependencies.length) {
    throw new Error('Icarus dependency file is empty');
  }
  return dependencies;
}

async function createCompileSnapshot(
  input: IverilogCompileCacheInput,
  workspaceKey: string,
  signal?: AbortSignal
): Promise<IverilogCompileCacheSnapshot> {
  const stableInput = cloneInput(input);
  const directFiles = await fingerprintOrderedFiles(stableInput.directSourceFiles, signal);
  const key = JSON.stringify({
    schemaRevision: cacheSchemaRevision,
    workspaceRoot: workspaceKey,
    compileCwd: normalizePathKey(stableInput.compileCwd),
    compiledFile: normalizePathKey(stableInput.compiledFile),
    dependencyFile: normalizePathKey(stableInput.dependencyFile),
    runtime: {
      rootDir: normalizePathKey(stableInput.runtime.rootDir),
      binDir: normalizePathKey(stableInput.runtime.binDir),
      libDir: normalizePathKey(stableInput.runtime.libDir),
      iverilogPath: normalizePathKey(stableInput.runtime.iverilogPath),
      vvpPath: normalizePathKey(stableInput.runtime.vvpPath),
      version: stableInput.runtime.version
    },
    // Exact argv order describes generation, target, tops, includes and sources.
    compileArguments: stableInput.compileArguments,
    directFiles: directFiles.map(fileContentSignature)
  });
  return { workspaceKey, key, input: stableInput, directFiles };
}

function setWorkspaceEntry(workspaceKey: string, entry: IverilogCompileCacheEntry): void {
  entriesByWorkspace.delete(workspaceKey);
  entriesByWorkspace.set(workspaceKey, entry);
  while (entriesByWorkspace.size > maximumIverilogCompileCacheWorkspaces) {
    const oldestWorkspace = entriesByWorkspace.keys().next().value as string | undefined;
    if (oldestWorkspace === undefined) break;
    entriesByWorkspace.delete(oldestWorkspace);
  }
}

function cloneInput(input: IverilogCompileCacheInput): IverilogCompileCacheInput {
  const compileCwd = path.resolve(input.compileCwd);
  return {
    workspaceRoot: path.resolve(input.workspaceRoot),
    compileCwd,
    runtime: { ...input.runtime },
    compileArguments: [...input.compileArguments],
    directSourceFiles: input.directSourceFiles.map((file) => resolveCompilerPath(file, compileCwd)),
    compiledFile: resolveCompilerPath(input.compiledFile, compileCwd),
    dependencyFile: resolveCompilerPath(input.dependencyFile, compileCwd)
  };
}

function workspaceCacheKey(workspaceRoot: string): string {
  return normalizePathKey(path.resolve(workspaceRoot));
}

function compactSuccessfulCompileResult(result: RunResult): RunResult {
  return {
    ok: true,
    exitCode: result.exitCode,
    commandLine: result.commandLine,
    cwd: result.cwd,
    stdout: '',
    stderr: '',
    timedOut: false,
    stopped: false
  };
}
