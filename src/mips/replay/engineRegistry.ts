// @index mips-replay — role+digest immutable engine artifact registry（原子写、containment、无自动过期）
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { EngineArtifactIdentity } from '../providers/contracts';
import { canonicalJson, sha256Bytes, type CanonicalJson } from './canonical';

export const engineArtifactRegistrySchemaRevision = 1;
export const maximumEngineArtifactBytes = 256 * 1024 * 1024;
export const maximumEngineRegistryMetadataBytes = 16 * 1024;
const streamBufferBytes = 1024 * 1024;

/**
 * Artifacts are retained indefinitely because a case may outlive the workspace that created it.
 * No time-based eviction is permitted. A future explicit GC must first build a complete live
 * role+digest set by scanning every retained case manifest.
 */
export const engineArtifactRetentionPolicy = 'retain-until-explicit-live-manifest-gc' as const;

interface RegistryMetadata {
  schemaRevision: typeof engineArtifactRegistrySchemaRevision;
  role: string;
  sha256: string;
  bytes: number;
  fileName: string;
  retentionPolicy: typeof engineArtifactRetentionPolicy;
}

export interface ResolvedEngineArtifact {
  identity: EngineArtifactIdentity;
  path: string;
  bytes: number;
}

export class ImmutableEngineArtifactRegistry {
  private readonly executionAuthorizations = new Set<string>();

  constructor(
    readonly root: string,
    /** Trusted lexical anchor. Production passes the workspace root. */
    readonly containmentRoot: string = path.dirname(path.resolve(root))
  ) {}

