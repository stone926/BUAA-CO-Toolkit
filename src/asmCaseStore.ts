import { CO_CASES_DIR } from './constants';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { getMemoryConfiguration, getProfile } from './config';
import { ensureDirectory, pathExists, readTextFile, workspaceFolderForOrFirst, writeTextFile } from './fsUtil';
import { normalizePathKey } from './pathUtils';
import { MarsRunOptions } from './mips';
import { AppServices } from './types';
import { resolveFileInput } from './workflowInputs';
import { assembleWithPreflight, preflightFailureMessage } from './mips/providers/providerResolver';
import { AssembleResult, EngineArtifactIdentity, ExecuteResult } from './mips/providers/contracts';
import { EngineDescriptor } from './mips/core/api';
import {
  AsmCaseArtifactKind,
  AsmCaseManifest,
  AsmCaseP7Metadata,
  AsmCaseSource,
  asmCaseId,
  asmCasePaths,
  machineCodeWordCount,
  sha256Bytes
} from './asmCaseStoreCore';
import {
  AsmCaseManifestUnion,
  AsmCaseManifestV2,
  AsmCaseArtifactsV2,
  ManifestEngineInfo,
  ManifestArtifactReference,
  ManifestRunConfiguration,
  asmCaseManifestVersion2,
  isKnownManifest,
  isManifestV2,
  manifestRunConfigurationHash,
  v2ArtifactGroup,
  writeManifestAtomic
} from './courseTesting/manifestCodec';
import { LEGACY_MARS_DESCRIPTOR } from './mips/providers/contracts';
import { courseMachineCodeValidationError } from './courseTesting/machineCodeValidation';

export interface AsmCase {
  id: string;
  dir: vscode.Uri;
  manifestUri: vscode.Uri;
  asm: vscode.Uri;
  machineCode: vscode.Uri;
  sourceAsm: vscode.Uri;
  stdin?: vscode.Uri;
  manifest: AsmCaseManifestUnion;
}

export interface CreateAsmCaseOptions {
  source?: AsmCaseSource;
  stdin?: vscode.Uri;
  resource?: vscode.Uri;
  createdAt?: Date;
  p7?: AsmCaseP7Metadata;
}

export async function resolveAsmCaseInput(title = '选择 MIPS ASM 文件'): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  return await resolveFileInput({
    title,
    active: { predicate: isAsmFile, saveDirty: true },
    folder: workspaceFolderForOrFirst(active),
    include: '**/*.{asm,s,mips}',
    exclude: asmCaseInputExcludeGlob,
    maxResults: 500,
    filters: {
      ASM: ['asm', 's', 'mips'],
      All: ['*']
    }
  });
}

export async function createAsmCaseFromAsm(
  asm: vscode.Uri,
  options: CreateAsmCaseOptions = {}
): Promise<AsmCase> {
  const asmBytes = await vscode.workspace.fs.readFile(asm);
  const asmHash = sha256Bytes(asmBytes);
  const root = caseWorkspaceRoot(options.resource ?? asm);
  const createdAt = options.createdAt ?? new Date();
  const paths = await nextAsmCasePaths(root, createdAt, asmHash);
  const caseDir = vscode.Uri.file(paths.caseDir);
  await ensureDirectory(caseDir);

  const caseAsm = vscode.Uri.file(paths.asm);
  await vscode.workspace.fs.writeFile(caseAsm, asmBytes);

  const p7 = normalizeP7Metadata(options.p7);
  const stdin = options.stdin ? await copyStdinSnapshot(options.stdin, paths.stdinDir) : undefined;

  const manifest = createV2Manifest(
    path.basename(paths.caseDir),
    createdAt,
    getProfile(options.resource ?? asm),
    getMemoryConfiguration(options.resource ?? asm),
    asm.fsPath,
    {
      path: 'program.asm',
      sha256: asmHash,
      bytes: asmBytes.byteLength
    },
    options.source ?? { kind: 'selected' },
    stdin?.snapshot,
    p7
  );
  const manifestUri = vscode.Uri.file(paths.manifest);
  await writeManifestAtomic(paths.manifest, manifest);

  return {
    id: manifest.caseId,
    dir: caseDir,
    manifestUri,
    asm: caseAsm,
    machineCode: vscode.Uri.file(paths.machineCode),
    sourceAsm: asm,
    stdin: stdin?.uri,
    manifest
  };
}

