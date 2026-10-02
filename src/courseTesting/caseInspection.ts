// @index course-case-inspection — Read-only, case-contained diagnostics for saved ASM cases
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ProgramImage } from '../mips/core/api';
import { maximumReplayManifestBytes, maximumReplaySnapshotBytes, maximumReplaySourceBytes, maximumReplayProgramImageBytes, maximumReplayTraceBytes, readBoundedRegularFile } from '../mips/replay/boundedFile';
import { sha256Bytes } from '../asmCaseStoreCore';
import type { AsmCase } from '../asmCaseStore';
import type { AsmCaseManifestUnion, AsmCaseManifestV2, ManifestArtifactReference } from './manifestCodec';
import type { AsmCaseSnapshot } from '../asmCaseStoreCore';
import { isKnownManifest, isManifestV2, isSafeCaseRelativePath } from './manifestCodec';
import { deserializeProgramImage } from '../mips/replay/programImage';
import { loadVerifiedSourceGraphInput, type SourceGraphBundle } from '../mips/replay/sourceBundle';
import { assertContainedDirectoryPath } from '../pathContainment';

export interface CaseInspectionTextArtifact {
  readonly uri: vscode.Uri;
}

export interface CaseSourceLocation {
  readonly pc: number;
  readonly uri: vscode.Uri;
  /** One-based source line. */
  readonly line: number;
  readonly text: string;
}

export interface CaseInspection {
  readonly asmCase: AsmCase;
  /** True only when the case-local root source (and v2 source closure) was verified. */
  readonly sourceAvailable: boolean;
  readonly image?: ProgramImage;
  readonly oracle?: CaseInspectionTextArtifact;
  readonly dut?: CaseInspectionTextArtifact;
  readonly logs: readonly { readonly label: string; readonly uri: vscode.Uri }[];
  readonly warnings: readonly string[];
  /** Private validated source data used by findSourceAtPc. */
  readonly sourceGraph?: SourceGraphBundle;
  readonly sourceTexts?: ReadonlyMap<string, string>;
  readonly sourceUris?: ReadonlyMap<string, vscode.Uri>;
}

const validCaseId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const maximumSourceGraphSnapshotBytes = 2 * 1024 * 1024;

/**
 * Load one known case by its ID. All paths are rooted at the supplied cases directory;
 * source provenance paths are never used as navigation targets.
 */
