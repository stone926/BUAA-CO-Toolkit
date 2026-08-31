// @index course-testing — 连续测试用例所有权校验、终态记录与安全保留清理
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { sha256Bytes } from '../asmCaseStoreCore';
import { CO_CASES_DIR, CO_DIR } from '../constants';
import { maximumReplayManifestBytes, readBoundedRegularFile } from '../mips/replay/boundedFile';
import { normalizePathKey } from '../pathUtils';
import { assertContainedDirectoryPath, ensureContainedDirectoryPath } from '../pathContainment';
import {
  AsmCaseManifestV2,
  assertManifestStringMapEntries,
  isKnownManifest,
  isManifestV2,
  writeManifestAtomic
} from './manifestCodec';

export type ContinuousAsmCaseState = 'generated' | 'cancelled' | 'passed' | 'failed' | 'error';

export interface ContinuousAsmCaseOutcome {
  readonly status: 'passed' | 'failed' | 'error';
  readonly stage: 'assemble' | 'oracle' | 'dut' | 'compare' | 'probe' | 'internal';
  readonly diagnostic: string;
  readonly state: 'passed' | 'failed' | 'error';
}

interface ContinuousOwnedAsmCase {
  manifest: AsmCaseManifestV2;
  manifestPath: string;
  caseDir: string;
  workspaceRoot: string;
  caseIdentity: FsNodeIdentity;
  manifestIdentity: FsNodeIdentity;
  manifestSha256: string;
}

interface FsNodeIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
  size: number;
}

interface MutationQueueState {
  tail: Promise<void>;
  users: number;
}

interface PendingTrashEntry {
  target: string;
  realTrashDir: string;
  manifestSha256: string;
}

const mutationQueues = new Map<string, MutationQueueState>();
const pendingTrashEntries = new Map<string, PendingTrashEntry>();
const maximumPendingTrashEntries = 64;

/** Record terminal evidence only when the case still belongs to the active session. */
export async function recordContinuousAsmCaseOutcome(
  manifestPath: string,
  sessionId: string,
  outcome: ContinuousAsmCaseOutcome
): Promise<boolean> {
  return await runSerializedCaseMutation(manifestPath, async () => {
    const owned = await readContinuousOwnedAsmCase(
      manifestPath,
      sessionId,
      ['generated', outcome.state]
    );
    if (!owned) return false;
    const metadata = {
      ...(owned.manifest.metadata ?? {}),
      'test.status': outcome.status,
      'test.stage': outcome.stage,
      'test.diagnostic': outcome.diagnostic,
      'continuous.state': outcome.state
    };
    assertManifestStringMapEntries(metadata, 'metadata');
    await writeManifestAtomic(owned.manifestPath, { ...owned.manifest, metadata });
    return true;
  });
}

/** Mark a case cancelled without turning a user stop into failed/error evidence. */
export async function markContinuousAsmCaseCancelled(
  manifestPath: string | undefined,
  sessionId: string
): Promise<boolean> {
  if (!manifestPath) return false;
  return await runSerializedCaseMutation(manifestPath, async () => {
    const owned = await readContinuousOwnedAsmCase(manifestPath, sessionId, ['generated', 'cancelled']);
    if (!owned || owned.manifest.metadata?.['test.status'] !== undefined) return false;
    const metadata = {
      ...(owned.manifest.metadata ?? {}),
      'continuous.state': 'cancelled'
    };
    assertManifestStringMapEntries(metadata, 'metadata');
    await writeManifestAtomic(owned.manifestPath, { ...owned.manifest, metadata });
    return true;
  });
}

/** Remove an unfinished continuous case only after fail-closed ownership checks. */
export async function discardContinuousGeneratedAsmCase(
  manifestPath: string | undefined,
  sessionId: string
): Promise<boolean> {
  if (!manifestPath) return false;
  return await runSerializedCaseMutation(
    manifestPath,
    async () => await discardContinuousAsmCase(manifestPath, sessionId, ['generated', 'cancelled'])
  );
}

/** Prune passing evidence only when the state and compact outcome agree. */
export async function discardContinuousPassingAsmCase(
  manifestPath: string | undefined,
  sessionId: string
): Promise<boolean> {
  if (!manifestPath) return false;
  return await runSerializedCaseMutation(
    manifestPath,
    async () => await discardContinuousAsmCase(manifestPath, sessionId, ['passed'], true)
  );
}