export async function createAsmCaseFromText(
  fileName: string,
  text: string,
  options: CreateAsmCaseOptions = {}
): Promise<AsmCase> {
  const bytes = Buffer.from(text, 'utf8');
  const asmHash = sha256Bytes(bytes);
  const root = caseWorkspaceRoot(options.resource);
  const createdAt = options.createdAt ?? new Date();
  const paths = await nextAsmCasePaths(root, createdAt, asmHash);
  const caseDir = vscode.Uri.file(paths.caseDir);
  await ensureDirectory(caseDir);

  const caseAsm = vscode.Uri.file(paths.asm);
  await vscode.workspace.fs.writeFile(caseAsm, bytes);
  const p7 = normalizeP7Metadata(options.p7);
  const stdin = options.stdin ? await copyStdinSnapshot(options.stdin, paths.stdinDir) : undefined;
  const manifest = createV2Manifest(
    path.basename(paths.caseDir),
    createdAt,
    getProfile(options.resource),
    getMemoryConfiguration(options.resource),
    fileName,
    {
      path: 'program.asm',
      sha256: asmHash,
      bytes: bytes.byteLength
    },
    options.source ?? { kind: 'builtin' },
    stdin?.snapshot,
    p7
  );
  const manifestUri = vscode.Uri.file(paths.manifest);
  await writeManifestAtomic(paths.manifest, manifest);

  return {
    id: manifest.caseId,
    dir: caseDir,
    manifestUri,
    asm: caseAsm,
    machineCode: vscode.Uri.file(paths.machineCode),
    sourceAsm: caseAsm,
    stdin: stdin?.uri,
    manifest
  };
}

export async function prepareAsmCaseMachineCode(
  services: AppServices,
  asmCase: AsmCase,
  options: MarsRunOptions = {}
): Promise<AssembleResult | undefined> {
  assertWritableV2Case(asmCase);
  try {
    await assertAsmCaseSourceSnapshotCurrent(asmCase);
  } catch (error) {
    return sourceIntegrityAssembleFailure(error);
  }
  const invocation = await assembleWithPreflight(services, {
    sourceUri: asmCase.sourceAsm,
    target: { kind: 'userText', outputFile: asmCase.machineCode },
    courseTrace: options.courseTrace,
    p7RiInstruction: options.p7RiInstruction,
    revealOutput: options.revealOutput
  }, { signal: options.signal });
  const dump = invocation.result ?? {
    ok: false,
    status: {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: preflightFailureMessage(invocation.preflight),
      timedOut: false
    },
    descriptor: invocation.preflight.descriptor
  };
  if (!dump.ok || !dump.outputFile) {
    return dump;
  }

  try {
    // Detect edits that raced the external assembler. The generated image must
    // never be recorded against a different root-source snapshot.
    await assertAsmCaseSourceSnapshotCurrent(asmCase);
  } catch (error) {
    return {
      ...dump,
      ok: false,
      outputFile: undefined,
      status: failedEngineStatusFrom(dump.status, sourceIntegrityMessage(error))
    };
  }

  const bytes = await vscode.workspace.fs.readFile(asmCase.machineCode);
  const text = Buffer.from(bytes).toString('utf8');
  if (options.courseTrace) {
    const asmText = await readTextFile(asmCase.sourceAsm);
    const validationError = courseMachineCodeValidationError(
      getProfile(asmCase.sourceAsm),
      text,
      asmText,
      asmCase.manifest.source.kind === 'builtin'
    );
    if (validationError) {
      services.output.appendLine(validationError);
      return {
        ...dump,
        ok: false,
        status: {
          ...dump.status,
          ok: false,
          stderr: dump.status.stderr ? `${dump.status.stderr}\n${validationError}` : validationError
        }
      };
    }
  }
  try {
    await assertAsmCaseSourceSnapshotCurrent(asmCase);
  } catch (error) {
    return {
      ...dump,
      ok: false,
      outputFile: undefined,
      status: failedEngineStatusFrom(dump.status, sourceIntegrityMessage(error))
    };
  }
  const machineCode: AsmCaseManifest['machineCode'] = {
    path: asmCase.machineCode.fsPath,
    sha256: sha256Bytes(bytes),
    bytes: bytes.byteLength,
    wordCount: machineCodeWordCount(text),
    haltPc: dump.courseHaltPc
  };
  const legacyProvenance = {
    commandLine: dump.status.commandLine ?? dump.descriptor.id,
    cwd: dump.status.cwd ?? path.dirname(asmCase.sourceAsm.fsPath),
    memoryConfiguration: getMemoryConfiguration(asmCase.sourceAsm)
  };
  const assembler = manifestEngineInfo(dump.descriptor, dump.engineArtifact);
  asmCase.manifest = {
    ...asmCase.manifest,
    program: {
      ...asmCase.manifest.program,
      machineCode: { ...machineCode, path: 'code.txt' },
      imageFingerprint: machineCode.sha256,
      assembler: {
        ...assembler,
        legacyProvenance
      }
    }
  };
  await writeAsmCaseManifest(asmCase);
  return dump;
}

