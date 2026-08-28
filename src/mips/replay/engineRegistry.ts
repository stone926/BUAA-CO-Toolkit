// @index mips-replay — role+digest immutable engine artifact registry（原子写、containment、无自动过期）
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { EngineArtifactIdentity } from '../providers/contracts';
import { canonicalJson, sha256Bytes, type CanonicalJson } from './canonical';
import { builtinExecutionEngineArtifact } from './builtinEngineArtifact';
import { builtinAssemblerEngineArtifact } from './builtinAssemblerEngineArtifact';

export const engineArtifactRegistrySchemaRevision = 1;
export const engineArtifactTrustManifestSchemaRevision = 1;
export const maximumEngineArtifactBytes = 256 * 1024 * 1024;
export const maximumEngineRegistryMetadataBytes = 16 * 1024;
const streamBufferBytes = 1024 * 1024;

/**
 * Artifacts are retained indefinitely because a case may outlive the workspace that created it.
 * No time-based eviction is permitted. A future explicit GC must first build a complete live
 * role+digest set by scanning every retained case manifest.
 */
export const engineArtifactRetentionPolicy = 'retain-until-explicit-live-manifest-gc' as const;

/**
 * A trust manifest is application input, not registry metadata. The current production root is
 * compiled into the extension. A future dynamic receipt API must verify a signature before adding
 * an identity; a workspace file must never gain authority merely by being adjacent to a case.
 */
export interface EngineArtifactTrustManifest {
  schemaRevision: typeof engineArtifactTrustManifestSchemaRevision;
  authority: string;
  revision: string;
  artifacts: readonly EngineArtifactTrustEntry[];
}

export interface EngineArtifactTrustEntry {
  role: string;
  sha256: string;
  bytes: number;
  /** Omit only for a digest alias whose source may legitimately have been renamed by the user. */
  fileName?: string;
}

/**
 * Release-reviewed identities compiled into the shipped JavaScript. This is the persistent trust
 * root used by a fresh process; registry-local `artifact.json` files are deliberately not one.
 *
 * The `user-configured-mars` aliases let an archived case remain replayable when the configured
 * file was one of the reviewed releases, even if that file had a local basename. Exact bytes and
 * byte count are still checked on every resolve and every private staging copy.
 */
const applicationOwnedBuiltinArtifacts = Object.freeze([
  builtinAssemblerEngineArtifact(),
  builtinExecutionEngineArtifact()
]);

export const fixedReferenceEngineArtifactTrustManifest: Readonly<EngineArtifactTrustManifest> = Object.freeze({
  schemaRevision: engineArtifactTrustManifestSchemaRevision,
  authority: 'stone926/Mars-with-BUAA-CO-extension releases + BUAA-CO-Toolkit packaged runtime',
  revision: '2026-08-26',
  artifacts: Object.freeze([
    Object.freeze({
      role: 'mars-assembler-v0.6.3',
      sha256: '599957c96b4e94c267a117d548eb5a1bd32d72d879a831a5f695a648c1eafb31',
      bytes: 3_544_465,
      fileName: 'Mars_CO_v0.6.3.jar'
    }),
    Object.freeze({
      role: 'user-configured-mars',
      sha256: '599957c96b4e94c267a117d548eb5a1bd32d72d879a831a5f695a648c1eafb31',
      bytes: 3_544_465
    }),
    Object.freeze({
      role: 'legacy-course-executor',
      sha256: 'd134564d4512f192f7d583491da1ecd13810a4252d672ddaedd6ac7042e80c64',
      bytes: 3_599_004,
      fileName: 'Mars_CO_v0.6.3-course1.jar'
    }),
    Object.freeze({
      role: 'user-configured-mars',
      sha256: 'd134564d4512f192f7d583491da1ecd13810a4252d672ddaedd6ac7042e80c64',
      bytes: 3_599_004
    }),
    Object.freeze({
      role: 'mars-p7-ri-instruction-class',
      sha256: '2add0891caacf2f29c683a6afedd859891bceeb22937174f8480b4390ba125f6',
      bytes: 891,
      fileName: '_co_internal_unknown_instruction.class'
    }),
    ...applicationOwnedBuiltinArtifacts.map((artifact) => Object.freeze({
      role: artifact.identity.role!,
      sha256: artifact.identity.sha256,
      bytes: artifact.bytes.byteLength,
      fileName: artifact.identity.fileName!
    }))
  ])
});

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
  private readonly persistentTrust: ReadonlyMap<string, TrustedExecutionIdentity>;

  constructor(
    readonly root: string,
    /** Trusted lexical anchor. Production passes the workspace root. */
    readonly containmentRoot: string = path.dirname(path.resolve(root))
  ) {
    this.persistentTrust = buildPersistentTrust([fixedReferenceEngineArtifactTrustManifest]);
  }

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
    // Logical builtin artifacts are application-owned and reproducible from the
    // compiled revision tuple. Materialize the current tuple for pre-fix cases
    // that recorded its identity before the registry write was wired in.
    const applicationOwned = applicationOwnedBuiltinArtifacts.find((artifact) =>
      artifact.identity.role === identity.role
      && artifact.identity.sha256 === identity.sha256.toLowerCase());
    if (applicationOwned) {
      await this.registerBytes(
        applicationOwned.identity.role!,
        applicationOwned.bytes,
        applicationOwned.identity.fileName!
      );
    }
    const role = identity.role;
    const key = role ? authorizationKey(role, identity.sha256) : '';
    const sessionAuthorized = Boolean(role && this.executionAuthorizations.has(key));
    const persistentAuthorization = role ? this.persistentTrust.get(key) : undefined;
    if (!sessionAuthorized && !persistentAuthorization) {
      throw registryError(
        'engine artifact is not authorized for execution; register trusted input in this session or use a fixed application-owned trust identity',
        'INVALID'
      );
    }
    const resolved = await this.resolve(identity);
    if (!sessionAuthorized && persistentAuthorization) {
      assertPersistentAuthorization(resolved, persistentAuthorization);
    }
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