async function discardContinuousAsmCase(
  manifestPath: string,
  sessionId: string,
  allowedStates: readonly ContinuousAsmCaseState[],
  requirePassedOutcome = false
): Promise<boolean> {
  const owned = await readContinuousOwnedAsmCase(manifestPath, sessionId, allowedStates);
  if (!owned
    || (requirePassedOutcome
      ? owned.manifest.metadata?.['test.status'] !== 'passed'
      : owned.manifest.metadata?.['test.status'] !== undefined)) {
    return false;
  }

  const trashDir = path.resolve(owned.workspaceRoot, CO_DIR, 'trash');
  let realTrashDir: string;
  try {
    await ensureContainedDirectoryPath(owned.workspaceRoot, trashDir);
    await assertContainedDirectoryPath(owned.workspaceRoot, trashDir);
    const trashStat = await fs.promises.lstat(trashDir);
    if (trashStat.isSymbolicLink() || !trashStat.isDirectory()) return false;
    realTrashDir = await fs.promises.realpath(trashDir);
  } catch {
    return false;
  }
  await retryOnePendingTrashEntry(realTrashDir);

  // Directory preparation awaited filesystem work. Re-read immediately before
  // rename so a concurrent terminal transition can only make cleanup refuse.
  const current = await readContinuousOwnedAsmCase(manifestPath, sessionId, allowedStates);
  if (!current
    || normalizePathKey(current.caseDir) !== normalizePathKey(owned.caseDir)
    || (requirePassedOutcome
      ? current.manifest.metadata?.['test.status'] !== 'passed'
      : current.manifest.metadata?.['test.status'] !== undefined)) {
    return false;
  }

  const trashTarget = path.resolve(
    trashDir,
    `continuous-${current.manifest.caseId}-${randomBytes(8).toString('hex')}`
  );
  const relativeTrashTarget = path.relative(trashDir, trashTarget);
  if (!relativeTrashTarget
    || relativeTrashTarget === '..'
    || relativeTrashTarget.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeTrashTarget)
    || normalizePathKey(path.dirname(trashTarget)) !== normalizePathKey(trashDir)) {
    return false;
  }

  try {
    const [trashParentStat, realTrashParent] = await Promise.all([
      fs.promises.lstat(path.dirname(trashTarget)),
      fs.promises.realpath(path.dirname(trashTarget))
    ]);
    if (trashParentStat.isSymbolicLink()
      || !trashParentStat.isDirectory()
      || normalizePathKey(realTrashParent) !== normalizePathKey(realTrashDir)) {
      return false;
    }
    try {
      await fs.promises.lstat(trashTarget);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }

    // Check both source nodes after the final manifest read and immediately
    // before the atomic move, rejecting a link or non-directory replacement.
    const [caseStat, manifestStat] = await Promise.all([
      fs.promises.lstat(current.caseDir),
      fs.promises.lstat(current.manifestPath)
    ]);
    if (caseStat.isSymbolicLink()
      || !caseStat.isDirectory()
      || manifestStat.isSymbolicLink()
      || !manifestStat.isFile()
      || !sameNodeIdentity(nodeIdentity(caseStat), current.caseIdentity)
      || !sameNodeIdentity(nodeIdentity(manifestStat), current.manifestIdentity)) {
      return false;
    }
    await fs.promises.rename(current.caseDir, trashTarget);
  } catch {
    return false;
  }

  // Rename is the commit point: the case is no longer discoverable. Verify the
  // exact moved manifest before physical deletion; a post-check failure preserves
  // the entry in trash rather than deleting newly written terminal evidence.
  const pending: PendingTrashEntry = {
    target: trashTarget,
    realTrashDir,
    manifestSha256: current.manifestSha256
  };
  if (await removeVerifiedTrashEntry(pending) === 'retry') {
    rememberPendingTrashEntry(pending);
  }
  return true;
}