/** Record a completed oracle run only after its halt/error policy has been verified. */
export async function recordAsmCaseOracleResult(
  asmCase: AsmCase,
  result: ExecuteResult,
  configuration: ManifestRunConfiguration,
  outcome: {
    stopReason: AsmCaseManifestV2['oracle']['stopReason'];
    steps?: number;
    finalStateDigest?: string;
  }
): Promise<void> {
  assertWritableV2Case(asmCase);
  // Last-line defence against source edits that raced the oracle process.
  await assertAsmCaseSourceSnapshotCurrent(asmCase);
  const engine = manifestEngineInfo(result.descriptor, result.engineArtifact);
  asmCase.manifest = {
    ...asmCase.manifest,
    oracle: {
      engine: {
        ...engine,
        legacyProvenance: {
          commandLine: result.status.commandLine,
          cwd: result.status.cwd,
          memoryConfiguration: configuration.memoryConfiguration
        }
      },
      configurationHash: manifestRunConfigurationHash(configuration, engine),
      runConfiguration: configuration,
      stopReason: outcome.stopReason,
      steps: outcome.steps,
      finalStateDigest: outcome.finalStateDigest
    }
  };
  await writeAsmCaseManifest(asmCase);
}

export async function updateAsmCaseArtifacts(
  asmCase: AsmCase,
  kind: AsmCaseArtifactKind,
  artifacts: Record<string, string>
): Promise<void> {
  assertWritableV2Case(asmCase);
  assertManifestEntries(artifacts, 'artifact');
  // File artifacts are content-addressed; metadata must use the separate API.
  const snapshots = await Promise.all(Object.entries(artifacts).map(async ([name, file]) => {
      if (!path.isAbsolute(file)) {
        throw new Error(`ASM case artifact ${name} must be an absolute file path`);
      }
      const relativePath = await caseRelativePath(asmCase, file);
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) {
        throw new Error(`ASM case artifact ${name} is not a regular file: ${file}`);
      }
      const bytes = await fs.promises.readFile(file);
      return [name, {
        path: relativePath,
        sha256: sha256Bytes(bytes),
        bytes: bytes.byteLength
      }] as const;
  }));
  const groups = new Map<keyof AsmCaseArtifactsV2, Record<string, ManifestArtifactReference>>();
  for (const [name, value] of snapshots) {
    const { group, key } = v2ArtifactGroup(kind, name);
    const entry = groups.get(group) ?? {};
    entry[key] = value;
    groups.set(group, entry);
  }
  const merged: NonNullable<AsmCaseManifestV2['artifacts']> = { ...(asmCase.manifest.artifacts ?? {}) };
  for (const [group, values] of groups) {
    const key = group as keyof NonNullable<AsmCaseManifestV2['artifacts']>;
    merged[key] = { ...(merged[key] ?? {}), ...values };
  }
  asmCase.manifest = { ...asmCase.manifest, artifacts: merged };
  await writeAsmCaseManifest(asmCase);
}

