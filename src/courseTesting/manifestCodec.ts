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
import {
  loadAndVerifySourceGraph,
  sourceGraphBundleIssues,
  type SourceGraphBundle
} from '../mips/replay/sourceBundle';
import {
  deserializeProgramImage,
  observabilitySchemaDigest,
  oracleEvidenceDigests,
  parseStrictHexTextWords,
  programImageFileIssues
} from '../mips/replay/programImage';
import { sha256Canonical, type CanonicalJson } from '../mips/replay/canonical';
import {
  maximumReplaySourceBytes,
  maximumReplaySourceDepth,
  maximumReplaySourceUnits,
  maximumReplaySteps,
  maximumReplayWallClockMs,
  maximumReplayMachineCodeBytes,
  maximumReplayMachineCodeWords,
  maximumReplayProgramImageBytes,
  maximumReplaySnapshotBytes,
  maximumReplayStdinBytes,
  maximumReplayTraceBytes,
  readBoundedRegularFile
} from '../mips/replay/boundedFile';
import { legacyMarsConfigurationPolicyIssues } from '../language/mips/legacyMarsPolicy';
import { p7InterruptAnchorPairIssue } from './p7InterruptAnchor';

/**
 * Manifest v2（计划第 5.8 节）。v1 永久只读兼容；新 case 默认写 v2。
 * 路径约定：artifact 值为 case-relative（相对 case 目录）；绝对原始路径仅作
 * provenance（originalAsmPath / stdin.originalPath / asmSnapshot.path 保留）。
 */

export const asmCaseManifestVersion2 = 2;
const maximumReplaySnapshotReferences = 4096;
const maximumReplayUniqueSnapshotPaths = 4096;
const maximumReplayAggregateSnapshotBytes = 256 * 1024 * 1024;
const maximumReplayEngineDependencies = 16;
const maximumProbeJsonDepth = 32;
const maximumProbeJsonNodes = 65_536;
const maximumProbeJsonKeys = 65_536;
const maximumProbeJsonStringBytes = 1024 * 1024;

/** Serialized engine descriptor (subset of EngineDescriptor, stable across builds). */
export interface ManifestEngineInfo {
  id: string;
  build?: string;
  semanticsRevision: number;
  capabilitiesRevision: number;
  catalogRevision?: number;
  courseContractRevision?: number;
  normalizerRevision?: number;
  eventSchemaRevision?: number;
  /** Immutable artifact identity; role is resolved by an engine registry. */
  artifact?: {
    sha256: string;
    role?: string;
    fileName?: string;
    dependencies?: Array<{
      sha256: string;
      role?: string;
      fileName?: string;
    }>;
  };
  /** Process-level provenance; present only for engines that spawn a process. */
  legacyProvenance?: {
    commandLine?: string;
    cwd?: string;
    memoryConfiguration?: string;
    /** Exact assembly-side launch tuple; oracle configuration is a separate run. */
    profile?: string;
    runtime?: { kind: 'java'; command: string };
    wallClockMs?: number;
    p7RiInstruction?: boolean;
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

/** Runtime kind recorded with one oracle run; Java is legacy MARS, builtin-ts is in-process. */
export type ManifestRuntime = { kind: 'java'; command: string } | { kind: 'builtin-ts' };

/** Exact inputs that affect one oracle run; optional fields are absent only before execution. */
export interface ManifestRunConfiguration {
  profile: string;
  memoryConfiguration: string;
  courseTrace?: boolean;
  traceOutput?: boolean;
  traceLevel?: 1 | 2;
  maxSteps?: number;
  haltPc?: number;
  interruptSchedule?: number[];
  stdinSha256?: string;
  /** Complete phase-1 input. Optional only while a case has not run yet / for early-v2 reads. */
  executionOptions?: {
    delayedBranching: boolean;
    courseTrace: boolean;
    traceOutput: boolean;
    traceLevel: 1 | 2 | null;
    p7RiInstruction: boolean;
  };
  stdin?: { sha256: string | null; bytes: number; mode: 'bytes' };
  deviceTimeline?: {
    schemaRevision: 1;
    events: Array<{ kind: 'external-interrupt'; trigger: 'macro-pc'; value: number }>;
    probeMetadataDigest: string | null;
  };
  cycleContract?: { id: string; revision: number };
  stopPolicy?: { kind: 'halt-loop' | 'step-limit' | 'engine-error'; haltPc: number | null };
  haltPolicy?: {
    kind: 'course-self-branch-nop' | 'none';
    branchWord: number | null;
    delaySlotWord: number | null;
  };
  stepPolicy?: { unit: 'architectural-instruction'; limit: number | null };
  seed?: string | null;
  resourceLimits?: {
    wallClockMs: number;
    maxSteps: number | null;
    maxTraceBytes: number | null;
    maxSourceBytes: number;
    maxIncludeDepth: number;
    maxIncludeUnits: number;
  };
  runtime?: ManifestRuntime;
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
    /** Canonical SourceUnit/include graph and serialized domain image. */
    sourceGraph?: AsmCaseSnapshot;
    image?: AsmCaseSnapshot;
    observability?: AsmCaseSnapshot;
    /** Exact bytes passed to the DUT adapter (currently the HexText machine-code file). */
    dutInput?: AsmCaseSnapshot;
    /** Hashed case-relative map; strings remain readable for early v2 drafts. */
    sourceMap?: ManifestArtifactReference;
  };
  oracle: {
    engine: ManifestEngineInfo;
    configurationHash: string;
    runConfiguration?: ManifestRunConfiguration;
    stopReason: 'halt-loop' | 'step-limit' | 'error' | 'unknown';
    steps?: number;
    eventCount?: number;
    rawOutputDigest?: string;
    eventDigest?: string;
    finalStateDigest?: string;
  };
  artifacts?: AsmCaseArtifactsV2;
  /** Typed/bound DUT configuration captured independently from oracle run inputs. */
  dut?: {
    configuration: Record<string, string>;
    configurationHash: string;
  };
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
      'source', 'stdin', 'p7', 'program', 'oracle', 'artifacts', 'dut', 'metadata'
    ])
      && hasOnlyKeys(manifest.program, [
        'assembler', 'imageFingerprint', 'machineCode', 'sourceGraph', 'image',
        'observability', 'dutInput', 'sourceMap'
      ])
      && hasOnlyKeys(manifest.oracle, [
        'engine', 'configurationHash', 'runConfiguration', 'stopReason', 'steps', 'eventCount',
        'rawOutputDigest', 'eventDigest', 'finalStateDigest'
      ])
      && isEngineInfo(manifest.program.assembler)
      && (manifest.program.imageFingerprint === undefined || isNonEmptyString(manifest.program.imageFingerprint))
      && isOptionalMachineCode(manifest.program.machineCode)
      && (manifest.program.sourceGraph === undefined || isSnapshot(manifest.program.sourceGraph))
      && (manifest.program.image === undefined || isSnapshot(manifest.program.image))
      && (manifest.program.observability === undefined || isSnapshot(manifest.program.observability))
      && (manifest.program.dutInput === undefined || isSnapshot(manifest.program.dutInput))
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
      && (manifest.oracle.eventCount === undefined || isNonNegativeInteger(manifest.oracle.eventCount))
      && (manifest.oracle.rawOutputDigest === undefined || isSha256(manifest.oracle.rawOutputDigest))
      && (manifest.oracle.eventDigest === undefined || isSha256(manifest.oracle.eventDigest))
      // Early v2 drafts allowed an opaque final-state digest. Keep them readable; replay closure
      // below requires a real SHA-256.
      && (manifest.oracle.finalStateDigest === undefined || isNonEmptyString(manifest.oracle.finalStateDigest))
      && isOptionalV2ArtifactGroups(manifest.artifacts)
      && (manifest.dut === undefined || isDutConfiguration(manifest.dut))
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
    'profile', 'memoryConfiguration', 'courseTrace', 'traceOutput', 'traceLevel', 'maxSteps',
    'haltPc', 'interruptSchedule', 'stdinSha256', 'executionOptions', 'stdin',
    'deviceTimeline', 'cycleContract', 'stopPolicy', 'haltPolicy', 'stepPolicy',
    'seed', 'resourceLimits', 'runtime'
  ])
    && isNonEmptyString(value.profile)
    && isNonEmptyString(value.memoryConfiguration)
    && (value.courseTrace === undefined || typeof value.courseTrace === 'boolean')
    && (value.traceOutput === undefined || typeof value.traceOutput === 'boolean')
    && (value.traceLevel === undefined || value.traceLevel === 1 || value.traceLevel === 2)
    && (value.maxSteps === undefined || (Number.isSafeInteger(value.maxSteps) && (value.maxSteps as number) > 0))
    && (value.haltPc === undefined || isUint32(value.haltPc))
    && (value.interruptSchedule === undefined || (
      Array.isArray(value.interruptSchedule)
      && value.interruptSchedule.every((pc) => isUint32(pc))
    ))
    && (value.stdinSha256 === undefined || isSha256(value.stdinSha256))
    && (value.executionOptions === undefined || isExecutionOptions(value.executionOptions))
    && (value.stdin === undefined || isRunStdin(value.stdin))
    && (value.deviceTimeline === undefined || isDeviceTimeline(value.deviceTimeline))
    && (value.cycleContract === undefined || isCycleContract(value.cycleContract))
    && (value.stopPolicy === undefined || isStopPolicy(value.stopPolicy))
    && (value.haltPolicy === undefined || isHaltPolicy(value.haltPolicy))
    && (value.stepPolicy === undefined || isStepPolicy(value.stepPolicy))
    && (value.seed === undefined || value.seed === null || typeof value.seed === 'string')
    && (value.resourceLimits === undefined || isResourceLimits(value.resourceLimits))
    && (value.runtime === undefined || isRuntime(value.runtime));
}