export async function loadCaseInspection(casesDirectory: string, caseId: string): Promise<CaseInspection> {
  if (!validCaseId.test(caseId) || caseId === '.' || caseId === '..') {
    throw new Error('Invalid ASM case ID');
  }
  const casesPath = path.resolve(casesDirectory);
  const trustedWorkspaceRoot = path.dirname(path.dirname(casesPath));
  await assertContainedDirectoryPath(trustedWorkspaceRoot, casesPath);
  const casesRoot = await fs.realpath(casesPath);
  const rootStat = await fs.stat(casesRoot);
  if (!rootStat.isDirectory()) throw new Error('ASM cases path is not a directory');
  const caseDir = await resolveCaseDirectory(casesRoot, caseId);
  const manifestPath = path.join(caseDir, 'case.json');
  const manifestBytes = await readBoundedRegularFile(manifestPath, {
    maximumBytes: maximumReplayManifestBytes,
    label: 'ASM case manifest'
  });
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('ASM case manifest is not valid JSON');
  }
  if (!isKnownManifest(rawManifest) || rawManifest.caseId !== caseId) {
    throw new Error('ASM case manifest is invalid or its case ID does not match');
  }
  const manifest = rawManifest;
  const warnings: string[] = [];
  const caseRootUri = vscode.Uri.file(caseDir);
  let asmUri = vscode.Uri.joinPath(caseRootUri, 'program.asm');
  let asmSnapshotVerified = false;
  if (isManifestV2(manifest)) {
    try {
      await readSnapshot(caseDir, manifest.asmSnapshot, maximumReplaySourceBytes, 'case ASM source');
      asmUri = await resolveManifestFile(caseDir, manifest.asmSnapshot.path);
      asmSnapshotVerified = true;
    } catch (error) {
      warnings.push(`ASM 源文件不可用：${errorText(error)}`);
    }
  } else {
    try {
      asmUri = await resolveManifestFile(caseDir, 'program.asm');
      await readBoundedRegularFile(asmUri.fsPath, { maximumBytes: maximumReplaySourceBytes, label: 'legacy case ASM source' });
      warnings.push('旧版 ASM 没有内容哈希，仅验证了 case 目录内文件');
    } catch (error) {
      warnings.push(`ASM 源文件不可用：${errorText(error)}`);
    }
  }
  const machineCodeSnapshot = isManifestV2(manifest) ? manifest.program.machineCode : manifest.machineCode;
  const machineCodeUri = machineCodeSnapshot
    ? await resolveManifestFile(caseDir, machineCodeSnapshot.path).catch(() => vscode.Uri.joinPath(caseRootUri, 'code.txt'))
    : vscode.Uri.joinPath(caseRootUri, 'code.txt');
  const stdinUri = manifest.stdin && isSafeCaseRelativePath(manifest.stdin.path)
    ? await resolveManifestFile(caseDir, manifest.stdin.path).catch(() => undefined)
    : undefined;

  let sourceGraph: SourceGraphBundle | undefined;
  let sourceTexts: Map<string, string> | undefined;
  let sourceUris: Map<string, vscode.Uri> | undefined;
  let sourceAsmUri = asmUri;
  let sourceAvailable = false;
  let image: ProgramImage | undefined;
  if (isManifestV2(manifest)) {
    try {
      const sourceGraphReference = manifest.program.sourceGraph;
      if (!sourceGraphReference || typeof sourceGraphReference === 'string') {
        throw new Error('source graph snapshot is missing');
      }
      await readSnapshot(caseDir, sourceGraphReference, maximumSourceGraphSnapshotBytes, 'program source graph');
      const verified = await loadVerifiedSourceGraphInput(caseDir, sourceGraphReference.path);
      sourceGraph = verified.graph;
      sourceTexts = new Map(verified.sourceGraphInput.sources.map((unit) => [unit.id, unit.text]));
      sourceUris = new Map(await Promise.all(sourceGraph.units.map(async (unit) => [
        unit.id,
        await resolveManifestFile(caseDir, unit.materializedPath)
      ] as const)));
      const rootUnit = sourceGraph.units.find((unit) => unit.id === sourceGraph!.rootId);
      if (!rootUnit) throw new Error('source graph root unit is missing');
      sourceAsmUri = sourceUris.get(rootUnit.id)!;
      sourceAvailable = asmSnapshotVerified;
    } catch (error) {
      warnings.push(`源码映射不可用：${errorText(error)}`);
    }
    try {
      image = await readProgramImage(caseDir, manifest);
    } catch (error) {
      warnings.push(`程序映像不可用：${errorText(error)}`);
    }
    if (image && sourceGraph && !imageSourceGraphMatches(image, sourceGraph)) {
      warnings.push('程序映像与已验证的源码图不匹配，已停用 PC 源码定位');
      image = undefined;
    }
  } else {
    warnings.push('旧版用例没有可验证的程序映像，无法按 PC 定位源码');
    try {
      const legacyAsm = await resolveManifestFile(caseDir, 'program.asm');
      await readBoundedRegularFile(legacyAsm.fsPath, { maximumBytes: maximumReplaySourceBytes, label: 'legacy case ASM source' });
      sourceAsmUri = legacyAsm;
      sourceAvailable = true;
      asmSnapshotVerified = true;
    } catch (error) {
      warnings.push(`源码不可用：${errorText(error)}`);
    }
  }

  const asmCase: AsmCase = {
    id: manifest.caseId,
    dir: caseRootUri,
    manifestUri: vscode.Uri.joinPath(caseRootUri, 'case.json'),
    asm: asmUri,
    machineCode: machineCodeUri,
    sourceAsm: sourceAsmUri,
    ...(stdinUri ? { stdin: stdinUri } : {}),
    manifest
  };

  const oracle = await loadTraceArtifact(caseDir, manifest, 'oracle', warnings);
  const dut = await loadDutTraceArtifact(caseDir, manifest, warnings);
  const logs = await loadFailureLogs(caseDir, manifest, warnings);
  return {
    asmCase,
    sourceAvailable,
    ...(image && sourceGraph && sourceTexts && sourceUris ? { image, sourceGraph, sourceTexts, sourceUris } : {}),
    ...(oracle ? { oracle } : {}),
    ...(dut ? { dut } : {}),
    logs,
    warnings
  };
}

/** Resolve one aligned PC to a case-local materialized source file. */
export function findSourceAtPc(inspection: CaseInspection, pc: number): CaseSourceLocation | undefined {
  const image = inspection.image;
  const graph = inspection.sourceGraph;
  const sourceTexts = inspection.sourceTexts;
  const sourceUris = inspection.sourceUris;
  if (!image || !graph || !sourceTexts || !sourceUris
    || !Number.isSafeInteger(pc) || pc < 0 || pc > 0xffff_ffff || (pc & 3) !== 0) {
    return undefined;
  }
  for (let segmentIndex = 0; segmentIndex < image.segments.length; segmentIndex++) {
    const segment = image.segments[segmentIndex];
    const delta = pc - segment.baseAddress;
    if (delta < 0 || delta % 4 !== 0) continue;
    const wordIndex = delta / 4;
    if (wordIndex >= segment.words.length) continue;
    const origin = image.sourceMap.find((entry) => entry.segmentIndex === segmentIndex && entry.wordIndex === wordIndex);
    if (!origin || origin.startOffset === undefined) return undefined;
    const unit = graph.units.find((candidate) => candidate.id === origin.sourceId);
    const text = sourceTexts.get(origin.sourceId);
    if (!unit || text === undefined || origin.startOffset < 0 || origin.startOffset > text.length) return undefined;
    const line = lineAtOffset(text, origin.startOffset);
    const sourceLine = lineText(text, line);
    const sourceUri = sourceUris.get(unit.id);
    return sourceUri ? { pc: pc >>> 0, uri: sourceUri, line, text: sourceLine } : undefined;
  }
  return undefined;
}

