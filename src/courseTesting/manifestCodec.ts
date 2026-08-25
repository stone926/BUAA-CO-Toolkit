// @index course-testing — ASM case manifest v1/v2 codec：v1 只读兼容、v2 新写、case-relative 路径
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import {
  AsmCaseArtifactKind,
  AsmCaseArtifacts,
  AsmCaseMachineCode,
  AsmCaseManifest,
  AsmCaseP7Metadata,
  AsmCaseSource,
  AsmCaseStdinSnapshot,
  AsmCaseSnapshot
} from '../asmCaseStoreCore';

/**
 * Manifest v2（计划第 5.8 节）。v1 永久只读兼容；新 case 默认写 v2。
 * 路径约定：artifact 值为 case-relative（相对 case 目录）；绝对原始路径仅作
 * provenance（originalAsmPath / stdin.originalPath / asmSnapshot.path 保留）。
 */

export const asmCaseManifestVersion2 = 2;

/** Serialized engine descriptor (subset of EngineDescriptor, stable across builds). */
export interface ManifestEngineInfo {
  id: string;
  build?: string;
  semanticsRevision: number;
  capabilitiesRevision: number;
  /** Immutable artifact identity; role is resolved by an engine registry. */
  artifact?: {
    sha256: string;
    role?: string;
    fileName?: string;
  };
  /** Process-level provenance; present only for engines that spawn a process. */
  legacyProvenance?: {
    commandLine?: string;
    cwd?: string;
    memoryConfiguration?: string;
  };
}

/** New v2 writes use hashed refs; strings remain readable for early v2 drafts. */
export type ManifestArtifactReference = AsmCaseSnapshot | string;

export interface AsmCaseArtifactsV2 {
  source?: Record<string, ManifestArtifactReference>;
  program?: Record<string, ManifestArtifactReference>;
  oracle?: Record<string, ManifestArtifactReference>;
  dut?: Record<string, ManifestArtifactReference>;
  referenceMars?: Record<string, ManifestArtifactReference>;
}

/** Exact inputs that affect one oracle run; optional fields are absent only before execution. */
export interface ManifestRunConfiguration {
  profile: string;
  memoryConfiguration: string;
  courseTrace?: boolean;
  traceLevel?: 1 | 2;
  maxSteps?: number;
  haltPc?: number;
  interruptSchedule?: number[];
  stdinSha256?: string;
}

export interface AsmCaseManifestV2 {
  version: typeof asmCaseManifestVersion2;
  caseId: string;
  createdAt: string;
  profile: string;
  originalAsmPath: string;
  asmSnapshot: AsmCaseSnapshot;
  source: AsmCaseSource;
  stdin?: AsmCaseStdinSnapshot;
  p7?: AsmCaseP7Metadata;
  program: {
    assembler: ManifestEngineInfo;
    /** Content fingerprint of the program image (legacy: machine-code sha256). */
    imageFingerprint?: string;
    machineCode?: AsmCaseMachineCode;
    /** Hashed case-relative map; strings remain readable for early v2 drafts. */
    sourceMap?: ManifestArtifactReference;
  };
  oracle: {
    engine: ManifestEngineInfo;
    configurationHash: string;
    runConfiguration?: ManifestRunConfiguration;
    stopReason: 'halt-loop' | 'step-limit' | 'error' | 'unknown';
    steps?: number;
    finalStateDigest?: string;
  };
  artifacts?: AsmCaseArtifactsV2;
  /** Non-file provenance/configuration; never interpreted as a bundle path. */
  metadata?: Record<string, string>;
}

export type AsmCaseManifestUnion = AsmCaseManifest | AsmCaseManifestV2;

// ── Classification ────────────────────────────────────────────────────────────

export function isManifestV2(manifest: AsmCaseManifestUnion): manifest is AsmCaseManifestV2 {
  return manifest.version === asmCaseManifestVersion2;
}