function isExecutionOptions(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['delayedBranching', 'courseTrace', 'traceOutput', 'traceLevel', 'p7RiInstruction'])
    && typeof value.delayedBranching === 'boolean' && typeof value.courseTrace === 'boolean'
    && typeof value.traceOutput === 'boolean'
    && (value.traceLevel === null || value.traceLevel === 1 || value.traceLevel === 2)
    && typeof value.p7RiInstruction === 'boolean';
}

function isRunStdin(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['sha256', 'bytes', 'mode'])
    && (value.sha256 === null || isSha256(value.sha256)) && isNonNegativeInteger(value.bytes)
    && value.mode === 'bytes';
}

function isDeviceTimeline(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['schemaRevision', 'events', 'probeMetadataDigest'])
    && value.schemaRevision === 1 && Array.isArray(value.events)
    && value.events.every((event) => isRecord(event)
      && hasOnlyKeys(event, ['kind', 'trigger', 'value']) && event.kind === 'external-interrupt'
      && event.trigger === 'macro-pc' && isUint32(event.value))
    && (value.probeMetadataDigest === null || isSha256(value.probeMetadataDigest));
}

function isCycleContract(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['id', 'revision']) && isNonEmptyString(value.id)
    && isNonNegativeInteger(value.revision);
}

function isStopPolicy(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['kind', 'haltPc'])
    && ['halt-loop', 'step-limit', 'engine-error'].includes(value.kind as string)
    && (value.haltPc === null || isUint32(value.haltPc));
}

function isHaltPolicy(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['kind', 'branchWord', 'delaySlotWord'])
    && (value.kind === 'course-self-branch-nop' || value.kind === 'none')
    && (value.branchWord === null || isUint32(value.branchWord))
    && (value.delaySlotWord === null || isUint32(value.delaySlotWord));
}

function isStepPolicy(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['unit', 'limit']) && value.unit === 'architectural-instruction'
    && (value.limit === null || (Number.isSafeInteger(value.limit) && (value.limit as number) > 0));
}

function isResourceLimits(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, [
    'wallClockMs', 'maxSteps', 'maxTraceBytes', 'maxSourceBytes', 'maxIncludeDepth', 'maxIncludeUnits'
  ]) && Number.isSafeInteger(value.wallClockMs) && (value.wallClockMs as number) > 0
    && (value.wallClockMs as number) <= maximumReplayWallClockMs
    && (value.maxSteps === null || (Number.isSafeInteger(value.maxSteps)
      && (value.maxSteps as number) > 0 && (value.maxSteps as number) <= maximumReplaySteps))
    && (value.maxTraceBytes === null || (Number.isSafeInteger(value.maxTraceBytes)
      && (value.maxTraceBytes as number) > 0
      && (value.maxTraceBytes as number) <= maximumReplayTraceBytes))
    && Number.isSafeInteger(value.maxSourceBytes) && (value.maxSourceBytes as number) > 0
    && (value.maxSourceBytes as number) <= maximumReplaySourceBytes
    && Number.isSafeInteger(value.maxIncludeDepth) && (value.maxIncludeDepth as number) > 0
    && (value.maxIncludeDepth as number) <= maximumReplaySourceDepth
    && Number.isSafeInteger(value.maxIncludeUnits) && (value.maxIncludeUnits as number) > 0
    && (value.maxIncludeUnits as number) <= maximumReplaySourceUnits;
}

function isRuntime(value: unknown): value is ManifestRuntime {
  return isRecord(value)
    && (value.kind === 'java'
      ? hasOnlyKeys(value, ['kind', 'command']) && isNonEmptyString(value.command)
      : value.kind === 'builtin-ts' && hasOnlyKeys(value, ['kind']));
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
    && (value.probe === undefined || (isRecord(value.probe) && isBoundedProbeJson(value.probe)));
}

/**
 * Probe metadata is intentionally extensible, but it is still untrusted JSON from an archived
 * case. Bound it iteratively before JSON round-tripping/canonicalization so a deeply nested or
 * extremely wide object cannot overflow the stack or amplify memory in the extension host.
 */