/** Verify large waveforms only when opened, not on every history/diagnosis read. */
export async function loadCaseWaveform(inspection: CaseInspection): Promise<vscode.Uri | undefined> {
  const manifest = inspection.asmCase.manifest;
  if (!isManifestV2(manifest)) return undefined;
  const reference = manifest.artifacts?.dut?.['verilog/waveform'];
  if (!reference || typeof reference === 'string') return undefined;
  await readSnapshot(inspection.asmCase.dir.fsPath, reference, maximumReplaySnapshotBytes, '已保存的波形');
  return resolveManifestFile(inspection.asmCase.dir.fsPath, reference.path);
}

/** Revalidate the captured artifacts when comparison is requested; don't retain logs in the diagnosis panel. */
export async function loadCaseWritebackTexts(inspection: CaseInspection): Promise<{ oracle: string; dut: string }> {
  const { manifest, dir } = inspection.asmCase;
  const oracle = manifest.artifacts?.oracle?.traceOut;
  const dut = dutTraceReference(manifest);
  if (!oracle || !dut) throw new Error('本用例缺少成对的写回记录。');
  const [left, right] = await Promise.all([
    readVerifiedTextArtifact(dir.fsPath, oracle, maximumReplayTraceBytes, '参考写回记录'),
    readVerifiedTextArtifact(dir.fsPath, dut, maximumReplayTraceBytes, '待测 CPU 写回记录')
  ]);
  return { oracle: left.text, dut: right.text };
}

async function resolveCaseDirectory(casesRoot: string, caseId: string): Promise<string> {
  const lexical = path.resolve(casesRoot, caseId);
  if (path.dirname(lexical) !== casesRoot) throw new Error('ASM case is outside the cases directory');
  await assertContainedDirectoryPath(casesRoot, lexical);
  return await fs.realpath(lexical);
}

async function resolveManifestFile(caseDir: string, relativePath: string): Promise<vscode.Uri> {
  if (!isSafeCaseRelativePath(relativePath)) throw new Error('unsafe case-relative file path');
  const candidate = path.resolve(caseDir, ...relativePath.split('/'));
  const real = await fs.realpath(candidate);
  const relative = path.relative(caseDir, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('case file path escapes the case directory');
  }
  const info = await fs.stat(real);
  if (!info.isFile()) throw new Error('case artifact is not a regular file');
  return vscode.Uri.file(real);
}

async function readProgramImage(caseDir: string, manifest: AsmCaseManifestV2): Promise<ProgramImage | undefined> {
  const snapshot = manifest.program.image;
  if (!snapshot || typeof snapshot === 'string') throw new Error('program image snapshot is missing');
  const bytes = await readSnapshot(caseDir, snapshot, maximumReplayProgramImageBytes, 'program image');
  const image = deserializeProgramImage(bytes);
  if (manifest.program.imageFingerprint && image.fingerprint !== manifest.program.imageFingerprint) {
    throw new Error('program image fingerprint does not match the manifest');
  }
  return image;
}

async function readSnapshot(caseDir: string, snapshot: AsmCaseSnapshot, maximumBytes: number, label: string): Promise<Buffer> {
  const uri = await resolveManifestFile(caseDir, snapshot.path);
  const bytes = await readBoundedRegularFile(uri.fsPath, {
    maximumBytes,
    expectedBytes: snapshot.bytes,
    label
  });
  if (sha256Bytes(bytes) !== snapshot.sha256.toLowerCase()) throw new Error(`${label} hash does not match the manifest`);
  return bytes;
}

function imageSourceGraphMatches(image: ProgramImage, graph: SourceGraphBundle): boolean {
  const expected = new Map(graph.units.map((unit) => [unit.id, unit.contentHash.toLowerCase()]));
  return image.inputGraph.length === expected.size
    && image.inputGraph.every((unit) => expected.get(unit.id) === unit.contentHash.toLowerCase());
}