  async registerFile(role: string, sourceFile: string, fileName = path.basename(sourceFile)): Promise<ResolvedEngineArtifact> {
    assertRole(role);
    const safeName = safeFileName(fileName);
    await this.prepareRoleDirectory(role);
    const roleDir = path.join(this.root, role);
    const tempDir = path.join(roleDir, `.tmp-${process.pid}-${crypto.randomUUID()}`);
    const artifactPath = path.join(tempDir, safeName);
    let source: fs.promises.FileHandle | undefined;
    let target: fs.promises.FileHandle | undefined;
    try {
      source = await openRegularNonSymlink(sourceFile, 'trusted engine source');
      const sourceStat = await source.stat();
      assertArtifactSize(sourceStat.size, 'trusted engine source');
      await fs.promises.mkdir(tempDir, { recursive: false });
      await assertDirectoryContained(this.containmentRoot, tempDir);
      target = await fs.promises.open(artifactPath, 'wx', 0o444);
      const copied = await copyAndHashOpenFile(source, target, {
        label: 'trusted engine source',
        expectedBytes: sourceStat.size
      });
      await target.sync();
      await target.close();
      target = undefined;
      await source.close();
      source = undefined;
      const result = await this.publishTempEntry(role, safeName, tempDir, copied.sha256, copied.bytes);
      this.executionAuthorizations.add(authorizationKey(role, copied.sha256));
      return result;
    } finally {
      await target?.close().catch(() => undefined);
      await source?.close().catch(() => undefined);
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async registerBytes(role: string, bytes: Uint8Array, fileName: string): Promise<ResolvedEngineArtifact> {
    assertRole(role);
    assertArtifactSize(bytes.byteLength, 'trusted engine bytes');
    const safeName = safeFileName(fileName);
    const digest = sha256Bytes(bytes);
    await this.prepareRoleDirectory(role);

    try {
      const existing = await this.resolve({ sha256: digest, role });
      this.executionAuthorizations.add(authorizationKey(role, digest));
      return existing;
    } catch (error) {
      if (!isMissingRegistryEntry(error)) throw error;
    }

    const roleDir = path.join(this.root, role);
    const tempDir = path.join(roleDir, `.tmp-${process.pid}-${crypto.randomUUID()}`);
    const artifactPath = path.join(tempDir, safeName);
    try {
      await fs.promises.mkdir(tempDir, { recursive: false });
      await assertDirectoryContained(this.containmentRoot, tempDir);
      await fs.promises.writeFile(artifactPath, bytes, { flag: 'wx', mode: 0o444 });
      const result = await this.publishTempEntry(role, safeName, tempDir, digest, bytes.byteLength);
      this.executionAuthorizations.add(authorizationKey(role, digest));
      return result;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async resolve(identity: EngineArtifactIdentity): Promise<ResolvedEngineArtifact> {
    const role = identity.role;
    if (!role) throw registryError('engine artifact role is required for immutable registry resolution', 'INVALID');
    assertRole(role);
    if (!/^[0-9a-f]{64}$/i.test(identity.sha256)) throw registryError('engine artifact digest is invalid', 'INVALID');
    const digest = identity.sha256.toLowerCase();
    const entryDir = path.join(this.root, role, digest);
    const metadataPath = path.join(entryDir, 'artifact.json');
    let metadataBytes: Buffer;
    try {
      await Promise.all([
        assertRegularNonSymlink(metadataPath),
        assertDirectoryContained(this.containmentRoot, entryDir)
      ]);
      metadataBytes = await readBoundedFile(metadataPath, maximumEngineRegistryMetadataBytes, 'engine registry metadata');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw registryError(`immutable engine artifact is not registered: ${role}@${digest}`, 'MISSING');
      }
      throw error;
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(metadataBytes.toString('utf8')) as unknown;
    } catch {
      throw registryError(`engine registry metadata is corrupt: ${role}@${digest}`, 'CORRUPT');
    }
    if (!validMetadata(metadata) || metadata.role !== role || metadata.sha256 !== digest) {
      throw registryError(`engine registry metadata failed identity verification: ${role}@${digest}`, 'CORRUPT');
    }
    const artifactPath = path.join(entryDir, metadata.fileName);
    await assertDirectoryContained(this.containmentRoot, path.dirname(artifactPath));
    const artifact = await openRegularNonSymlink(artifactPath, 'engine registry artifact');
    let verified: { bytes: number; sha256: string };
    try {
      verified = await hashOpenFile(artifact, {
        label: `engine registry entry failed identity verification: ${role}@${digest}`,
        expectedBytes: metadata.bytes
      });
    } finally {
      await artifact.close();
    }
    if (verified.sha256 !== digest) {
      throw registryError(`engine registry entry failed identity verification: ${role}@${digest}`, 'CORRUPT');
    }
    if (identity.fileName && safeFileName(identity.fileName) !== metadata.fileName) {
      throw registryError(`engine artifact fileName does not match registry metadata: ${role}@${digest}`, 'CORRUPT');
    }
    return {
      identity: { sha256: digest, role, fileName: metadata.fileName, dependencies: identity.dependencies },
      path: artifactPath,
      bytes: verified.bytes
    };
  }

  /** Copy a verified registry entry into a fresh private execution directory. */
  async stageForExecution(identity: EngineArtifactIdentity, destinationDir: string): Promise<ResolvedEngineArtifact> {
    const role = identity.role;
    if (!role || !this.executionAuthorizations.has(authorizationKey(role, identity.sha256))) {
      throw registryError('engine artifact is not authorized for execution by this registry instance; register trusted input first', 'INVALID');
    }
    const resolved = await this.resolve(identity);
    await fs.promises.mkdir(destinationDir, { recursive: true });
    const target = path.join(destinationDir, safeFileName(resolved.identity.fileName ?? 'engine.bin'));
    let source: fs.promises.FileHandle | undefined;
    let destination: fs.promises.FileHandle | undefined;
    try {
      source = await openRegularNonSymlink(resolved.path, 'engine registry artifact');
      destination = await fs.promises.open(target, 'wx', 0o444);
      const copied = await copyAndHashOpenFile(source, destination, {
        label: 'engine registry artifact during staging',
        expectedBytes: resolved.bytes
      });
      if (copied.sha256 !== resolved.identity.sha256) {
        throw registryError('engine registry artifact changed during staging', 'CORRUPT');
      }
      await destination.sync();
      await destination.close();
      destination = undefined;
      await source.close();
      source = undefined;
      const staged = await openRegularNonSymlink(target, 'staged engine artifact');
      try {
        const verified = await hashOpenFile(staged, {
          label: 'staged engine artifact',
          expectedBytes: copied.bytes
        });
        if (verified.sha256 !== resolved.identity.sha256) {
          throw registryError('staged engine artifact identity mismatch', 'CORRUPT');
        }
      } finally {
        await staged.close();
      }
      await fs.promises.chmod(target, 0o444).catch(() => undefined);
      return { ...resolved, path: target };
    } catch (error) {
      await destination?.close().catch(() => undefined);
      destination = undefined;
      await source?.close().catch(() => undefined);
      source = undefined;
      await fs.promises.rm(target, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await destination?.close().catch(() => undefined);
      await source?.close().catch(() => undefined);
    }
  }

  private async prepareRoleDirectory(role: string): Promise<void> {
    const roleDir = path.join(this.root, role);
    await ensureContainedDirectoryTree(this.containmentRoot, this.root);
    await mkdirOne(roleDir);
    await assertDirectoryContained(this.containmentRoot, roleDir);
  }

  private async publishTempEntry(
    role: string,
    safeName: string,
    tempDir: string,
    digest: string,
    bytes: number
  ): Promise<ResolvedEngineArtifact> {
    const finalDir = path.join(this.root, role, digest);
    const artifactPath = path.join(tempDir, safeName);
    const metadataPath = path.join(tempDir, 'artifact.json');
    const metadata: RegistryMetadata = {
      schemaRevision: engineArtifactRegistrySchemaRevision,
      role,
      sha256: digest,
      bytes,
      fileName: safeName,
      retentionPolicy: engineArtifactRetentionPolicy
    };
    const serializedMetadata = Buffer.from(`${canonicalJson(metadata as unknown as CanonicalJson)}\n`, 'utf8');
    if (serializedMetadata.byteLength > maximumEngineRegistryMetadataBytes) {
      throw registryError('engine registry metadata exceeds its hard limit', 'INVALID');
    }
    await fs.promises.writeFile(metadataPath, serializedMetadata, { flag: 'wx', mode: 0o444 });
    await fs.promises.chmod(artifactPath, 0o444).catch(() => undefined);
    await fs.promises.chmod(metadataPath, 0o444).catch(() => undefined);
    try {
      await fs.promises.rename(tempDir, finalDir);
      await assertDirectoryContained(this.containmentRoot, finalDir);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // A concurrent writer may have won. Its complete entry is independently verified below.
    }
    return await this.resolve({ sha256: digest, role });
  }
}

export function workspaceEngineRegistryRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.co', 'engine-registry');
}

function validMetadata(value: unknown): value is RegistryMetadata {
  if (!isRecord(value)) return false;
  const allowed = new Set(['schemaRevision', 'role', 'sha256', 'bytes', 'fileName', 'retentionPolicy']);
  return Object.keys(value).every((key) => allowed.has(key))
    && value.schemaRevision === engineArtifactRegistrySchemaRevision
    && typeof value.role === 'string' && validRole(value.role)
    && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0
    && (value.bytes as number) <= maximumEngineArtifactBytes
    && typeof value.fileName === 'string' && safeFileName(value.fileName) === value.fileName
    && value.retentionPolicy === engineArtifactRetentionPolicy;
}

interface StreamArtifactOptions {
  label: string;
  expectedBytes?: number;
}

async function hashOpenFile(
  file: fs.promises.FileHandle,
  options: StreamArtifactOptions
): Promise<{ bytes: number; sha256: string }> {
  const before = await stableFileStat(file, options);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(streamBufferBytes);
  let offset = 0;
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    assertArtifactSize(offset, options.label, 'CORRUPT');
    hash.update(buffer.subarray(0, bytesRead));
  }
  await assertUnchangedOpenFile(file, before, offset, options);
  return { bytes: offset, sha256: hash.digest('hex') };
}

async function copyAndHashOpenFile(
  source: fs.promises.FileHandle,
  destination: fs.promises.FileHandle,
  options: StreamArtifactOptions
): Promise<{ bytes: number; sha256: string }> {
  const before = await stableFileStat(source, options);
  const destinationBefore = await destination.stat();
  if (!destinationBefore.isFile() || destinationBefore.size !== 0) {
    throw registryError(`${options.label} staging target is not a fresh regular file`, 'CORRUPT');
  }
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(streamBufferBytes);
  let offset = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, offset);
    if (bytesRead === 0) break;
    const nextOffset = offset + bytesRead;
    assertArtifactSize(nextOffset, options.label, 'CORRUPT');
    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written, offset + written);
      if (result.bytesWritten === 0) throw registryError(`${options.label} staging write made no progress`, 'CORRUPT');
      written += result.bytesWritten;
    }
    offset = nextOffset;
  }
  await assertUnchangedOpenFile(source, before, offset, options);
  const destinationAfter = await destination.stat();
  if (!destinationAfter.isFile() || destinationAfter.size !== offset) {
    throw registryError(`${options.label} staging target size mismatch`, 'CORRUPT');
  }
  return { bytes: offset, sha256: hash.digest('hex') };
}