/** Accept only structurally complete manifests that are safe to expose as the typed union. */
export function isKnownManifest(manifest: unknown): manifest is AsmCaseManifestUnion {
  if (!isRecord(manifest)) {
    return false;
  }
  if (!hasCommonManifestFields(manifest)) {
    return false;
  }
  if (manifest.version === 1) {
    return isOptionalMachineCode(manifest.machineCode)
      && isOptionalMarsRun(manifest.mars)
      && isOptionalArtifactGroups(manifest.artifacts);
  }
  if (manifest.version === asmCaseManifestVersion2) {
    if (!isRecord(manifest.program) || !isRecord(manifest.oracle)) {
      return false;
    }
    const stopReasons = new Set(['halt-loop', 'step-limit', 'error', 'unknown']);
    return hasOnlyKeys(manifest, [
      'version', 'caseId', 'createdAt', 'profile', 'originalAsmPath', 'asmSnapshot',
      'source', 'stdin', 'p7', 'program', 'oracle', 'artifacts', 'metadata'
    ])
      && hasOnlyKeys(manifest.program, ['assembler', 'imageFingerprint', 'machineCode', 'sourceMap'])
      && hasOnlyKeys(manifest.oracle, [
        'engine', 'configurationHash', 'runConfiguration', 'stopReason', 'steps', 'finalStateDigest'
      ])
      && isEngineInfo(manifest.program.assembler)
      && (manifest.program.imageFingerprint === undefined || isNonEmptyString(manifest.program.imageFingerprint))
      && isOptionalMachineCode(manifest.program.machineCode)
      && (
        manifest.program.sourceMap === undefined
        || isNonEmptyString(manifest.program.sourceMap)
        || isSnapshot(manifest.program.sourceMap)
      )
      && isEngineInfo(manifest.oracle.engine)
      && isSha256(manifest.oracle.configurationHash)
      && (manifest.oracle.runConfiguration === undefined || isRunConfiguration(manifest.oracle.runConfiguration))
      && stopReasons.has(manifest.oracle.stopReason as string)
      && (manifest.oracle.steps === undefined || isNonNegativeInteger(manifest.oracle.steps))
      && (manifest.oracle.finalStateDigest === undefined || isNonEmptyString(manifest.oracle.finalStateDigest))
      && isOptionalV2ArtifactGroups(manifest.artifacts)
      && isOptionalStringMap(manifest.metadata);
  }
  return false;
}

function hasCommonManifestFields(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.caseId)
    && isNonEmptyString(value.createdAt)
    && Number.isFinite(Date.parse(value.createdAt))
    && isNonEmptyString(value.profile)
    && isNonEmptyString(value.originalAsmPath)
    && isSnapshot(value.asmSnapshot)
    && isSource(value.source)
    && (value.stdin === undefined || isStdinSnapshot(value.stdin))
    && (value.p7 === undefined || isP7Metadata(value.p7));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

function isRunConfiguration(value: unknown): value is ManifestRunConfiguration {
  if (!isRecord(value)) {
    return false;
  }
  return hasOnlyKeys(value, [
    'profile', 'memoryConfiguration', 'courseTrace', 'traceLevel', 'maxSteps',
    'haltPc', 'interruptSchedule', 'stdinSha256'
  ])
    && isNonEmptyString(value.profile)
    && isNonEmptyString(value.memoryConfiguration)
    && (value.courseTrace === undefined || typeof value.courseTrace === 'boolean')
    && (value.traceLevel === undefined || value.traceLevel === 1 || value.traceLevel === 2)
    && (value.maxSteps === undefined || (Number.isSafeInteger(value.maxSteps) && (value.maxSteps as number) > 0))
    && (value.haltPc === undefined || isUint32(value.haltPc))
    && (value.interruptSchedule === undefined || (
      Array.isArray(value.interruptSchedule)
      && value.interruptSchedule.every((pc) => isUint32(pc))
    ))
    && (value.stdinSha256 === undefined || isSha256(value.stdinSha256));
}