/** Store non-file provenance without letting it masquerade as a replay blob. */
export async function updateAsmCaseMetadata(
  asmCase: AsmCase,
  metadata: Record<string, string>
): Promise<void> {
  assertWritableV2Case(asmCase);
  assertManifestEntries(metadata, 'metadata');
  asmCase.manifest = {
    ...asmCase.manifest,
    metadata: { ...(asmCase.manifest.metadata ?? {}), ...metadata }
  };
  await writeAsmCaseManifest(asmCase);
}

async function caseRelativePath(asmCase: AsmCase, absolutePath: string): Promise<string> {
  const relative = path.relative(asmCase.dir.fsPath, absolutePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`ASM case artifact must be copied inside the case directory: ${absolutePath}`);
  }
  const [realCaseDir, realArtifact] = await Promise.all([
    fs.promises.realpath(asmCase.dir.fsPath),
    fs.promises.realpath(absolutePath)
  ]);
  const realRelative = path.relative(realCaseDir, realArtifact);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`ASM case artifact resolves outside the case directory: ${absolutePath}`);
  }
  return relative.split(path.sep).join('/');
}

export async function writeAsmCaseArtifact(
  asmCase: AsmCase,
  kind: 'verilog' | 'logisim' | 'mars',
  fileName: string,
  content: string,
  artifactName = path.basename(fileName, path.extname(fileName))
): Promise<vscode.Uri> {
  assertWritableV2Case(asmCase);
  const dir = artifactDirectory(asmCase, kind);
  await ensureDirectory(dir);
  const uri = vscode.Uri.file(path.join(dir.fsPath, path.basename(fileName)));
  await writeTextFile(uri, content);
  await updateAsmCaseArtifacts(asmCase, kind, { [artifactName]: uri.fsPath });
  return uri;
}

export function asmCaseArtifactUri(
  asmCase: AsmCase,
  kind: 'verilog' | 'logisim' | 'mars',
  fileName: string
): vscode.Uri {
  return vscode.Uri.file(path.join(artifactDirectory(asmCase, kind).fsPath, path.basename(fileName)));
}

export async function copyAsmCaseArtifact(
  asmCase: AsmCase,
  kind: 'verilog' | 'logisim' | 'mars',
  source: vscode.Uri,
  fileName = path.basename(source.fsPath),
  artifactName = path.basename(fileName, path.extname(fileName))
): Promise<vscode.Uri> {
  assertWritableV2Case(asmCase);
  const dir = artifactDirectory(asmCase, kind);
  await ensureDirectory(dir);
  const target = vscode.Uri.file(path.join(dir.fsPath, path.basename(fileName)));
  if (normalizePathKey(source.fsPath) !== normalizePathKey(target.fsPath)) {
    const bytes = await vscode.workspace.fs.readFile(source);
    await vscode.workspace.fs.writeFile(target, bytes);
  }
  await updateAsmCaseArtifacts(asmCase, kind, { [artifactName]: target.fsPath });
  return target;
}

export async function listAsmCaseManifests(resource?: vscode.Uri): Promise<Array<{ manifest: AsmCaseManifestUnion; uri: vscode.Uri }>> {
  const root = caseWorkspaceRoot(resource);
  const casesDir = path.join(root, CO_CASES_DIR);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(casesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const manifests: Array<{ manifest: AsmCaseManifestUnion; uri: vscode.Uri }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const uri = vscode.Uri.file(path.join(casesDir, entry.name, 'case.json'));
    try {
      const manifest = JSON.parse(await readTextFile(uri)) as unknown;
      if (isKnownManifest(manifest)) {
        manifests.push({ manifest, uri });
      }
    } catch {
      // Ignore incomplete or hand-edited case directories.
    }
  }
  return manifests.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));
}

export async function readAsmCaseManifestForAsm(asm: vscode.Uri): Promise<AsmCaseManifestUnion | undefined> {
  if (path.basename(asm.fsPath).toLowerCase() !== 'program.asm') {
    return undefined;
  }
  const manifestPath = path.join(path.dirname(asm.fsPath), 'case.json');
  try {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as unknown;
    return isKnownManifest(manifest) ? manifest : undefined;
  } catch {
    // 元数据文件不存在或格式异常时按普通 ASM 处理
    return undefined;
  }
}

export function isAsmFile(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') {
    return false;
  }
  return ['.asm', '.s', '.mips'].includes(path.extname(uri.fsPath).toLowerCase());
}