async function stableFileStat(
  file: fs.promises.FileHandle,
  options: StreamArtifactOptions
): Promise<fs.Stats> {
  const stat = await file.stat();
  if (!stat.isFile()) throw registryError(`${options.label} is not a regular file`, 'CORRUPT');
  assertArtifactSize(stat.size, options.label, 'CORRUPT');
  if (options.expectedBytes !== undefined && stat.size !== options.expectedBytes) {
    throw registryError(`${options.label} size mismatch: expected ${options.expectedBytes}, got ${stat.size}`, 'CORRUPT');
  }
  return stat;
}

async function assertUnchangedOpenFile(
  file: fs.promises.FileHandle,
  before: fs.Stats,
  bytesRead: number,
  options: StreamArtifactOptions
): Promise<void> {
  const after = await file.stat();
  if (!after.isFile()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
    || bytesRead !== before.size) {
    throw registryError(`${options.label} changed while it was being read`, 'CORRUPT');
  }
}

async function readBoundedFile(file: string, maximumBytes: number, label: string): Promise<Buffer> {
  const handle = await openRegularNonSymlink(file, label);
  try {
    const before = await handle.stat();
    if (before.size > maximumBytes) {
      throw registryError(`${label} size ${before.size} exceeds the hard limit ${maximumBytes}`, 'CORRUPT');
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const extraRead = await handle.read(extra, 0, 1, offset);
    await assertUnchangedOpenFile(handle, before, offset, { label, expectedBytes: before.size });
    if (offset !== before.size || extraRead.bytesRead !== 0) {
      throw registryError(`${label} changed while it was being read`, 'CORRUPT');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function openRegularNonSymlink(file: string, label: string): Promise<fs.promises.FileHandle> {
  const before = await fs.promises.lstat(file);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw registryError(`${label} is not a regular non-symlink file: ${file}`, 'CORRUPT');
  }
  const handle = await fs.promises.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw registryError(`${label} changed while it was being opened`, 'CORRUPT');
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function assertArtifactSize(
  bytes: number,
  label: string,
  code: 'INVALID' | 'CORRUPT' = 'INVALID'
): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximumEngineArtifactBytes) {
    throw registryError(`${label} size ${bytes} exceeds the hard limit ${maximumEngineArtifactBytes}`, code);
  }
}

function authorizationKey(role: string, digest: string): string {
  return `${role}@${digest.toLowerCase()}`;
}

async function assertRegularNonSymlink(file: string): Promise<void> {
  const stat = await fs.promises.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw registryError(`registry path is not a regular non-symlink file: ${file}`, 'CORRUPT');
}

async function assertDirectoryContained(rootDir: string, candidateDir: string): Promise<void> {
  const lexicalRoot = path.resolve(rootDir);
  const lexicalCandidate = path.resolve(candidateDir);
  const lexicalRelative = path.relative(lexicalRoot, lexicalCandidate);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw registryError('engine registry lexical path escapes its configured root', 'CORRUPT');
  }
  const rootStat = await fs.promises.stat(lexicalRoot);
  if (!rootStat.isDirectory()) {
    throw registryError('engine registry containment root is not a directory', 'CORRUPT');
  }
  let lexicalCursor = lexicalRoot;
  for (const part of lexicalRelative.split(path.sep).filter(Boolean)) {
    lexicalCursor = path.join(lexicalCursor, part);
    if ((await fs.promises.lstat(lexicalCursor)).isSymbolicLink()) {
      throw registryError('engine registry contains a symlinked directory', 'CORRUPT');
    }
  }
  const [root, candidate] = await Promise.all([fs.promises.realpath(lexicalRoot), fs.promises.realpath(lexicalCandidate)]);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw registryError('engine registry path escapes its configured root', 'CORRUPT');
  }
}