function isBoundedProbeJson(root: Record<string, unknown>): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let keys = 0;
  let stringBytes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > maximumProbeJsonNodes || current.depth > maximumProbeJsonDepth) {
      return false;
    }
    const value = current.value;
    if (value === null || typeof value === 'boolean') {
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value === 'string') {
      stringBytes += Buffer.byteLength(value, 'utf8');
      if (stringBytes > maximumProbeJsonStringBytes) return false;
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      keys += value.length;
      if (keys > maximumProbeJsonKeys) return false;
      for (const item of value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    keys += entries.length;
    if (keys > maximumProbeJsonKeys) return false;
    for (const [key, item] of entries) {
      stringBytes += Buffer.byteLength(key, 'utf8');
      if (stringBytes > maximumProbeJsonStringBytes) return false;
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return true;
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
    , 'catalogRevision', 'courseContractRevision', 'normalizerRevision', 'eventSchemaRevision'
  ])
    && isNonEmptyString(value.id)
    && (value.build === undefined || typeof value.build === 'string')
    && isNonNegativeInteger(value.semanticsRevision)
    && isNonNegativeInteger(value.capabilitiesRevision)
    && (value.catalogRevision === undefined || isNonNegativeInteger(value.catalogRevision))
    && (value.courseContractRevision === undefined || isNonNegativeInteger(value.courseContractRevision))
    && (value.normalizerRevision === undefined || isNonNegativeInteger(value.normalizerRevision))
    && (value.eventSchemaRevision === undefined || isNonNegativeInteger(value.eventSchemaRevision))
    && (value.artifact === undefined || (
      isRecord(value.artifact)
      && hasOnlyKeys(value.artifact, ['sha256', 'role', 'fileName', 'dependencies'])
      && isSha256(value.artifact.sha256)
      && (value.artifact.role === undefined || typeof value.artifact.role === 'string')
      && (value.artifact.fileName === undefined || typeof value.artifact.fileName === 'string')
      && (value.artifact.dependencies === undefined || (
        Array.isArray(value.artifact.dependencies)
        && value.artifact.dependencies.every((dependency) => isRecord(dependency)
          && hasOnlyKeys(dependency, ['sha256', 'role', 'fileName'])
          && isSha256(dependency.sha256)
          && (dependency.role === undefined || typeof dependency.role === 'string')
          && (dependency.fileName === undefined || typeof dependency.fileName === 'string'))
      ))
    ))
    && (value.legacyProvenance === undefined || (
      isRecord(value.legacyProvenance)
      && hasOnlyKeys(value.legacyProvenance, [
        'commandLine', 'cwd', 'memoryConfiguration', 'profile', 'runtime', 'wallClockMs', 'p7RiInstruction'
      ])
      && (value.legacyProvenance.commandLine === undefined || typeof value.legacyProvenance.commandLine === 'string')
      && (value.legacyProvenance.cwd === undefined || typeof value.legacyProvenance.cwd === 'string')
      && (value.legacyProvenance.memoryConfiguration === undefined || typeof value.legacyProvenance.memoryConfiguration === 'string')
      && (value.legacyProvenance.profile === undefined || isNonEmptyString(value.legacyProvenance.profile))
      && (value.legacyProvenance.runtime === undefined || (
        isRecord(value.legacyProvenance.runtime)
        && hasOnlyKeys(value.legacyProvenance.runtime, ['kind', 'command'])
        && value.legacyProvenance.runtime.kind === 'java'
        && isNonEmptyString(value.legacyProvenance.runtime.command)
      ))
      && (value.legacyProvenance.wallClockMs === undefined
        || (Number.isSafeInteger(value.legacyProvenance.wallClockMs) && (value.legacyProvenance.wallClockMs as number) > 0))
      && (value.legacyProvenance.p7RiInstruction === undefined
        || typeof value.legacyProvenance.p7RiInstruction === 'boolean')
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

function isDutConfiguration(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['configuration', 'configurationHash'])
    && isOptionalStringMap(value.configuration) && value.configuration !== undefined
    && Object.keys(value.configuration as Record<string, string>).every((key) => key.startsWith('dut.'))
    && isSha256(value.configurationHash);
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
    result.oracle = artifactPathMap(artifacts.oracle);
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
    case 'oracle':
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
  const canonical: CanonicalJson = {
    engine: {
      id: engine.id,
      build: engine.build ?? null,
      semanticsRevision: engine.semanticsRevision,
      capabilitiesRevision: engine.capabilitiesRevision,
      catalogRevision: engine.catalogRevision ?? null,
      courseContractRevision: engine.courseContractRevision ?? null,
      normalizerRevision: engine.normalizerRevision ?? null,
      eventSchemaRevision: engine.eventSchemaRevision ?? null,
      artifact: engine.artifact ? {
        sha256: engine.artifact.sha256.toLowerCase(),
        role: engine.artifact.role ?? null,
        fileName: engine.artifact.fileName ?? null,
        dependencies: (engine.artifact.dependencies ?? []).map((dependency) => ({
          sha256: dependency.sha256.toLowerCase(),
          role: dependency.role ?? null,
          fileName: dependency.fileName ?? null
        }))
      } : null
    },
    profile: configuration.profile,
    memoryConfiguration: configuration.memoryConfiguration,
    courseTrace: configuration.courseTrace ?? false,
    traceOutput: configuration.traceOutput ?? false,
    traceLevel: configuration.traceLevel ?? null,
    maxSteps: configuration.maxSteps ?? null,
    haltPc: configuration.haltPc ?? null,
    interruptSchedule: configuration.interruptSchedule ?? [],
    stdinSha256: configuration.stdinSha256 ?? null,
    executionOptions: configuration.executionOptions as unknown as CanonicalJson ?? null,
    stdin: configuration.stdin as unknown as CanonicalJson ?? null,
    deviceTimeline: configuration.deviceTimeline as unknown as CanonicalJson ?? null,
    cycleContract: configuration.cycleContract as unknown as CanonicalJson ?? null,
    stopPolicy: configuration.stopPolicy as unknown as CanonicalJson ?? null,
    haltPolicy: configuration.haltPolicy as unknown as CanonicalJson ?? null,
    stepPolicy: configuration.stepPolicy as unknown as CanonicalJson ?? null,
    seed: configuration.seed ?? null,
    resourceLimits: configuration.resourceLimits as unknown as CanonicalJson ?? null,
    runtime: configuration.runtime as unknown as CanonicalJson ?? null
  };
  return sha256Canonical(canonical);
}

export function manifestDutConfigurationHash(configuration: Record<string, string>): string {
  return sha256Canonical(configuration as unknown as CanonicalJson);
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
  issues.push(...replaySnapshotSetIssues(manifest));
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
  if (!manifest.program?.assembler?.artifact?.role) {
    issues.push('program.assembler.artifact.role missing (registry lookup would be ambiguous)');
  }
  completeEngineDescriptorIssues('program.assembler', manifest.program?.assembler, issues);
  engineDependencyClosureIssues('program.assembler', manifest.program?.assembler, issues);
  if (!isSha256(manifest.program?.machineCode?.sha256)) {
    issues.push('program.machineCode.sha256 missing or invalid (image not dumped yet)');
  }
  if ((manifest.program?.machineCode?.wordCount ?? 0) > maximumReplayMachineCodeWords) {
    issues.push(`program.machineCode.wordCount exceeds the course IM limit ${maximumReplayMachineCodeWords}`);
  }
  if (manifest.program?.machineCode && !isSafeCaseRelativePath(manifest.program.machineCode.path)) {
    issues.push('program.machineCode.path must be a safe case-relative path');
  }
  requiredReplaySnapshot('program.sourceGraph', manifest.program?.sourceGraph, issues);
  requiredReplaySnapshot('program.image', manifest.program?.image, issues);
  requiredReplaySnapshot('program.observability', manifest.program?.observability, issues);
  requiredReplaySnapshot('program.dutInput', manifest.program?.dutInput, issues);
  requiredSnapshotAlias('artifacts.source.graph', manifest.artifacts?.source?.graph, manifest.program?.sourceGraph, issues);
  requiredSnapshotAlias('artifacts.program.image', manifest.artifacts?.program?.image, manifest.program?.image, issues);
  requiredSnapshotAlias(
    'artifacts.program.observability',
    manifest.artifacts?.program?.observability,
    manifest.program?.observability,
    issues
  );
  requiredSnapshotAlias('artifacts.program.dutInput', manifest.artifacts?.program?.dutInput, manifest.program?.dutInput, issues);
  if (manifest.program?.sourceMap && typeof manifest.program.sourceMap !== 'string') {
    requiredSnapshotAlias(
      'artifacts.program.sourceMap',
      manifest.artifacts?.program?.sourceMap,
      manifest.program.sourceMap,
      issues
    );
  }
  if (manifest.artifacts?.source?.original !== undefined) {
    requiredSnapshotAlias('artifacts.source.original', manifest.artifacts.source.original, manifest.asmSnapshot, issues);
  }
  supplementalArtifactNameIssues('artifacts.program', manifest.artifacts?.program, [
    'image', 'observability', 'dutInput', 'sourceMap'
  ], issues);
  if (manifest.program?.assembler?.id === 'legacy-mars-configured'
    && manifest.program?.observability?.sha256 !== observabilitySchemaDigest()) {
    issues.push('program.observability does not identify the legacy observability schema revision');
  }
  if (manifest.program?.machineCode && manifest.program?.dutInput
    && (manifest.program.machineCode.sha256 !== manifest.program.dutInput.sha256
      || manifest.program.machineCode.bytes !== manifest.program.dutInput.bytes)) {
    issues.push('program.dutInput does not identify the exact machine-code bytes');
  }
  if (!manifest.oracle?.engine?.id) {
    issues.push('oracle.engine.id missing');
  }
  if (!isSha256(manifest.oracle?.engine?.artifact?.sha256)) {
    issues.push('oracle.engine.artifact.sha256 missing or invalid');
  }
  if (!manifest.oracle?.engine?.artifact?.role) {
    issues.push('oracle.engine.artifact.role missing (registry lookup would be ambiguous)');
  }
  completeEngineDescriptorIssues('oracle.engine', manifest.oracle?.engine, issues);
  engineDependencyClosureIssues('oracle.engine', manifest.oracle?.engine, issues);
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
    legacyAssemblyConfigurationIssues(manifest, configuration, issues);
    completeRunConfigurationIssues(configuration, manifest, issues);
  }
  if (manifest.oracle?.stopReason === 'unknown') {
    issues.push('oracle.stopReason is unknown (oracle not completed)');
  }
  if (!isNonNegativeInteger(manifest.oracle?.steps)) issues.push('oracle.steps missing or invalid');
  if (!isNonNegativeInteger(manifest.oracle?.eventCount)) issues.push('oracle.eventCount missing or invalid');
  if (!isSha256(manifest.oracle?.rawOutputDigest)) issues.push('oracle.rawOutputDigest missing or invalid');
  if (!isSha256(manifest.oracle?.eventDigest)) issues.push('oracle.eventDigest missing or invalid');
  if (!isSha256(manifest.oracle?.finalStateDigest)) issues.push('oracle.finalStateDigest missing or invalid');
  const traceReference = manifest.artifacts?.oracle?.traceOut;
  if (!traceReference || typeof traceReference === 'string' || !isSnapshot(traceReference)) {
    issues.push('artifacts.oracle.traceOut hashed snapshot missing');
  }
  if (manifest.stdin && !isSafeCaseRelativePath(manifest.stdin.path)) {
    issues.push('stdin.path must be a safe case-relative path');
  }
  const replayUnboundMetadata = Object.keys(manifest.metadata ?? {}).filter((key) => !key.startsWith('source.'));
  if (replayUnboundMetadata.length) {
    issues.push(`metadata contains replay-unbound keys: ${replayUnboundMetadata.sort().join(', ')}`);
  }
  if (manifest.dut && manifest.dut.configurationHash !== manifestDutConfigurationHash(manifest.dut.configuration)) {
    issues.push('dut.configurationHash does not match dut.configuration');
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

function legacyAssemblyConfigurationIssues(
  manifest: AsmCaseManifestV2,
  oracleConfiguration: ManifestRunConfiguration,
  issues: string[]
): void {
  if (manifest.program.assembler.id !== 'legacy-mars-configured') return;
  const assembly = manifest.program.assembler.legacyProvenance;
  const wallClockMs = assembly?.wallClockMs;
  if (!assembly?.profile || !assembly.memoryConfiguration || !assembly.runtime
    || !Number.isSafeInteger(wallClockMs) || (wallClockMs ?? 0) <= 0
    || assembly.p7RiInstruction === undefined) {
    issues.push('program.assembler.legacyProvenance does not bind the complete assembly launch tuple');
    return;
  }
  if (assembly.profile !== manifest.profile) {
    issues.push('program.assembler.legacyProvenance.profile does not match manifest.profile');
  }
  if (assembly.memoryConfiguration !== oracleConfiguration.memoryConfiguration) {
    issues.push('legacy assembler and oracle memory configurations differ');
  }
  if (assembly.p7RiInstruction !== oracleConfiguration.executionOptions?.p7RiInstruction) {
    issues.push('legacy assembler and oracle p7RiInstruction settings differ');
  }
  if (wallClockMs! > maximumReplayWallClockMs) {
    issues.push(`program.assembler.legacyProvenance.wallClockMs exceeds ${maximumReplayWallClockMs}`);
  }
}

function requiredReplaySnapshot(label: string, snapshot: AsmCaseSnapshot | undefined, issues: string[]): void {
  if (!snapshot || !isSnapshot(snapshot)) {
    issues.push(`${label} missing or invalid`);
  } else if (!isSafeCaseRelativePath(snapshot.path)) {
    issues.push(`${label}.path must be a safe case-relative path`);
  }
}

function requiredSnapshotAlias(
  label: string,
  alias: ManifestArtifactReference | undefined,
  canonical: AsmCaseSnapshot | undefined,
  issues: string[]
): void {
  if (!canonical) return;
  if (!alias || typeof alias === 'string' || !sameSnapshotIdentity(alias, canonical)) {
    issues.push(`${label} must exactly alias its typed program/source snapshot`);
  }
}

function sameSnapshotIdentity(left: AsmCaseSnapshot, right: AsmCaseSnapshot): boolean {
  return left.path === right.path
    && left.bytes === right.bytes
    && left.sha256.toLowerCase() === right.sha256.toLowerCase();
}

function supplementalArtifactNameIssues(
  label: string,
  values: Record<string, ManifestArtifactReference> | undefined,
  standardNames: readonly string[],
  issues: string[]
): void {
  const standard = new Set(standardNames);
  const unknown = Object.keys(values ?? {}).filter((name) => !standard.has(name) && !name.startsWith('supplemental/'));
  if (unknown.length) {
    issues.push(`${label} contains non-standard keys outside supplemental/: ${unknown.sort().join(', ')}`);
  }
}

function engineDependencyClosureIssues(label: string, engine: ManifestEngineInfo | undefined, issues: string[]): void {
  const dependencies = engine?.artifact?.dependencies ?? [];
  if (dependencies.length > maximumReplayEngineDependencies) {
    issues.push(`${label}.artifact.dependencies exceeds the trusted limit ${maximumReplayEngineDependencies}`);
  }
  const roles = new Set<string>();
  for (const [index, dependency] of dependencies.entries()) {
    if (!isSha256(dependency.sha256) || !dependency.role || !dependency.fileName) {
      issues.push(`${label}.artifact.dependencies[${index}] lacks a registry-resolvable role/digest/fileName`);
    }
    if (dependency.role) {
      if (roles.has(dependency.role)) {
        issues.push(`${label}.artifact.dependencies contains duplicate role ${dependency.role}`);
      }
      roles.add(dependency.role);
    }
  }
  if (engine?.id === 'legacy-mars-configured') {
    const unexpected = dependencies.filter((dependency) => dependency.role !== p7RiInstructionDependencyRole);
    if (unexpected.length || dependencies.length > 1) {
      issues.push(
        `${label}.artifact.dependencies for legacy-mars-configured may contain only one optional ${p7RiInstructionDependencyRole}`
      );
    }
  }
}

function completeEngineDescriptorIssues(label: string, engine: ManifestEngineInfo | undefined, issues: string[]): void {
  if (!engine?.build) issues.push(`${label}.build missing`);
  for (const field of [
    'catalogRevision', 'courseContractRevision', 'normalizerRevision', 'eventSchemaRevision'
  ] as const) {
    if (!isNonNegativeInteger(engine?.[field])) issues.push(`${label}.${field} missing or invalid`);
  }
  if (!engine?.artifact?.fileName) issues.push(`${label}.artifact.fileName missing`);
}

function completeRunConfigurationIssues(
  configuration: ManifestRunConfiguration,
  manifest: AsmCaseManifestV2,
  issues: string[]
): void {
  if (!configuration.executionOptions) issues.push('oracle.runConfiguration.executionOptions missing');
  if (!configuration.stdin) issues.push('oracle.runConfiguration.stdin missing');
  if (!configuration.deviceTimeline) issues.push('oracle.runConfiguration.deviceTimeline missing');
  if (!configuration.cycleContract) issues.push('oracle.runConfiguration.cycleContract missing');
  if (!configuration.stopPolicy) issues.push('oracle.runConfiguration.stopPolicy missing');
  if (!configuration.haltPolicy) issues.push('oracle.runConfiguration.haltPolicy missing');
  if (!configuration.stepPolicy) issues.push('oracle.runConfiguration.stepPolicy missing');
  if (configuration.seed === undefined) issues.push('oracle.runConfiguration.seed missing (use null when absent)');
  if (!configuration.resourceLimits) issues.push('oracle.runConfiguration.resourceLimits missing');
  if (!configuration.runtime) issues.push('oracle.runConfiguration.runtime missing');
  if (configuration.runtime?.kind === 'java') {
    for (const policyIssue of legacyMarsConfigurationPolicyIssues(
      configuration.profile,
      configuration.memoryConfiguration,
      'run',
      true
    )) {
      issues.push(`oracle.runConfiguration violates production launch policy: [${policyIssue.code}] ${policyIssue.message}`);
    }
  } else if (configuration.runtime?.kind === 'builtin-ts') {
    if (configuration.resourceLimits?.maxSteps !== null
      && configuration.resourceLimits?.maxSteps !== configuration.stepPolicy?.limit) {
      issues.push('oracle.runConfiguration.resourceLimits.maxSteps does not match stepPolicy.limit');
    }
  }

  const expectedStdin = manifest.stdin
    ? { sha256: manifest.stdin.sha256, bytes: manifest.stdin.bytes }
    : { sha256: null, bytes: 0 };
  if (configuration.stdin
    && (configuration.stdin.sha256 !== expectedStdin.sha256 || configuration.stdin.bytes !== expectedStdin.bytes)) {
    issues.push('oracle.runConfiguration.stdin does not match the captured stdin bytes');
  }
  if (configuration.executionOptions) {
    if (configuration.executionOptions.courseTrace !== (configuration.courseTrace ?? false)
      || configuration.executionOptions.traceOutput !== (configuration.traceOutput ?? false)
      || configuration.executionOptions.traceLevel !== (configuration.traceLevel ?? null)) {
      issues.push('oracle.runConfiguration.executionOptions disagrees with legacy-compatible trace fields');
    }
    const expectedDelayed = ['P5', 'P6', 'P7'].includes(configuration.profile);
    if (configuration.executionOptions.delayedBranching !== expectedDelayed) {
      issues.push('oracle.runConfiguration.executionOptions.delayedBranching disagrees with profile contract');
    }
    p7RiDependencyIssues(
      configuration.executionOptions.p7RiInstruction,
      'program.assembler',
      manifest.program.assembler,
      issues
    );
    p7RiDependencyIssues(
      configuration.executionOptions.p7RiInstruction,
      'oracle.engine',
      manifest.oracle.engine,
      issues
    );
  }
  const isP7 = manifest.profile === 'P7';
  if (!isP7) {
    if (manifest.p7 !== undefined) {
      issues.push('manifest.p7 is forbidden outside the P7 profile');
    }
    if ((configuration.interruptSchedule?.length ?? 0) > 0) {
      issues.push('oracle.runConfiguration.interruptSchedule must be empty outside the P7 profile');
    }
    if (configuration.deviceTimeline
      && (configuration.deviceTimeline.events.length > 0
        || configuration.deviceTimeline.probeMetadataDigest !== null)) {
      issues.push('oracle.runConfiguration.deviceTimeline must be empty outside the P7 profile');
    }
    if (configuration.executionOptions?.p7RiInstruction) {
      issues.push('oracle.runConfiguration.executionOptions.p7RiInstruction is forbidden outside the P7 profile');
    }
  }
  const expectedCycleContract = isP7
    ? { id: 'buaa-co-p7-cycle-contract', revision: 1 }
    : { id: 'architectural-commit-v1', revision: 1 };
  if (configuration.cycleContract
    && (configuration.cycleContract.id !== expectedCycleContract.id
      || configuration.cycleContract.revision !== expectedCycleContract.revision)) {
    issues.push(
      `oracle.runConfiguration.cycleContract must be ${expectedCycleContract.id}/rev${expectedCycleContract.revision}`
    );
  }
  if (configuration.courseTrace !== true || configuration.traceOutput !== true) {
    issues.push('oracle.runConfiguration is not a sealed automatic course-trace invocation');
  }
  if (!Number.isSafeInteger(configuration.maxSteps) || (configuration.maxSteps ?? 0) <= 0) {
    issues.push('oracle.runConfiguration.maxSteps must be a positive bounded course-run limit');
  }
  const interruptUpperBound = manifest.program.machineCode?.haltPc;
  if ((configuration.interruptSchedule ?? []).some((pc) =>
    pc < courseTextBase + 4 || (pc & 3) !== 0
      || interruptUpperBound === undefined || pc > interruptUpperBound)) {
    issues.push(
      'oracle.runConfiguration.interruptSchedule must contain word-aligned loaded target PCs from 0x3004 through the validated haltPc'
    );
  }
  if (configuration.deviceTimeline) {
    const timeline = configuration.deviceTimeline.events.map((event) => event.value);
    if (JSON.stringify(timeline) !== JSON.stringify(configuration.interruptSchedule ?? [])) {
      issues.push('oracle.runConfiguration.deviceTimeline disagrees with interruptSchedule');
    }
    const probeDigest = manifest.p7?.probe === undefined
      ? null
      : sha256Canonical(JSON.parse(JSON.stringify(manifest.p7.probe)) as CanonicalJson);
    if (configuration.deviceTimeline.probeMetadataDigest !== probeDigest) {
      issues.push('oracle.runConfiguration.deviceTimeline does not bind P7 probe metadata');
    }
  }
  if (configuration.stopPolicy) {
    const expectedPolicyKind = manifest.oracle.stopReason === 'error' ? 'engine-error' : manifest.oracle.stopReason;
    if (configuration.stopPolicy.kind !== expectedPolicyKind) {
      issues.push('oracle.runConfiguration.stopPolicy.kind disagrees with oracle.stopReason');
    }
    if (configuration.stopPolicy.haltPc !== (configuration.haltPc ?? null)) {
      issues.push('oracle.runConfiguration.stopPolicy.haltPc disagrees with haltPc');
    }
    if (configuration.stopPolicy.kind === 'halt-loop'
      && (!isUint32(configuration.haltPc) || configuration.haltPc !== manifest.program.machineCode?.haltPc)) {
      issues.push('oracle.runConfiguration halt-loop policy requires the validated machine-code haltPc');
    } else if (configuration.stopPolicy.kind !== 'halt-loop'
      && (configuration.haltPc !== undefined || configuration.stopPolicy.haltPc !== null)) {
      issues.push('oracle.runConfiguration haltPc must be absent when stopPolicy is not halt-loop');
    }
  }
  if (configuration.haltPolicy) {
    const expectsLoop = configuration.stopPolicy?.kind === 'halt-loop';
    if (expectsLoop && (configuration.haltPolicy.kind !== 'course-self-branch-nop'
      || configuration.haltPolicy.branchWord !== 0x1000ffff || configuration.haltPolicy.delaySlotWord !== 0)) {
      issues.push('oracle.runConfiguration.haltPolicy does not encode the verified course halt loop');
    } else if (!expectsLoop && (configuration.haltPolicy.kind !== 'none'
      || configuration.haltPolicy.branchWord !== null || configuration.haltPolicy.delaySlotWord !== null)) {
      issues.push('oracle.runConfiguration.haltPolicy must be empty when stopPolicy is not halt-loop');
    }
  }
  if (configuration.stepPolicy?.limit !== (configuration.maxSteps ?? null)) {
    issues.push('oracle.runConfiguration.stepPolicy.limit disagrees with maxSteps');
  }
  if (configuration.resourceLimits?.maxSteps !== (configuration.maxSteps ?? null)) {
    issues.push('oracle.runConfiguration.resourceLimits.maxSteps disagrees with maxSteps');
  }
  if (configuration.resourceLimits?.maxTraceBytes !== maximumReplayTraceBytes) {
    issues.push(
      `oracle.runConfiguration.resourceLimits.maxTraceBytes must equal the enforced ${maximumReplayTraceBytes}-byte process-output ceiling`
    );
  }
  if ((configuration.seed ?? null) !== (manifest.metadata?.['source.seed'] ?? null)) {
    issues.push('oracle.runConfiguration.seed does not bind source.seed provenance');
  }
  if (manifest.oracle.stopReason === 'error') {
    issues.push('oracle.stopReason=error is not supported by phase-1 exact replay');
  }
}

const p7RiInstructionDependencyRole = 'mars-p7-ri-instruction-class';

function p7RiDependencyIssues(
  enabled: boolean,
  label: string,
  engine: ManifestEngineInfo,
  issues: string[]
): void {
  const count = (engine.artifact?.dependencies ?? [])
    .filter((dependency) => dependency.role === p7RiInstructionDependencyRole)
    .length;
  if (enabled && count !== 1) {
    issues.push(
      `${label} must have exactly one ${p7RiInstructionDependencyRole} dependency when p7RiInstruction is enabled`
    );
  } else if (!enabled && count !== 0) {
    issues.push(
      `${label} must not have a ${p7RiInstructionDependencyRole} dependency when p7RiInstruction is disabled`
    );
  }
}

/** Validate the replay bundle bytes in addition to the synchronous structural closure. */
export async function v2ReplayBundleIssues(manifest: AsmCaseManifestV2, caseDir: string): Promise<string[]> {
  const issues = v2ReplayClosureIssues(manifest);
  if (!isKnownManifest(manifest) || !isManifestV2(manifest)) {
    return issues;
  }
  const snapshotSetIssues = replaySnapshotSetIssues(manifest);
  if (snapshotSetIssues.length) {
    return [...new Set(issues)];
  }
  const snapshotReads = new Map<string, Promise<Buffer>>();
  await verifySnapshot(caseDir, 'asmSnapshot', manifest.asmSnapshot, issues, snapshotReads);
  if (manifest.program.machineCode) {
    await verifySnapshot(caseDir, 'program.machineCode', manifest.program.machineCode, issues, snapshotReads);
  }
  if (manifest.program.sourceGraph) {
    await verifySnapshot(caseDir, 'program.sourceGraph', manifest.program.sourceGraph, issues, snapshotReads);
    if (isSafeCaseRelativePath(manifest.program.sourceGraph.path)) {
      const graphIssues = await sourceGraphBundleIssues(caseDir, manifest.program.sourceGraph.path);
      issues.push(...graphIssues.map((issue) => `program.sourceGraph: ${issue}`));
      if (!graphIssues.length) {
        try {
          const graph = await loadAndVerifySourceGraph(caseDir, manifest.program.sourceGraph.path);
          const limits = manifest.oracle.runConfiguration?.resourceLimits;
          if (limits && (limits.maxSourceBytes !== graph.limits.maxBytes
            || limits.maxIncludeDepth !== graph.limits.maxDepth
            || limits.maxIncludeUnits !== graph.limits.maxUnits)) {
            issues.push('oracle.runConfiguration.resourceLimits source limits do not match program.sourceGraph.limits');
          }
          const rootUnit = graph.units.find((unit) => unit.id === graph.rootId);
          if (!rootUnit
            || rootUnit.contentHash !== manifest.asmSnapshot.sha256.toLowerCase()
            || rootUnit.bytes !== manifest.asmSnapshot.bytes) {
            issues.push('program.sourceGraph root does not match asmSnapshot bytes/hash');
          }
          sourceArtifactClosureIssues(graph, manifest.artifacts?.source, issues);
        } catch (error) {
          issues.push(`program.sourceGraph root could not be verified: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  if (manifest.program.image) {
    await verifySnapshot(caseDir, 'program.image', manifest.program.image, issues, snapshotReads);
    if (isSafeCaseRelativePath(manifest.program.image.path)) {
      try {
        const imageFile = await resolveCaseFile(caseDir, manifest.program.image.path);
        const imageIssues = await programImageFileIssues(
          imageFile,
          manifest.program.imageFingerprint,
          manifest.program.image.bytes
        );
        issues.push(...imageIssues.map((issue) => `program.image: ${issue}`));
      } catch (error) {
        issues.push(`program.image unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (manifest.program.observability) {
    await verifySnapshot(caseDir, 'program.observability', manifest.program.observability, issues, snapshotReads);
  }
  if (manifest.program.dutInput) {
    await verifySnapshot(caseDir, 'program.dutInput', manifest.program.dutInput, issues, snapshotReads);
  }
  if (manifest.program.machineCode && manifest.program.image && manifest.program.dutInput
    && isSafeCaseRelativePath(manifest.program.machineCode.path)
    && isSafeCaseRelativePath(manifest.program.image.path)
    && isSafeCaseRelativePath(manifest.program.dutInput.path)) {
    await verifyProgramArtifactSemantics(manifest, caseDir, issues);
  }
  if (manifest.stdin) {
    await verifySnapshot(caseDir, 'stdin', manifest.stdin, issues, snapshotReads);
  }
  if (manifest.program.sourceMap && typeof manifest.program.sourceMap !== 'string'
    && isSafeCaseRelativePath(manifest.program.sourceMap.path)) {
    await verifySnapshot(caseDir, 'program.sourceMap', manifest.program.sourceMap, issues, snapshotReads);
  }
  for (const [group, values] of Object.entries(manifest.artifacts ?? {})) {
    for (const [name, reference] of Object.entries(values ?? {}) as Array<[string, ManifestArtifactReference]>) {
      if (typeof reference !== 'string' && isSafeCaseRelativePath(reference.path)) {
        await verifySnapshot(caseDir, `artifacts.${group}.${name}`, reference, issues, snapshotReads);
      }
    }
  }
  if (manifest.program.sourceGraph && manifest.program.image
    && isSafeCaseRelativePath(manifest.program.sourceGraph.path)
    && isSafeCaseRelativePath(manifest.program.image.path)) {
    try {
      const [graph, imageFile] = await Promise.all([
        loadAndVerifySourceGraph(caseDir, manifest.program.sourceGraph.path),
        resolveCaseFile(caseDir, manifest.program.image.path)
      ]);
      const image = deserializeProgramImage(await readBoundedRegularFile(imageFile, {
        maximumBytes: maximumReplayProgramImageBytes,
        expectedBytes: manifest.program.image.bytes,
        label: 'program.image'
      }));
      const expectedInputGraph = graph.units.map((unit) => ({ id: unit.id, contentHash: unit.contentHash }));
      const actualInputGraph = image.inputGraph.map((unit) => ({ id: unit.id, contentHash: unit.contentHash }));
      if (JSON.stringify(actualInputGraph) !== JSON.stringify(expectedInputGraph)) {
        issues.push('program.image.inputGraph does not match the captured SourceUnit graph');
      }
    } catch (error) {
      issues.push(`program source/image closure could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const trace = manifest.artifacts?.oracle?.traceOut;
  if (trace && typeof trace !== 'string' && isSafeCaseRelativePath(trace.path)) {
    try {
      const traceFile = await resolveCaseFile(caseDir, trace.path);
      const traceBytes = await readBoundedRegularFile(traceFile, {
        maximumBytes: maximumReplayTraceBytes,
        expectedBytes: trace.bytes,
        label: 'artifacts.oracle.traceOut'
      });
      const traceText = traceBytes.toString('utf8');
      if (!Buffer.from(traceText, 'utf8').equals(traceBytes)) {
        throw new Error('captured oracle trace is not lossless UTF-8');
      }
      const digests = oracleEvidenceDigests(traceText, manifest.oracle.runConfiguration?.traceLevel ?? 1);
      if (digests.rawOutputDigest !== manifest.oracle.rawOutputDigest) issues.push('oracle.rawOutputDigest does not match captured traceOut');
      if (digests.eventDigest !== manifest.oracle.eventDigest) issues.push('oracle.eventDigest does not match captured traceOut');
      if (digests.finalStateDigest !== manifest.oracle.finalStateDigest) issues.push('oracle.finalStateDigest does not match captured traceOut');
      if (digests.eventCount !== manifest.oracle.eventCount) issues.push('oracle.eventCount does not match captured traceOut');
      if (digests.steps !== manifest.oracle.steps) issues.push('oracle.steps does not match captured traceOut');
    } catch (error) {
      issues.push(`oracle trace evidence could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...new Set(issues)];
}

export function isSafeCaseRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.includes('\\')
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false;
  }
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

async function verifySnapshot(
  caseDir: string,
  label: string,
  snapshot: AsmCaseSnapshot,
  issues: string[],
  reads: Map<string, Promise<Buffer>>
): Promise<void> {
  if (!isSafeCaseRelativePath(snapshot.path)) {
    return;
  }
  try {
    // Resolve every spelling before consulting the cache.  A lower-cased manifest path is
    // not an identity on case-sensitive filesystems (A.bin and a.bin may be different files).
    const resolved = await resolveCaseFile(caseDir, snapshot.path);
    const key = resolvedSnapshotPathKey(resolved);
    let pending = reads.get(key);
    if (!pending) {
      pending = (async () => {
        return await readBoundedRegularFile(resolved, {
          maximumBytes: replaySnapshotLimit(label),
          expectedBytes: snapshot.bytes,
          label
        });
      })();
      reads.set(key, pending);
    }
    const bytes = await pending;
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== snapshot.sha256.toLowerCase()) {
      issues.push(`${label}.sha256 mismatch`);
    }
  } catch (error) {
    issues.push(`${label} unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function replaySnapshotSetIssues(manifest: AsmCaseManifestV2): string[] {
  const issues: string[] = [];
  const references = replaySnapshotReferences(manifest);
  if (references.length > maximumReplaySnapshotReferences) {
    issues.push(`replay snapshot reference count exceeds the trusted limit ${maximumReplaySnapshotReferences}`);
    return issues;
  }
  const unique = new Map<string, { snapshot: AsmCaseSnapshot; label: string }>();
  let aggregateBytes = 0;
  for (const { label, snapshot } of references) {
    if (!isSafeCaseRelativePath(snapshot.path)) continue;
    const limit = replaySnapshotLimit(label);
    if (snapshot.bytes > limit) {
      issues.push(`${label} declared size ${snapshot.bytes} exceeds the hard limit ${limit}`);
    }
    const key = portableSnapshotPathKey(snapshot.path);
    const existing = unique.get(key);
    if (existing) {
      if (existing.snapshot.path !== snapshot.path) {
        issues.push(`${label} case-collides with ${existing.label} for a non-portable case-relative path`);
        continue;
      }
      if (existing.snapshot.bytes !== snapshot.bytes
        || existing.snapshot.sha256.toLowerCase() !== snapshot.sha256.toLowerCase()) {
        issues.push(`${label} conflicts with ${existing.label} for the same case-relative path`);
      }
      continue;
    }
    unique.set(key, { snapshot, label });
    aggregateBytes += snapshot.bytes;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > maximumReplayAggregateSnapshotBytes) {
      issues.push(`replay aggregate snapshot bytes exceed the trusted limit ${maximumReplayAggregateSnapshotBytes}`);
      break;
    }
  }
  if (unique.size > maximumReplayUniqueSnapshotPaths) {
    issues.push(`replay unique snapshot path count exceeds the trusted limit ${maximumReplayUniqueSnapshotPaths}`);
  }
  return issues;
}

function replaySnapshotReferences(
  manifest: AsmCaseManifestV2
): Array<{ label: string; snapshot: AsmCaseSnapshot }> {
  const references: Array<{ label: string; snapshot: AsmCaseSnapshot }> = [
    { label: 'asmSnapshot', snapshot: manifest.asmSnapshot }
  ];
  const add = (label: string, value: AsmCaseSnapshot | undefined): void => {
    if (value) references.push({ label, snapshot: value });
  };
  add('program.machineCode', manifest.program.machineCode);
  add('program.sourceGraph', manifest.program.sourceGraph);
  add('program.image', manifest.program.image);
  add('program.observability', manifest.program.observability);
  add('program.dutInput', manifest.program.dutInput);
  add('stdin', manifest.stdin);
  if (manifest.program.sourceMap && typeof manifest.program.sourceMap !== 'string') {
    add('program.sourceMap', manifest.program.sourceMap);
  }
  for (const [group, values] of Object.entries(manifest.artifacts ?? {})) {
    for (const [name, reference] of Object.entries(values ?? {}) as Array<[string, ManifestArtifactReference]>) {
      if (typeof reference !== 'string') add(`artifacts.${group}.${name}`, reference);
    }
  }
  return references;
}

function portableSnapshotPathKey(value: string): string {
  return value.toLowerCase();
}

function resolvedSnapshotPathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sourceArtifactClosureIssues(
  graph: SourceGraphBundle,
  artifacts: Record<string, ManifestArtifactReference> | undefined,
  issues: string[]
): void {
  const expectedNames = new Set<string>(['graph', 'original']);
  for (const unit of graph.units) {
    const blobName = `blob/${unit.contentHash}`;
    const materializedName = `materialized/${unit.id}`;
    expectedNames.add(blobName);
    expectedNames.add(materializedName);
    const blob = artifacts?.[blobName];
    if (!blob || typeof blob === 'string'
      || blob.path !== unit.blobPath
      || blob.bytes !== unit.bytes
      || blob.sha256.toLowerCase() !== unit.contentHash.toLowerCase()) {
      issues.push(`artifacts.source.${blobName} does not exactly identify its SourceUnit blob`);
    }
    const materialized = artifacts?.[materializedName];
    if (!materialized || typeof materialized === 'string'
      || materialized.path !== unit.materializedPath
      || materialized.sha256.toLowerCase() !== unit.materializedHash.toLowerCase()) {
      issues.push(`artifacts.source.${materializedName} does not exactly identify its derived SourceUnit view`);
    }
  }
  const unknown = Object.keys(artifacts ?? {}).filter((name) =>
    !expectedNames.has(name) && !name.startsWith('supplemental/'));
  if (unknown.length) {
    issues.push(`artifacts.source contains non-standard keys outside supplemental/: ${unknown.sort().join(', ')}`);
  }
}

const courseTextBase = 0x3000;

async function verifyProgramArtifactSemantics(
  manifest: AsmCaseManifestV2,
  caseDir: string,
  issues: string[]
): Promise<void> {
  const machineCode = manifest.program.machineCode!;
  const dutInput = manifest.program.dutInput!;
  const imageSnapshot = manifest.program.image!;
  try {
    const [machineCodeBytes, dutInputBytes, imageBytes] = await Promise.all([
      readVerifiedSnapshotAtUsePoint(caseDir, 'program.machineCode', machineCode),
      readVerifiedSnapshotAtUsePoint(caseDir, 'program.dutInput', dutInput),
      readVerifiedSnapshotAtUsePoint(caseDir, 'program.image', imageSnapshot)
    ]);
    if (!machineCodeBytes.equals(dutInputBytes)) {
      issues.push('program.dutInput bytes do not exactly match program.machineCode bytes');
      return;
    }

    let machineWords: number[];
    try {
      machineWords = parseStrictHexTextWords(machineCodeBytes.toString('utf8'));
    } catch (error) {
      issues.push(`program.machineCode is not strict HexText: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (machineCode.wordCount !== machineWords.length) {
      issues.push(`program.machineCode.wordCount mismatch: expected ${machineCode.wordCount}, parsed ${machineWords.length}`);
    }
    if (manifest.profile === 'P7') {
      for (const targetPc of manifest.oracle.runConfiguration?.interruptSchedule ?? []) {
        const anchorIssue = p7InterruptAnchorPairIssue(machineWords, targetPc, courseTextBase);
        if (anchorIssue) issues.push(`oracle.runConfiguration.interruptSchedule: ${anchorIssue}`);
      }
    }

    const image = deserializeProgramImage(imageBytes);
    const textSegments = image.segments.filter((segment) => segment.name === 'text');
    if (textSegments.length !== 1) {
      issues.push('program.image must contain exactly one text segment for HexText replay');
      return;
    }
    const text = textSegments[0];
    if (text.baseAddress !== courseTextBase || image.entryPc !== courseTextBase) {
      issues.push('program.image text base and entryPc must match the course text base 0x00003000');
    }
    if (text.words.length !== machineWords.length
      || text.words.some((word, index) => (word >>> 0) !== machineWords[index])) {
      issues.push('program.image text words do not match program.machineCode/program.dutInput HexText');
    }

    const requiresHaltLoop = manifest.oracle.runConfiguration?.haltPolicy?.kind === 'course-self-branch-nop';
    if (machineCode.haltPc === undefined && !requiresHaltLoop) {
      return;
    }
    if (machineWords.length < 2
      || machineWords[machineWords.length - 2] !== 0x1000ffff
      || machineWords[machineWords.length - 1] !== 0x00000000) {
      issues.push('program.machineCode haltPc does not identify a final 1000ffff/00000000 halt loop');
      return;
    }
    const branchWordIndex = machineWords.length - 2;
    const expectedHaltPc = courseTextBase + branchWordIndex * 4;
    if (!Number.isSafeInteger(expectedHaltPc) || expectedHaltPc > 0xffff_ffff
      || machineCode.haltPc !== expectedHaltPc
      || text.baseAddress + branchWordIndex * 4 !== expectedHaltPc) {
      issues.push('program.machineCode.haltPc does not match the final halt-loop word address/index');
    }
  } catch (error) {
    issues.push(`program artifact semantic closure could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readVerifiedSnapshotAtUsePoint(
  caseDir: string,
  label: string,
  snapshot: AsmCaseSnapshot
): Promise<Buffer> {
  const resolved = await resolveCaseFile(caseDir, snapshot.path);
  const bytes = await readBoundedRegularFile(resolved, {
    maximumBytes: replaySnapshotLimit(label),
    expectedBytes: snapshot.bytes,
    label
  });
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== snapshot.sha256.toLowerCase()) {
    throw new Error(`${label}.sha256 mismatch at semantic use point`);
  }
  return bytes;
}

function replaySnapshotLimit(label: string): number {
  if (label === 'stdin') return maximumReplayStdinBytes;
  if (label === 'program.machineCode' || label === 'program.dutInput'
    || label === 'artifacts.program.dutInput') {
    return maximumReplayMachineCodeBytes;
  }
  if (label === 'program.image' || label === 'artifacts.program.image') {
    return maximumReplayProgramImageBytes;
  }
  if (label === 'artifacts.oracle.traceOut') return maximumReplayTraceBytes;
  return maximumReplaySnapshotBytes;
}

/** Resolve a regular file while rejecting symlink escapes from a replay bundle. */
async function resolveCaseFile(caseDir: string, relativePath: string): Promise<string> {
  if (!isSafeCaseRelativePath(relativePath)) {
    throw new Error(`unsafe non-canonical case-relative path: ${relativePath}`);
  }
  const root = await fs.promises.realpath(caseDir);
  const candidate = path.resolve(root, ...relativePath.split('/'));
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
