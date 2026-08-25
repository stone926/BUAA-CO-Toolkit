// @index course-testing — ASM case manifest v1/v2 codec：v1 只读兼容、v2 新写、case-relative 路径
import * as fs from 'fs';
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
  /** Process-level provenance; present only for engines that spawn a process. */
  legacyProvenance?: {
    commandLine?: string;
    cwd?: string;
    memoryConfiguration?: string;
  };
}

export interface AsmCaseArtifactsV2 {
  source?: Record<string, string>;
  program?: Record<string, string>;
  oracle?: Record<string, string>;
  dut?: Record<string, string>;
  referenceMars?: Record<string, string>;
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
    imageFingerprint: string;
    machineCode?: AsmCaseMachineCode;
    /** Case-relative path when present; omitted by engines without a reliable map. */
    sourceMap?: string;
  };
  oracle: {
    engine: ManifestEngineInfo;
    configurationHash: string;
    stopReason: 'halt-loop' | 'step-limit' | 'error' | 'unknown';
    steps?: number;
    finalStateDigest?: string;
  };
  artifacts?: AsmCaseArtifactsV2;
}

export type AsmCaseManifestUnion = AsmCaseManifest | AsmCaseManifestV2;

// ── Classification ────────────────────────────────────────────────────────────

export function isManifestV2(manifest: AsmCaseManifestUnion): manifest is AsmCaseManifestV2 {
  return manifest.version === asmCaseManifestVersion2;
}

/** Accept any known manifest version; structural fields are checked by callers. */
export function isKnownManifest(manifest: unknown): manifest is AsmCaseManifestUnion {
  if (!manifest || typeof manifest !== 'object') {
    return false;
  }
  const candidate = manifest as { version?: unknown; caseId?: unknown };
  if (candidate.version === 1) {
    return typeof candidate.caseId === 'string';
  }
  if (candidate.version === asmCaseManifestVersion2) {
    const v2 = manifest as Partial<AsmCaseManifestV2>;
    return typeof candidate.caseId === 'string'
      && typeof v2.program === 'object'
      && typeof v2.oracle === 'object';
  }
  return false;
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
    result.source = artifacts.source;
  }
  if (artifacts.program) {
    result.program = artifacts.program;
  }
  if (artifacts.oracle) {
    result.mars = artifacts.oracle;
  }
  if (artifacts.referenceMars) {
    result.referenceMars = artifacts.referenceMars;
  }
  if (artifacts.dut) {
    result.verilog = {};
    result.logisim = {};
    for (const [name, value] of Object.entries(artifacts.dut)) {
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

/**
 * Minimal v2 replay closure check (计划 5.8): a bundle must be replayable
 * without the original workspace. Phase 1 requires the ASM snapshot hash, the
 * image fingerprint, the machine-code hash and both engine ids; later phases
 * tighten this (source blobs, engine registry, observability schema).
 */
export function v2ReplayClosureIssues(manifest: AsmCaseManifestV2): string[] {
  const issues: string[] = [];
  if (!manifest.asmSnapshot?.sha256) {
    issues.push('asmSnapshot.sha256 missing');
  }
  if (!manifest.program?.imageFingerprint) {
    issues.push('program.imageFingerprint missing');
  }
  if (!manifest.program?.assembler?.id) {
    issues.push('program.assembler.id missing');
  }
  if (!manifest.program?.machineCode?.sha256) {
    issues.push('program.machineCode.sha256 missing (image not dumped yet)');
  }
  if (!manifest.oracle?.engine?.id) {
    issues.push('oracle.engine.id missing');
  }
  return issues;
}

// ── Atomic write ──────────────────────────────────────────────────────────────

/**
 * Write a manifest via temp file + rename so cancellation or a crash never
 * leaves a half-written JSON behind (计划 5.8: manifest 用临时文件+原子 rename)。
 * The case directory is always a local file path, so node fs is safe here.
 */
export async function writeManifestAtomic(manifestPath: string, manifest: AsmCaseManifestUnion): Promise<void> {
  const tempPath = `${manifestPath}.tmp-${process.pid}`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  try {
    await fs.promises.rename(tempPath, manifestPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