async function readContinuousOwnedAsmCase(
  manifestPath: string,
  sessionId: string,
  allowedStates: readonly ContinuousAsmCaseState[]
): Promise<ContinuousOwnedAsmCase | undefined> {
  if (!isContinuousSessionId(sessionId)) return undefined;
  const resolvedManifest = path.resolve(manifestPath);
  if (path.basename(resolvedManifest).toLowerCase() !== 'case.json') return undefined;
  const caseDir = path.dirname(resolvedManifest);
  const casesDir = path.dirname(caseDir);
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(resolvedManifest));
  if (!folder) return undefined;
  const workspaceRoot = path.resolve(folder.uri.fsPath);
  const expectedCasesDir = path.resolve(workspaceRoot, CO_CASES_DIR);
  if (normalizePathKey(casesDir) !== normalizePathKey(expectedCasesDir)) return undefined;

  let caseStat: fs.Stats;
  let manifestStat: fs.Stats;
  try {
    await assertContainedDirectoryPath(workspaceRoot, casesDir);
    await assertContainedDirectoryPath(casesDir, caseDir);
    [caseStat, manifestStat] = await Promise.all([
      fs.promises.lstat(caseDir),
      fs.promises.lstat(resolvedManifest)
    ]);
    if (caseStat.isSymbolicLink()
      || !caseStat.isDirectory()
      || manifestStat.isSymbolicLink()
      || !manifestStat.isFile()) return undefined;
  } catch {
    return undefined;
  }

  let manifest: unknown;
  let manifestSha256: string;
  try {
    const bytes = await readBoundedRegularFile(resolvedManifest, {
      maximumBytes: maximumReplayManifestBytes,
      label: 'continuous ASM case manifest'
    });
    manifestSha256 = sha256Bytes(bytes);
    manifest = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (!isKnownManifest(manifest) || !isManifestV2(manifest)) return undefined;
  if (manifest.caseId !== path.basename(caseDir)) return undefined;
  if (manifest.source.kind !== 'builtin' || manifest.source.generator !== 'builtin:random-asm') return undefined;
  if (manifest.metadata?.['continuous.sessionId'] !== sessionId) return undefined;
  const state = manifest.metadata?.['continuous.state'];
  if (!state || !allowedStates.includes(state as ContinuousAsmCaseState)) return undefined;
  return {
    manifest,
    manifestPath: resolvedManifest,
    caseDir,
    workspaceRoot,
    caseIdentity: nodeIdentity(caseStat),
    manifestIdentity: nodeIdentity(manifestStat),
    manifestSha256
  };
}

function isContinuousSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function runSerializedCaseMutation<T>(
  manifestPath: string,
  action: () => Promise<T>
): Promise<T> {
  const key = normalizePathKey(path.resolve(manifestPath));
  let state = mutationQueues.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), users: 0 };
    mutationQueues.set(key, state);
  }

  const predecessor = state.tail.catch(() => undefined);
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.tail = predecessor.then(() => turn);
  state.users++;
  await predecessor;
  try {
    return await action();
  } finally {
    release();
    state.users--;
    if (state.users === 0 && mutationQueues.get(key) === state) {
      mutationQueues.delete(key);
    }
  }
}

function nodeIdentity(stat: fs.Stats): FsNodeIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    size: stat.size
  };
}

function sameNodeIdentity(left: FsNodeIdentity, right: FsNodeIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
    && left.size === right.size;
}

type TrashRemovalResult = 'removed' | 'unsafe' | 'retry';

async function removeVerifiedTrashEntry(entry: PendingTrashEntry): Promise<TrashRemovalResult> {
  try {
    const manifestPath = path.join(entry.target, 'case.json');
    const [movedStat, movedRealPath, manifestStat] = await Promise.all([
      fs.promises.lstat(entry.target),
      fs.promises.realpath(entry.target),
      fs.promises.lstat(manifestPath)
    ]);
    const realRelative = path.relative(entry.realTrashDir, movedRealPath);
    if (movedStat.isSymbolicLink()
      || !movedStat.isDirectory()
      || manifestStat.isSymbolicLink()
      || !manifestStat.isFile()
      || !realRelative
      || realRelative === '..'
      || realRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(realRelative)) {
      return 'unsafe';
    }
    const manifestBytes = await readBoundedRegularFile(manifestPath, {
      maximumBytes: maximumReplayManifestBytes,
      label: 'continuous trash manifest'
    });
    if (sha256Bytes(manifestBytes) !== entry.manifestSha256) {
      return 'unsafe';
    }
    await fs.promises.rm(entry.target, { recursive: true, force: true });
    return 'removed';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'removed' : 'retry';
  }
}

function rememberPendingTrashEntry(entry: PendingTrashEntry): void {
  const key = normalizePathKey(entry.target);
  pendingTrashEntries.delete(key);
  pendingTrashEntries.set(key, entry);
  while (pendingTrashEntries.size > maximumPendingTrashEntries) {
    const oldest = pendingTrashEntries.keys().next().value as string | undefined;
    if (!oldest) break;
    pendingTrashEntries.delete(oldest);
  }
}

async function retryOnePendingTrashEntry(realTrashDir: string): Promise<void> {
  const realTrashKey = normalizePathKey(realTrashDir);
  const candidate = [...pendingTrashEntries.entries()].find(([, entry]) =>
    normalizePathKey(entry.realTrashDir) === realTrashKey
  );
  if (!candidate) return;
  const [key, entry] = candidate;
  const result = await removeVerifiedTrashEntry(entry);
  if (result !== 'retry') {
    pendingTrashEntries.delete(key);
  }
}