/** Create each registry component only after validating the already-existing prefix. */
async function ensureContainedDirectoryTree(containmentRoot: string, targetDir: string): Promise<void> {
  const lexicalRoot = path.resolve(containmentRoot);
  const lexicalTarget = path.resolve(targetDir);
  const relative = path.relative(lexicalRoot, lexicalTarget);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw registryError('engine registry root must be a child of its containment root', 'CORRUPT');
  }
  const rootStat = await fs.promises.stat(lexicalRoot);
  if (!rootStat.isDirectory()) {
    throw registryError('engine registry containment root is not a directory', 'CORRUPT');
  }
  const realRoot = await fs.promises.realpath(lexicalRoot);
  let cursor = lexicalRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    await mkdirOne(cursor);
    const stat = await fs.promises.lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw registryError('engine registry path contains a symlink/junction or non-directory', 'CORRUPT');
    }
    const realCursor = await fs.promises.realpath(cursor);
    const realRelative = path.relative(realRoot, realCursor);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw registryError('engine registry path escapes its workspace containment root', 'CORRUPT');
    }
  }
}

async function mkdirOne(directory: string): Promise<void> {
  try {
    await fs.promises.mkdir(directory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function registryError(message: string, code: 'MISSING' | 'INVALID' | 'CORRUPT'): Error {
  const error = new Error(message) as Error & { registryCode?: string };
  error.registryCode = code;
  return error;
}

function isMissingRegistryEntry(error: unknown): boolean {
  return (error as { registryCode?: string } | undefined)?.registryCode === 'MISSING';
}

function assertRole(role: string): void {
  if (!validRole(role)) throw registryError(`invalid engine artifact role: ${JSON.stringify(role)}`, 'INVALID');
}

function validRole(role: string): boolean { return /^[a-z0-9][a-z0-9._-]{0,95}$/.test(role); }

function safeFileName(fileName: string): string {
  const base = path.basename(fileName);
  if (!base || base === '.' || base === '..' || base !== fileName || /[\\/\0<>:"|?*\x00-\x1f]/.test(fileName)) {
    throw registryError(`invalid engine artifact fileName: ${JSON.stringify(fileName)}`, 'INVALID');
  }
  return base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