function isSnapshot(value: unknown, extraKeys: readonly string[] = []): value is AsmCaseSnapshot {
  return isRecord(value)
    && hasOnlyKeys(value, ['path', 'sha256', 'bytes', ...extraKeys])
    && isNonEmptyString(value.path)
    && isSha256(value.sha256)
    && isNonNegativeInteger(value.bytes);
}

function isOptionalMachineCode(value: unknown): boolean {
  return value === undefined || (
    isSnapshot(value, ['wordCount', 'haltPc'])
    && isNonNegativeInteger((value as unknown as Record<string, unknown>).wordCount)
    && (
      (value as unknown as Record<string, unknown>).haltPc === undefined
      || isUint32((value as unknown as Record<string, unknown>).haltPc)
    )
  );
}

function isStdinSnapshot(value: unknown): value is AsmCaseStdinSnapshot {
  return isSnapshot(value, ['originalPath'])
    && isNonEmptyString((value as unknown as Record<string, unknown>).originalPath);
}

function isP7Metadata(value: unknown): value is AsmCaseP7Metadata {
  if (!isRecord(value)) {
    return false;
  }
  return hasOnlyKeys(value, ['interruptSchedule', 'probe'])
    && (value.interruptSchedule === undefined || (
      Array.isArray(value.interruptSchedule)
      && value.interruptSchedule.every((pc) => isUint32(pc))
    ))
    && (value.probe === undefined || isRecord(value.probe));
}

function isSource(value: unknown): value is AsmCaseSource {
  if (!isRecord(value) || !['selected', 'generator', 'builtin'].includes(value.kind as string)) {
    return false;
  }
  return hasOnlyKeys(value, ['kind', 'generator', 'commandLine', 'cwd'])
    && (value.generator === undefined || typeof value.generator === 'string')
    && (value.commandLine === undefined || typeof value.commandLine === 'string')
    && (value.cwd === undefined || typeof value.cwd === 'string');
}

function isEngineInfo(value: unknown): value is ManifestEngineInfo {
  if (!isRecord(value)) {
    return false;
  }
  return hasOnlyKeys(value, [
    'id', 'build', 'semanticsRevision', 'capabilitiesRevision', 'artifact', 'legacyProvenance'
  ])
    && isNonEmptyString(value.id)
    && (value.build === undefined || typeof value.build === 'string')
    && isNonNegativeInteger(value.semanticsRevision)
    && isNonNegativeInteger(value.capabilitiesRevision)
    && (value.artifact === undefined || (
      isRecord(value.artifact)
      && hasOnlyKeys(value.artifact, ['sha256', 'role', 'fileName'])
      && isSha256(value.artifact.sha256)
      && (value.artifact.role === undefined || typeof value.artifact.role === 'string')
      && (value.artifact.fileName === undefined || typeof value.artifact.fileName === 'string')
    ))
    && (value.legacyProvenance === undefined || (
      isRecord(value.legacyProvenance)
      && hasOnlyKeys(value.legacyProvenance, ['commandLine', 'cwd', 'memoryConfiguration'])
      && (value.legacyProvenance.commandLine === undefined || typeof value.legacyProvenance.commandLine === 'string')
      && (value.legacyProvenance.cwd === undefined || typeof value.legacyProvenance.cwd === 'string')
      && (value.legacyProvenance.memoryConfiguration === undefined || typeof value.legacyProvenance.memoryConfiguration === 'string')
    ));
}

function isOptionalMarsRun(value: unknown): boolean {
  return value === undefined || (
    isRecord(value)
    && isNonEmptyString(value.commandLine)
    && isNonEmptyString(value.cwd)
    && isNonEmptyString(value.memoryConfiguration)
  );
}

function isOptionalArtifactGroups(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return isRecord(value) && Object.values(value).every((group) =>
    group === undefined || (isRecord(group) && Object.values(group).every((item) => typeof item === 'string'))
  );
}