const asmCaseInputExcludeGlob = '**/{node_modules,out,.git,.co/cases,.co/out,.co/isim,.co/logisim,.co/tmp}/**';

async function nextAsmCasePaths(root: string, createdAt: Date, asmHash: string): Promise<ReturnType<typeof asmCasePaths>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidateDate = attempt === 0 ? createdAt : new Date(createdAt.getTime() + attempt);
    const paths = asmCasePaths(root, asmCaseId(candidateDate, asmHash));
    if (!await pathExists(paths.caseDir)) {
      return paths;
    }
  }
  return asmCasePaths(root, asmCaseId(new Date(), `${asmHash}${randomBytes(4).toString('hex')}`));
}

function caseWorkspaceRoot(resource?: vscode.Uri): string {
  const folder = workspaceFolderForOrFirst(resource);
  if (folder) {
    return folder.uri.fsPath;
  }
  if (resource?.scheme === 'file') {
    return path.dirname(resource.fsPath);
  }
  return process.cwd();
}

async function copyStdinSnapshot(stdin: vscode.Uri, stdinDir: string): Promise<{
  uri: vscode.Uri;
  snapshot: NonNullable<AsmCaseManifest['stdin']>;
}> {
  const bytes = await vscode.workspace.fs.readFile(stdin);
  await ensureDirectory(vscode.Uri.file(stdinDir));
  const uri = vscode.Uri.file(path.join(stdinDir, path.basename(stdin.fsPath)));
  await vscode.workspace.fs.writeFile(uri, bytes);
  return {
    uri,
    snapshot: {
      originalPath: stdin.fsPath,
      path: `stdin/${path.basename(stdin.fsPath)}`,
      sha256: sha256Bytes(bytes),
      bytes: bytes.byteLength
    }
  };
}

function normalizeP7Metadata(explicit: AsmCaseP7Metadata | undefined): AsmCaseP7Metadata | undefined {
  const merged: AsmCaseP7Metadata = {
    ...(explicit ?? {})
  };
  if (!merged.interruptSchedule?.length) {
    delete merged.interruptSchedule;
  }
  if (!merged.probe) {
    delete merged.probe;
  }
  return merged.interruptSchedule || merged.probe ? merged : undefined;
}

function artifactDirectory(asmCase: AsmCase, kind: 'verilog' | 'logisim' | 'mars'): vscode.Uri {
  return vscode.Uri.file(path.join(asmCase.dir.fsPath, kind));
}

async function writeAsmCaseManifest(asmCase: AsmCase): Promise<void> {
  await writeManifestAtomic(asmCase.manifestUri.fsPath, asmCase.manifest);
}

function assertWritableV2Case(
  asmCase: AsmCase
): asserts asmCase is AsmCase & { manifest: AsmCaseManifestV2 } {
  if (!isManifestV2(asmCase.manifest)) {
    throw new Error('ASM case manifest v1 is read-only; create a new v2 case before recording results');
  }
}

/**
 * Verify that both the case-local root snapshot and the source consumed by the
 * legacy re-assembler still equal the immutable manifest snapshot. Relative
 * includes remain a known phase-1 closure gap; this guard prevents even an
 * include-free root file from silently drifting.
 */
export async function assertAsmCaseSourceSnapshotCurrent(asmCase: AsmCase): Promise<void> {
  assertWritableV2Case(asmCase);
  const expected = asmCase.manifest.asmSnapshot;
  const snapshotBytes = await readIntegrityFile(asmCase.asm.fsPath, 'case-local ASM snapshot');
  assertSnapshotBytes(snapshotBytes, expected, 'case-local ASM snapshot');

  if (normalizePathKey(asmCase.sourceAsm.fsPath) === normalizePathKey(asmCase.asm.fsPath)) {
    return;
  }
  const sourceBytes = await readIntegrityFile(asmCase.sourceAsm.fsPath, 'ASM source');
  assertSnapshotBytes(sourceBytes, expected, 'ASM source');
}

export async function asmCaseSourceSnapshotIssue(asmCase: AsmCase): Promise<string | undefined> {
  try {
    await assertAsmCaseSourceSnapshotCurrent(asmCase);
    return undefined;
  } catch (error) {
    return sourceIntegrityMessage(error);
  }
}