async function loadTraceArtifact(
  caseDir: string,
  manifest: AsmCaseManifestUnion,
  kind: 'oracle',
  warnings: string[]
): Promise<CaseInspectionTextArtifact | undefined> {
  const reference = isManifestV2(manifest)
    ? manifest.artifacts?.oracle?.traceOut
    : manifest.artifacts?.oracle?.traceOut;
  return await readTextArtifact(caseDir, reference, maximumReplayTraceBytes, '参考写回记录', warnings);
}

async function loadDutTraceArtifact(
  caseDir: string,
  manifest: AsmCaseManifestUnion,
  warnings: string[]
): Promise<CaseInspectionTextArtifact | undefined> {
  return await readTextArtifact(caseDir, dutTraceReference(manifest), maximumReplayTraceBytes, '待测 CPU 写回记录', warnings);
}

function dutTraceReference(manifest: AsmCaseManifestUnion): ManifestArtifactReference | undefined {
  return dutArtifactCandidates(manifest).find((entry) => /(?:^|\/)(?:simOut|traceOut|dutOut)$/i.test(entry.key))?.reference;
}

async function loadFailureLogs(
  caseDir: string,
  manifest: AsmCaseManifestUnion,
  warnings: string[]
): Promise<Array<{ label: string; uri: vscode.Uri }>> {
  const result: Array<{ label: string; uri: vscode.Uri }> = [];
  for (const { key, reference } of dutArtifactCandidates(manifest)) {
    if (!/(?:compile|simulation).*log$/i.test(key)) continue;
    const label = /compile/i.test(key) ? 'Icarus 编译日志' : 'Icarus 仿真日志';
    const artifact = await readTextArtifact(caseDir, reference, maximumReplaySnapshotBytes, label, warnings);
    if (artifact) result.push({ label, ...artifact });
  }
  return result;
}

function dutArtifactCandidates(manifest: AsmCaseManifestUnion): Array<{ key: string; reference: ManifestArtifactReference }> {
  if (isManifestV2(manifest)) {
    return Object.entries(manifest.artifacts?.dut ?? {}).map(([key, reference]) => ({ key, reference }));
  }
  return [
    ...Object.entries(manifest.artifacts?.verilog ?? {}),
    ...Object.entries(manifest.artifacts?.logisim ?? {})
  ].map(([key, reference]) => ({ key, reference }));
}

async function readTextArtifact(
  caseDir: string,
  reference: ManifestArtifactReference | string | undefined,
  maximumBytes: number,
  label: string,
  warnings: string[]
): Promise<CaseInspectionTextArtifact | undefined> {
  if (reference === undefined) return undefined;
  try {
    const { uri } = await readVerifiedTextArtifact(caseDir, reference, maximumBytes, label);
    if (typeof reference === 'string') warnings.push(`${label}来自旧版未哈希 artifact`);
    // Keep large trace/log text out of the panel's lifetime; navigation needs only its URI.
    return { uri };
  } catch (error) {
    warnings.push(`${label}不可用：${errorText(error)}`);
    return undefined;
  }
}

async function readVerifiedTextArtifact(
  caseDir: string, reference: ManifestArtifactReference, maximumBytes: number, label: string
): Promise<{ uri: vscode.Uri; text: string }> {
  const relative = typeof reference === 'string' ? legacyRelativePath(caseDir, reference) : reference.path;
  const uri = await resolveManifestFile(caseDir, relative);
  const bytes = await readBoundedRegularFile(uri.fsPath, {
    maximumBytes, label, ...(typeof reference === 'string' ? {} : { expectedBytes: reference.bytes })
  });
  if (typeof reference !== 'string' && sha256Bytes(bytes) !== reference.sha256.toLowerCase()) {
    throw new Error(`${label} hash does not match the manifest`);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} is not lossless UTF-8`);
  return { uri, text };
}

function legacyRelativePath(caseDir: string, recordedPath: string): string {
  if (isSafeCaseRelativePath(recordedPath)) return recordedPath;
  if (!path.isAbsolute(recordedPath)) throw new Error('旧版 artifact 路径无效');
  const relative = path.relative(caseDir, path.resolve(recordedPath));
  const slashPath = relative.split(path.sep).join('/');
  if (!isSafeCaseRelativePath(slashPath)) throw new Error('旧版 artifact 路径不在 case 目录内');
  return slashPath;
}

function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (text[index] === '\r') {
      if (text[index + 1] === '\n' && index + 1 < offset) index++;
      line++;
    } else if (text[index] === '\n') line++;
  }
  return line;
}

function lineText(text: string, oneBasedLine: number): string {
  let line = 1;
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text[index] !== '\n' && text[index] !== '\r') continue;
    if (line === oneBasedLine) return text.slice(start, index);
    if (text[index] === '\r' && text[index + 1] === '\n') index++;
    start = index + 1;
    line++;
  }
  return '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