function isOptionalV2ArtifactGroups(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  const allowedGroups = new Set(['source', 'program', 'oracle', 'dut', 'referenceMars']);
  return isRecord(value)
    && Object.keys(value).every((group) => allowedGroups.has(group))
    && Object.values(value).every((group) =>
    group === undefined || (
      isRecord(group)
      && Object.keys(group).every(isManifestMapKey)
      && Object.values(group).every((item) => isNonEmptyString(item) || isSnapshot(item))
    )
  );
}

function isOptionalStringMap(value: unknown): boolean {
  return value === undefined || (
    isRecord(value)
    && Object.keys(value).every(isManifestMapKey)
    && Object.values(value).every(isNonEmptyString)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isManifestMapKey(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    && value !== '__proto__'
    && value !== 'prototype'
    && value !== 'constructor';
}

// ── Normalized field views (v1 and v2) ───────────────────────────────────────

export function manifestSourceOf(manifest: AsmCaseManifestUnion): AsmCaseSource {
  return manifest.source;
}

export function manifestMachineCodeOf(manifest: AsmCaseManifestUnion): AsmCaseMachineCode | undefined {
  return isManifestV2(manifest) ? manifest.program.machineCode : manifest.machineCode;
}

export function manifestP7Of(manifest: AsmCaseManifestUnion): AsmCaseP7Metadata | undefined {
  return manifest.p7;
}

/**
 * v1-shaped artifacts view for renderers and readers. v2 groups map back:
 * oracle -> mars, dut -> verilog/logisim (by key prefix), source -> source.
 */
export function manifestArtifactsOf(manifest: AsmCaseManifestUnion): AsmCaseArtifacts {
  if (!isManifestV2(manifest)) {
    return manifest.artifacts ?? {};
  }
  const result: AsmCaseArtifacts = {};
  const artifacts = manifest.artifacts ?? {};
  if (artifacts.source) {
    result.source = artifactPathMap(artifacts.source);
  }
  if (artifacts.program) {
    result.program = artifactPathMap(artifacts.program);
  }
  if (artifacts.oracle) {
    result.mars = artifactPathMap(artifacts.oracle);
  }
  if (artifacts.referenceMars) {
    result.referenceMars = artifactPathMap(artifacts.referenceMars);
  }
  if (artifacts.dut) {
    result.verilog = {};
    result.logisim = {};
    for (const [name, reference] of Object.entries(artifacts.dut)) {
      const value = artifactPath(reference);
      if (name.startsWith('verilog/')) {
        result.verilog[name.slice('verilog/'.length)] = value;
      } else if (name.startsWith('logisim/')) {
        result.logisim[name.slice('logisim/'.length)] = value;
      } else {
        result.verilog[name] = value;
      }
    }
  }
  return result;
}

function artifactPathMap(group: Record<string, ManifestArtifactReference>): Record<string, string> {
  return Object.fromEntries(Object.entries(group).map(([name, reference]) => [name, artifactPath(reference)]));
}

function artifactPath(reference: ManifestArtifactReference): string {
  return typeof reference === 'string' ? reference : reference.path;
}

/** Map a v1 artifact kind/name pair to the v2 group and key. */
export function v2ArtifactGroup(
  kind: AsmCaseArtifactKind,
  name: string
): { group: keyof AsmCaseArtifactsV2; key: string } {
  switch (kind) {
    case 'mars':
      return { group: 'oracle', key: name };
    case 'source':
      return { group: 'source', key: name };
    case 'verilog':
      return { group: 'dut', key: `verilog/${name}` };
    case 'logisim':
      return { group: 'dut', key: `logisim/${name}` };
  }
}

/** Stable digest of every engine/configuration field that can affect one run. */
export function manifestRunConfigurationHash(
  configuration: ManifestRunConfiguration,
  engine: ManifestEngineInfo
): string {
  const canonical = {
    engine: {
      id: engine.id,
      build: engine.build ?? null,
      semanticsRevision: engine.semanticsRevision,
      capabilitiesRevision: engine.capabilitiesRevision,
      artifactSha256: engine.artifact?.sha256 ?? null
    },
    profile: configuration.profile,
    memoryConfiguration: configuration.memoryConfiguration,
    courseTrace: configuration.courseTrace ?? false,
    traceLevel: configuration.traceLevel ?? null,
    maxSteps: configuration.maxSteps ?? null,
    haltPc: configuration.haltPc ?? null,
    interruptSchedule: configuration.interruptSchedule ?? [],
    stdinSha256: configuration.stdinSha256 ?? null
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/**
 * Minimum v2 replay-closure candidate check (计划 5.8). A clean result here is
 * necessary, but exact replay additionally requires the bundle verifier and a
 * registry entry for each immutable engine artifact.
 */
export function v2ReplayClosureIssues(manifest: AsmCaseManifestV2): string[] {
  const issues: string[] = [];
  if (!isKnownManifest(manifest) || !isManifestV2(manifest)) {
    issues.push('manifest v2 structure is invalid or contains unknown fields');
    return issues;
  }
  if (!isSha256(manifest.asmSnapshot?.sha256)) {
    issues.push('asmSnapshot.sha256 missing or invalid');
  }
  if (!isSafeCaseRelativePath(manifest.asmSnapshot?.path)) {
    issues.push('asmSnapshot.path must be a safe case-relative path');
  }
  if (!isSha256(manifest.program?.imageFingerprint)) {
    issues.push('program.imageFingerprint missing or invalid');
  }
  if (!manifest.program?.assembler?.id) {
    issues.push('program.assembler.id missing');
  }
  if (!isSha256(manifest.program?.assembler?.artifact?.sha256)) {
    issues.push('program.assembler.artifact.sha256 missing or invalid');
  }
  if (!isSha256(manifest.program?.machineCode?.sha256)) {
    issues.push('program.machineCode.sha256 missing or invalid (image not dumped yet)');
  }
  if (manifest.program?.machineCode && !isSafeCaseRelativePath(manifest.program.machineCode.path)) {
    issues.push('program.machineCode.path must be a safe case-relative path');
  }
  if (manifest.program?.machineCode?.sha256 && manifest.program.imageFingerprint !== manifest.program.machineCode.sha256) {
    issues.push('program.imageFingerprint does not match program.machineCode.sha256');
  }
  if (!manifest.oracle?.engine?.id) {
    issues.push('oracle.engine.id missing');
  }
  if (!isSha256(manifest.oracle?.engine?.artifact?.sha256)) {
    issues.push('oracle.engine.artifact.sha256 missing or invalid');
  }
  if (!isSha256(manifest.oracle?.configurationHash)) {
    issues.push('oracle.configurationHash missing or invalid');
  }
  if (!manifest.oracle?.runConfiguration) {
    issues.push('oracle.runConfiguration missing');
  } else {
    const configuration = manifest.oracle.runConfiguration;
    if (configuration.profile !== manifest.profile) {
      issues.push('oracle.runConfiguration.profile does not match manifest.profile');
    }
    if (configuration.stdinSha256 !== manifest.stdin?.sha256) {
      issues.push('oracle.runConfiguration.stdinSha256 does not match the stdin snapshot');
    }
    const manifestInterrupts = manifest.p7?.interruptSchedule ?? [];
    const configuredInterrupts = configuration.interruptSchedule ?? [];
    if (JSON.stringify(manifestInterrupts) !== JSON.stringify(configuredInterrupts)) {
      issues.push('oracle.runConfiguration.interruptSchedule does not match manifest.p7.interruptSchedule');
    }
    if (configuration.courseTrace && configuration.haltPc !== manifest.program.machineCode?.haltPc) {
      issues.push('oracle.runConfiguration.haltPc does not match the validated machine-code haltPc');
    }
    if (manifest.oracle.configurationHash !== manifestRunConfigurationHash(configuration, manifest.oracle.engine)) {
      issues.push('oracle.configurationHash does not match the engine/run configuration');
    }
  }
  if (manifest.oracle?.stopReason === 'unknown') {
    issues.push('oracle.stopReason is unknown (oracle not completed)');
  }
  if (manifest.stdin && !isSafeCaseRelativePath(manifest.stdin.path)) {
    issues.push('stdin.path must be a safe case-relative path');
  }
  if (manifest.p7?.probe !== undefined) {
    issues.push('manifest.p7.probe is not covered by a replay configuration fingerprint');
  }
  const replayUnboundMetadata = Object.keys(manifest.metadata ?? {}).filter((key) => !key.startsWith('source.'));
  if (replayUnboundMetadata.length) {
    issues.push(`metadata contains replay-unbound keys: ${replayUnboundMetadata.sort().join(', ')}`);
  }
  if (manifest.program.sourceMap) {
    const sourceMapPath = artifactPath(manifest.program.sourceMap);
    if (typeof manifest.program.sourceMap === 'string') {
      issues.push('program.sourceMap is an unhashed early-v2 reference');
    }
    if (!isSafeCaseRelativePath(sourceMapPath)) {
      issues.push('program.sourceMap must be a safe case-relative path');
    }
  }
  for (const [group, values] of Object.entries(manifest.artifacts ?? {})) {
    for (const [name, reference] of Object.entries(values ?? {}) as Array<[string, ManifestArtifactReference]>) {
      const value = artifactPath(reference);
      if (typeof reference === 'string') {
        issues.push(`artifacts.${group}.${name} is an unhashed early-v2 reference`);
      } else if (!isSnapshot(reference)) {
        issues.push(`artifacts.${group}.${name} has an invalid file fingerprint`);
      }
      if (!isSafeCaseRelativePath(value)) {
        issues.push(`artifacts.${group}.${name} is not case-relative`);
      }
    }
  }
  return issues;
}

/** Validate the replay bundle bytes in addition to the synchronous structural closure. */
export async function v2ReplayBundleIssues(manifest: AsmCaseManifestV2, caseDir: string): Promise<string[]> {
  const issues = v2ReplayClosureIssues(manifest);
  if (!isKnownManifest(manifest) || !isManifestV2(manifest)) {
    return issues;
  }
  await verifySnapshot(caseDir, 'asmSnapshot', manifest.asmSnapshot, issues);
  await flagUncapturedIncludeGraph(caseDir, manifest.asmSnapshot, issues);
  if (manifest.program.machineCode) {
    await verifySnapshot(caseDir, 'program.machineCode', manifest.program.machineCode, issues);
  }
  if (manifest.stdin) {
    await verifySnapshot(caseDir, 'stdin', manifest.stdin, issues);
  }
  if (manifest.program.sourceMap && typeof manifest.program.sourceMap !== 'string'
    && isSafeCaseRelativePath(manifest.program.sourceMap.path)) {
    await verifySnapshot(caseDir, 'program.sourceMap', manifest.program.sourceMap, issues);
  }
  for (const [group, values] of Object.entries(manifest.artifacts ?? {})) {
    for (const [name, reference] of Object.entries(values ?? {}) as Array<[string, ManifestArtifactReference]>) {
      if (typeof reference !== 'string' && isSafeCaseRelativePath(reference.path)) {
        await verifySnapshot(caseDir, `artifacts.${group}.${name}`, reference, issues);
      }
    }
  }
  return [...new Set(issues)];
}

async function flagUncapturedIncludeGraph(
  caseDir: string,
  snapshot: AsmCaseSnapshot,
  issues: string[]
): Promise<void> {
  if (!isSafeCaseRelativePath(snapshot.path)) {
    return;
  }
  try {
    const resolved = await resolveCaseFile(caseDir, snapshot.path);
    const text = await fs.promises.readFile(resolved, 'utf8');
    if (/^\s*\.include\s+/im.test(text)) {
      issues.push('source include graph is not captured in the phase-1 bundle');
    }
  } catch {
    // verifySnapshot already reports the unavailable root snapshot.
  }
}

export function isSafeCaseRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false;
  }
  const parts = value.replace(/\\/g, '/').split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

async function verifySnapshot(
  caseDir: string,
  label: string,
  snapshot: AsmCaseSnapshot,
  issues: string[]
): Promise<void> {
  if (!isSafeCaseRelativePath(snapshot.path)) {
    return;
  }
  try {
    const resolved = await resolveCaseFile(caseDir, snapshot.path);
    const bytes = await fs.promises.readFile(resolved);
    if (bytes.byteLength !== snapshot.bytes) {
      issues.push(`${label}.bytes mismatch: expected ${snapshot.bytes}, got ${bytes.byteLength}`);
    }
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== snapshot.sha256.toLowerCase()) {
      issues.push(`${label}.sha256 mismatch`);
    }
  } catch (error) {
    issues.push(`${label} unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Resolve a regular file while rejecting symlink escapes from a replay bundle. */
async function resolveCaseFile(caseDir: string, relativePath: string): Promise<string> {
  const root = await fs.promises.realpath(caseDir);
  const candidate = path.resolve(root, ...relativePath.replace(/\\/g, '/').split('/'));
  const realCandidate = await fs.promises.realpath(candidate);
  const relative = path.relative(root, realCandidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('path escapes the case directory through a symlink');
  }
  const stat = await fs.promises.stat(realCandidate);
  if (!stat.isFile()) {
    throw new Error('path does not identify a regular file');
  }
  return realCandidate;
}

function isSha256(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

// ── Atomic write ──────────────────────────────────────────────────────────────

const manifestWriteTails = new Map<string, Promise<void>>();

/**
 * Write a manifest via temp file + rename so cancellation or a crash never
 * leaves a half-written JSON behind (计划 5.8: manifest 用临时文件+原子 rename)。
 * The case directory is always a local file path, so node fs is safe here.
 */
export async function writeManifestAtomic(manifestPath: string, manifest: AsmCaseManifestUnion): Promise<void> {
  const queueKey = process.platform === 'win32'
    ? path.resolve(manifestPath).toLowerCase()
    : path.resolve(manifestPath);
  const previous = manifestWriteTails.get(queueKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  manifestWriteTails.set(queueKey, current);

  await previous.catch(() => undefined);
  const tempPath = `${manifestPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.promises.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await replaceManifestFile(tempPath, manifestPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    release();
    if (manifestWriteTails.get(queueKey) === current) {
      manifestWriteTails.delete(queueKey);
    }
  }
}

async function replaceManifestFile(tempPath: string, manifestPath: string): Promise<void> {
  try {
    await fs.promises.rename(tempPath, manifestPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || (code !== 'EEXIST' && code !== 'EPERM')) {
      throw error;
    }
  }

  // Windows rename does not replace an existing destination. Keep the old
  // complete file as a recoverable backup until the new complete file lands.
  const backupPath = `${manifestPath}.bak-${process.pid}-${crypto.randomUUID()}`;
  let hasBackup = false;
  try {
    await fs.promises.rename(manifestPath, backupPath);
    hasBackup = true;
    await fs.promises.rename(tempPath, manifestPath);
  } catch (error) {
    if (hasBackup) {
      await fs.promises.rename(backupPath, manifestPath).catch(() => undefined);
    }
    throw error;
  }
  // The replacement is already complete; stale-backup cleanup must not turn a
  // successful write into a failed one or overwrite the new manifest.
  await fs.promises.rm(backupPath, { force: true }).catch(() => undefined);
}