async function readIntegrityFile(file: string, label: string): Promise<Buffer> {
  try {
    return await fs.promises.readFile(file);
  } catch (error) {
    throw new Error(`${label} 无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSnapshotBytes(bytes: Buffer, expected: AsmCaseManifestV2['asmSnapshot'], label: string): void {
  const digest = sha256Bytes(bytes);
  if (bytes.byteLength !== expected.bytes || digest !== expected.sha256.toLowerCase()) {
    throw new Error(
      `${label} 已偏离 case manifest（期望 ${expected.bytes} bytes / ${expected.sha256}，`
      + `实际 ${bytes.byteLength} bytes / ${digest}）；已拒绝本次汇编或执行`
    );
  }
}

function sourceIntegrityMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceIntegrityAssembleFailure(error: unknown): AssembleResult {
  const message = sourceIntegrityMessage(error);
  return {
    ok: false,
    status: {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: message,
      timedOut: false
    },
    descriptor: LEGACY_MARS_DESCRIPTOR
  };
}

function failedEngineStatusFrom(
  status: AssembleResult['status'],
  message: string
): AssembleResult['status'] {
  return {
    ...status,
    ok: false,
    stderr: status.stderr ? `${status.stderr}\n${message}` : message
  };
}

function assertManifestEntries(values: Record<string, string>, label: string): void {
  const entries = Object.entries(values);
  if (!entries.length) {
    throw new Error(`ASM case ${label} update must contain at least one entry`);
  }
  for (const [key, value] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)
      || key === '__proto__'
      || key === 'prototype'
      || key === 'constructor') {
      throw new Error(`ASM case ${label} key is invalid: ${JSON.stringify(key)}`);
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`ASM case ${label} value is empty: ${key}`);
    }
  }
}

/**
 * Build a fresh v2 manifest. Image and completed-oracle fields remain absent or
 * unknown until their corresponding stages actually finish.
 */
function createV2Manifest(
  caseId: string,
  createdAt: Date,
  profile: string,
  memoryConfiguration: string,
  originalAsmPath: string,
  asmSnapshot: AsmCaseManifest['asmSnapshot'],
  source: AsmCaseSource,
  stdin: AsmCaseManifest['stdin'],
  p7: AsmCaseP7Metadata | undefined
): AsmCaseManifestV2 {
  const manifest: AsmCaseManifestV2 = {
    version: asmCaseManifestVersion2,
    caseId,
    createdAt: createdAt.toISOString(),
    profile,
    originalAsmPath,
    asmSnapshot,
    source,
    stdin,
    p7,
    program: {
      assembler: {
        id: LEGACY_MARS_DESCRIPTOR.id,
        build: LEGACY_MARS_DESCRIPTOR.build,
        semanticsRevision: LEGACY_MARS_DESCRIPTOR.semanticsRevision,
        capabilitiesRevision: LEGACY_MARS_DESCRIPTOR.capabilitiesRevision
      }
    },
    oracle: {
      engine: {
        id: LEGACY_MARS_DESCRIPTOR.id,
        build: LEGACY_MARS_DESCRIPTOR.build,
        semanticsRevision: LEGACY_MARS_DESCRIPTOR.semanticsRevision,
        capabilitiesRevision: LEGACY_MARS_DESCRIPTOR.capabilitiesRevision
      },
      configurationHash: manifestRunConfigurationHash(
        { profile, memoryConfiguration },
        LEGACY_MARS_DESCRIPTOR
      ),
      runConfiguration: { profile, memoryConfiguration },
      stopReason: 'unknown'
    }
  };
  return manifest;
}

function manifestEngineInfo(
  descriptor: EngineDescriptor,
  artifact: EngineArtifactIdentity | undefined
): ManifestEngineInfo {
  const info: ManifestEngineInfo = {
    id: descriptor.id,
    build: descriptor.build,
    semanticsRevision: descriptor.semanticsRevision,
    capabilitiesRevision: descriptor.capabilitiesRevision
  };
  if (artifact) {
    info.artifact = {
      sha256: artifact.sha256,
      role: artifact.role,
      fileName: artifact.fileName
    };
  }
  return info;
}