interface TrustedExecutionIdentity extends EngineArtifactTrustEntry {
  authority: string;
  revision: string;
}

function buildPersistentTrust(
  manifests: readonly EngineArtifactTrustManifest[]
): ReadonlyMap<string, TrustedExecutionIdentity> {
  const trust = new Map<string, TrustedExecutionIdentity>();
  for (const manifest of manifests) {
    assertTrustManifest(manifest);
    for (const artifact of manifest.artifacts) {
      const key = authorizationKey(artifact.role, artifact.sha256);
      if (trust.has(key)) {
        throw registryError(`duplicate engine trust identity: ${key}`, 'INVALID');
      }
      trust.set(key, Object.freeze({
        role: artifact.role,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        ...(artifact.fileName === undefined ? {} : { fileName: artifact.fileName }),
        authority: manifest.authority,
        revision: manifest.revision
      }));
    }
  }
  return trust;
}

function assertTrustManifest(manifest: EngineArtifactTrustManifest): void {
  if (!isRecord(manifest)) throw registryError('engine artifact trust manifest must be an object', 'INVALID');
  const allowedManifestKeys = new Set(['schemaRevision', 'authority', 'revision', 'artifacts']);
  if (!Object.keys(manifest).every((key) => allowedManifestKeys.has(key))
    || manifest.schemaRevision !== engineArtifactTrustManifestSchemaRevision
    || !validTrustLabel(manifest.authority)
    || !validTrustLabel(manifest.revision)
    || !Array.isArray(manifest.artifacts)
    || manifest.artifacts.length === 0
    || manifest.artifacts.length > 1_024) {
    throw registryError('engine artifact trust manifest failed schema validation', 'INVALID');
  }
  for (const artifact of manifest.artifacts) {
    if (!isRecord(artifact)) throw registryError('engine artifact trust entry must be an object', 'INVALID');
    const allowedArtifactKeys = new Set(['role', 'sha256', 'bytes', 'fileName']);
    if (!Object.keys(artifact).every((key) => allowedArtifactKeys.has(key))
      || typeof artifact.role !== 'string' || !validRole(artifact.role)
      || typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.bytes) || (artifact.bytes as number) <= 0
      || (artifact.bytes as number) > maximumEngineArtifactBytes
      || (artifact.fileName !== undefined
        && (typeof artifact.fileName !== 'string' || safeFileName(artifact.fileName) !== artifact.fileName))) {
      throw registryError('engine artifact trust entry failed schema validation', 'INVALID');
    }
  }
}

function validTrustLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function assertPersistentAuthorization(
  resolved: ResolvedEngineArtifact,
  authorization: TrustedExecutionIdentity
): void {
  if (resolved.bytes !== authorization.bytes
    || resolved.identity.role !== authorization.role
    || resolved.identity.sha256 !== authorization.sha256
    || (authorization.fileName !== undefined && resolved.identity.fileName !== authorization.fileName)) {
    throw registryError(
      `engine registry entry does not match persistent trust ${authorization.authority}@${authorization.revision}`,
      'CORRUPT'
    );
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
