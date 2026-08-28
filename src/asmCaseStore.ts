import { CO_CASES_DIR } from './constants';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { getMemoryConfiguration, getProfile } from './config';
import { ensureDirectory, pathExists, workspaceFolderForOrFirst, writeTextFile } from './fsUtil';
import { normalizePathKey } from './pathUtils';
import { AppServices, ProjectProfile } from './types';
import { resolveFileInput } from './workflowInputs';
import { assembleWithPreflight, preflightFailureMessage } from './mips/providers/providerResolver';
import {
  AssembleResult,
  EngineArtifactIdentity,
  ExecuteResult,
  type ResolvedEngineRun
} from './mips/providers/contracts';
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
  manifestDutConfigurationHash,
  manifestRunConfigurationHash,
  v2ArtifactGroup,
  writeManifestAtomic
} from './courseTesting/manifestCodec';
import { LEGACY_MARS_DESCRIPTOR } from './mips/providers/contracts';
import { courseMachineCodeValidationError } from './courseTesting/machineCodeValidation';
import {
  captureSourceGraph,
  defaultSourceCaptureLimits,
  loadAndVerifySourceGraph,
  loadVerifiedSourceGraphInput,
  type CapturedSourceBundle
} from './mips/replay/sourceBundle';
import {
  createLegacyProgramImage,
  oracleEvidenceDigests,
  serializeObservabilitySchema,
  serializeProgramImage
} from './mips/replay/programImage';
import { sha256Canonical, type CanonicalJson } from './mips/replay/canonical';
import { assertContainedDirectoryPath, ensureContainedDirectoryPath } from './pathContainment';
import {
  maximumReplayManifestBytes,
  maximumReplayMachineCodeBytes,
  maximumReplayProgramImageBytes,
  maximumReplaySnapshotBytes,
  maximumReplaySourceBytes,
  maximumReplayStdinBytes,
  maximumReplayTraceBytes,
  readBoundedRegularFile
} from './mips/replay/boundedFile';
import {
  ImmutableEngineArtifactRegistry,
  workspaceEngineRegistryRoot
} from './mips/replay/engineRegistry';
import { builtinAssemblerEngineArtifact } from './mips/replay/builtinAssemblerEngineArtifact';
import { builtinExecutionEngineArtifact } from './mips/replay/builtinEngineArtifact';
import { commitEventsCanonical } from './mips/core/events/commitEvent';
import { parseStructuredExecutionEvidence } from './mips/replay/structuredExecutionEvidence';

/** Keep case discovery bounded even when a workspace contains an adversarial case tree. */
export const maximumAsmCaseIndexEntries = 2048;
export const maximumAsmCaseIndexManifestBytes = 16 * 1024 * 1024;

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
  assertWorkspaceTrustedForCaseCapture();
  if (asm.scheme !== 'file') {
    throw new Error(`ASM case capture requires a local file URI: ${asm.toString()}`);
  }
  const asmBytes = await readBoundedRegularFile(asm.fsPath, {
    maximumBytes: defaultSourceCaptureLimits.maxBytes,
    label: 'ASM root source'
  });
  const asmHash = sha256Bytes(asmBytes);
  const root = caseWorkspaceRoot(options.resource ?? asm);
  const createdAt = options.createdAt ?? new Date();
  const paths = await nextAsmCasePaths(root, createdAt, asmHash);
  const caseDir = vscode.Uri.file(paths.caseDir);
  await ensureContainedDirectoryPath(root, paths.caseDir);

  const caseAsm = vscode.Uri.file(paths.asm);
  await vscode.workspace.fs.writeFile(caseAsm, asmBytes);
  const sourceBundle = await captureSourceGraph(
    asm.fsPath,
    paths.caseDir,
    asmBytes,
    { ...defaultSourceCaptureLimits },
    { allowedRoot: root }
  );
  const sourceBundleManifest = await sourceBundleManifestFields(sourceBundle, paths.caseDir);

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
    p7,
    sourceBundleManifest
  );
  const manifestUri = vscode.Uri.file(paths.manifest);
  await assertContainedDirectoryPath(root, paths.caseDir);
  await writeManifestAtomic(paths.manifest, manifest);

  return {
    id: manifest.caseId,
    dir: caseDir,
    manifestUri,
    asm: caseAsm,
    machineCode: vscode.Uri.file(paths.machineCode),
    sourceAsm: vscode.Uri.file(sourceBundle.rootMaterializedPath),
    stdin: stdin?.uri,
    manifest
  };
}

export async function createAsmCaseFromText(
  fileName: string,
  text: string,
  options: CreateAsmCaseOptions = {}
): Promise<AsmCase> {
  assertWorkspaceTrustedForCaseCapture();
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength > defaultSourceCaptureLimits.maxBytes) {
    throw new Error(
      `ASM root source size ${bytes.byteLength} exceeds the capture limit ${defaultSourceCaptureLimits.maxBytes}`
    );
  }
  const asmHash = sha256Bytes(bytes);
  const root = caseWorkspaceRoot(options.resource);
  const createdAt = options.createdAt ?? new Date();
  const paths = await nextAsmCasePaths(root, createdAt, asmHash);
  const caseDir = vscode.Uri.file(paths.caseDir);
  await ensureContainedDirectoryPath(root, paths.caseDir);

  const caseAsm = vscode.Uri.file(paths.asm);
  await vscode.workspace.fs.writeFile(caseAsm, bytes);
  const sourceBundle = await captureSourceGraph(
    caseAsm.fsPath,
    paths.caseDir,
    bytes,
    { ...defaultSourceCaptureLimits },
    { allowedRoot: root }
  );
  const sourceBundleManifest = await sourceBundleManifestFields(sourceBundle, paths.caseDir);
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
    p7,
    sourceBundleManifest
  );
  const manifestUri = vscode.Uri.file(paths.manifest);
  await assertContainedDirectoryPath(root, paths.caseDir);
  await writeManifestAtomic(paths.manifest, manifest);

  return {
    id: manifest.caseId,
    dir: caseDir,
    manifestUri,
    asm: caseAsm,
    machineCode: vscode.Uri.file(paths.machineCode),
    sourceAsm: vscode.Uri.file(sourceBundle.rootMaterializedPath),
    stdin: stdin?.uri,
    manifest
  };
}

export async function prepareAsmCaseMachineCode(
  services: AppServices,
  asmCase: AsmCase,
  options: PrepareAsmCaseOptions = {}
): Promise<AssembleResult | undefined> {
  assertWritableV2Case(asmCase);
  try {
    await assertAsmCaseSourceSnapshotCurrent(asmCase);
  } catch (error) {
    return sourceIntegrityAssembleFailure(error);
  }
  const graphReference = asmCase.manifest.program.sourceGraph;
  if (!graphReference) {
    return sourceIntegrityAssembleFailure('v2 case has no captured SourceUnit graph');
  }
  let verifiedSource: Awaited<ReturnType<typeof loadVerifiedSourceGraphInput>>;
  try {
    verifiedSource = await loadVerifiedSourceGraphInput(asmCase.dir.fsPath, graphReference.path);
  } catch (error) {
    return sourceIntegrityAssembleFailure(error);
  }
  const graph = verifiedSource.graph;
  const inputGraph = graph.units.map((unit) => ({ id: unit.id, contentHash: unit.contentHash }));
  const invocation = await assembleWithPreflight(services, {
    sourceUri: asmCase.sourceAsm,
    inputGraph,
    sourceGraphInput: verifiedSource.sourceGraphInput,
    target: { kind: 'userText', outputFile: asmCase.machineCode },
    courseTrace: options.courseTrace,
    p7RiInstruction: options.p7RiInstruction,
    revealOutput: options.revealOutput,
    requirements: {
      profile: asmCase.manifest.profile,
      instructionLayers: ['required', 'commonExtensions', 'marsCompatibility'],
      pseudoInstructions: true,
      eventSchemaRevision: 1
    }
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
  if (!dump.resolvedRun) {
    return {
      ...dump,
      ok: false,
      outputFile: undefined,
      status: failedEngineStatusFrom(dump.status, 'assembler result did not bind its resolved run configuration')
    };
  }
  if (dump.resolvedRun.profile !== asmCase.manifest.profile) {
    return {
      ...dump,
      ok: false,
      outputFile: undefined,
      status: failedEngineStatusFrom(
        dump.status,
        `assembler resolved profile ${dump.resolvedRun.profile} differs from captured case profile ${asmCase.manifest.profile}`
      )
    };
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

  const bytes = await readBoundedRegularFile(asmCase.machineCode.fsPath, {
    maximumBytes: maximumReplayMachineCodeBytes,
    label: 'MARS machine-code dump'
  });
  const text = Buffer.from(bytes).toString('utf8');
  if (options.courseTrace) {
    const asmText = (await readBoundedRegularFile(asmCase.sourceAsm.fsPath, {
      maximumBytes: maximumReplaySourceBytes,
      label: 'case-local materialized ASM source'
    })).toString('utf8');
    const validationError = courseMachineCodeValidationError(
      dump.resolvedRun.profile as ProjectProfile,
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
    path: 'code.txt',
    sha256: sha256Bytes(bytes),
    bytes: bytes.byteLength,
    wordCount: machineCodeWordCount(text),
    haltPc: dump.courseHaltPc
  };
  const legacyAssembler = dump.descriptor.id === LEGACY_MARS_DESCRIPTOR.id;
  const reconstructedImage = createLegacyProgramImage(text, inputGraph);
  const imageMatchesDump = dump.image !== undefined && (
    legacyAssembler
      ? dump.image.fingerprint === reconstructedImage.fingerprint
      : (() => {
        const textWords = dump.image.segments.find((segment) => segment.name === 'text')?.words ?? [];
        return textWords.length === reconstructedImage.segments[0].words.length
          && textWords.every((word, index) => (word >>> 0) === (reconstructedImage.segments[0].words[index] >>> 0));
      })()
  );
  const bindingValid = legacyAssembler
    ? dump.executionBinding !== undefined
      && dump.executionBinding.providerId === dump.descriptor.id
      && dump.executionBinding.imageFingerprint === dump.image?.fingerprint
    : true;
  if (!dump.image || !imageMatchesDump || !bindingValid) {
    return {
      ...dump,
      ok: false,
      outputFile: undefined,
      status: failedEngineStatusFrom(
        dump.status,
        'assembler did not return a ProgramImage/source binding matching the captured source graph and exact dump bytes'
      )
    };
  }
  const programImage = dump.image;
  const legacyProvenance = legacyAssembler
    ? {
      commandLine: dump.status.commandLine ?? dump.descriptor.id,
      cwd: dump.status.cwd ?? path.dirname(asmCase.sourceAsm.fsPath),
      memoryConfiguration: dump.resolvedRun.memoryConfiguration,
      profile: dump.resolvedRun.profile,
      runtime: dump.resolvedRun.runtime.kind === 'java'
        ? dump.resolvedRun.runtime
        : (() => { throw new Error('legacy assembler result did not bind a Java runtime'); })(),
      wallClockMs: dump.resolvedRun.wallClockMs,
      p7RiInstruction: dump.resolvedRun.p7RiInstruction
    }
    : undefined;
  const imageBytes = serializeProgramImage(programImage);
  const observabilityBytes = serializeObservabilitySchema();
  const imagePath = path.join(asmCase.dir.fsPath, 'program', 'image.json');
  const observabilityPath = path.join(asmCase.dir.fsPath, 'program', 'observability.json');
  await writeImmutableReplayArtifact(imagePath, imageBytes);
  await writeImmutableReplayArtifact(observabilityPath, observabilityBytes);
  await fs.promises.chmod(asmCase.machineCode.fsPath, 0o444).catch(() => undefined);
  const imageSnapshot = snapshotForCaseFile(asmCase.dir.fsPath, imagePath, imageBytes);
  const observabilitySnapshot = snapshotForCaseFile(asmCase.dir.fsPath, observabilityPath, observabilityBytes);
  const dutInput = {
    path: machineCode.path,
    sha256: machineCode.sha256,
    bytes: machineCode.bytes
  };
  const assemblerArtifact = await persistBuiltinEngineArtifact(
    asmCase,
    dump.descriptor,
    'assembler',
    dump.engineArtifact
  );
  const assembler = manifestEngineInfo(dump.descriptor, assemblerArtifact);
  asmCase.manifest = {
    ...asmCase.manifest,
    program: {
      ...asmCase.manifest.program,
      machineCode,
      image: imageSnapshot,
      observability: observabilitySnapshot,
      dutInput,
      imageFingerprint: programImage.fingerprint,
      assembler: {
        ...assembler,
        ...(legacyProvenance ? { legacyProvenance } : {})
      }
    },
    artifacts: {
      ...(asmCase.manifest.artifacts ?? {}),
      program: {
        ...(asmCase.manifest.artifacts?.program ?? {}),
        image: imageSnapshot,
        observability: observabilitySnapshot,
        dutInput
      }
    }
  };
  await writeAsmCaseManifest(asmCase);
  return {
    ...dump,
    image: programImage,
    executionBinding: dump.executionBinding
  };
}

export interface PrepareAsmCaseOptions {
  showMessages?: boolean;
  revealOutput?: boolean;
  courseTrace?: boolean;
  p7RiInstruction?: boolean;
  signal?: AbortSignal;
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
  await assertAsmCaseStdinSnapshotCurrent(asmCase);
  const oracleArtifact = await persistBuiltinEngineArtifact(
    asmCase,
    result.descriptor,
    'executor',
    result.engineArtifact
  );
  const engine = manifestEngineInfo(result.descriptor, oracleArtifact);
  if (!result.resolvedRun) {
    throw new Error('cannot record oracle result without the provider resolved run configuration');
  }
  const traceRevision = result.trace?.rawTraceRevision;
  if (traceRevision !== undefined && traceRevision !== 1 && traceRevision !== 2) {
    throw new Error(`unsupported provider raw trace revision ${traceRevision}`);
  }
  const providerBoundConfiguration: ManifestRunConfiguration = {
    ...configuration,
    traceOutput: result.trace !== undefined,
    traceLevel: traceRevision as 1 | 2 | undefined
  };
  const completeConfiguration = await completeReplayRunConfiguration(
    asmCase,
    providerBoundConfiguration,
    outcome.stopReason,
    result.resolvedRun
  );
  const traceReference = asmCase.manifest.artifacts?.oracle?.traceOut;
  if (!traceReference || typeof traceReference === 'string') {
    throw new Error('cannot record oracle result without a hashed case-local traceOut artifact');
  }
  const tracePath = path.join(asmCase.dir.fsPath, ...traceReference.path.replace(/\\/g, '/').split('/'));
  await caseRelativePath(asmCase, tracePath);
  const traceBytes = await readBoundedRegularFile(tracePath, {
    maximumBytes: maximumReplayTraceBytes,
    expectedBytes: traceReference.bytes,
    label: 'oracle traceOut artifact'
  });
  if (traceBytes.byteLength !== traceReference.bytes || sha256Bytes(traceBytes) !== traceReference.sha256.toLowerCase()) {
    throw new Error('oracle traceOut artifact no longer matches its case-local snapshot');
  }
  const traceText = traceBytes.toString('utf8');
  if (!Buffer.from(traceText, 'utf8').equals(traceBytes)) {
    throw new Error('oracle traceOut artifact is not lossless UTF-8');
  }
  const traceEvidence = oracleEvidenceDigests(traceText, completeConfiguration.traceLevel ?? 1);
  const structuredFields = [
    result.events,
    result.instructions,
    result.eventCount,
    result.eventDigest,
    result.finalStateDigest,
    result.eventArtifact
  ];
  const hasStructuredEvidence = structuredFields.some((value) => value !== undefined);
  let evidence = traceEvidence;
  if (hasStructuredEvidence) {
    if (!result.events || result.instructions === undefined || result.eventCount === undefined
      || result.eventDigest === undefined || result.finalStateDigest === undefined || !result.eventArtifact) {
      throw new Error('cannot record a partial structured oracle result');
    }
    const eventReference = asmCase.manifest.artifacts?.oracle?.events;
    if (!eventReference || typeof eventReference === 'string') {
      throw new Error('cannot record structured oracle evidence without a hashed case-local events artifact');
    }
    const eventPath = path.join(asmCase.dir.fsPath, ...eventReference.path.replace(/\\/g, '/').split('/'));
    await caseRelativePath(asmCase, eventPath);
    const eventBytes = await readBoundedRegularFile(eventPath, {
      maximumBytes: maximumReplayTraceBytes,
      expectedBytes: eventReference.bytes,
      label: 'oracle events artifact'
    });
    if (sha256Bytes(eventBytes) !== eventReference.sha256.toLowerCase()) {
      throw new Error('oracle events artifact no longer matches its case-local snapshot');
    }
    const artifactEvidence = parseStructuredExecutionEvidence(eventBytes);
    if (!asmCase.manifest.program.imageFingerprint
      || artifactEvidence.imageFingerprint !== asmCase.manifest.program.imageFingerprint) {
      throw new Error('structured oracle evidence does not bind the captured ProgramImage');
    }
    if (artifactEvidence.engine.id !== result.descriptor.id
      || artifactEvidence.engine.kind !== result.descriptor.kind
      || artifactEvidence.engine.semanticsRevision !== result.descriptor.semanticsRevision
      || artifactEvidence.engine.capabilitiesRevision !== result.descriptor.capabilitiesRevision
      || artifactEvidence.engine.build !== result.descriptor.build) {
      throw new Error('structured oracle evidence does not bind the executed engine descriptor');
    }
    if (artifactEvidence.profile !== completeConfiguration.profile) {
      throw new Error('structured oracle evidence profile differs from the executed run');
    }
    if (!result.stop
      || artifactEvidence.stop.kind !== result.stop.kind
      || artifactEvidence.stop.haltPc !== result.stop.haltPc
      || artifactEvidence.status !== 'halted') {
      throw new Error('structured oracle evidence stop/status differs from the executed run');
    }
    const resultEventDigest = sha256Canonical(commitEventsCanonical(result.events) as CanonicalJson);
    if (resultEventDigest !== result.eventDigest || artifactEvidence.eventDigest !== result.eventDigest) {
      throw new Error('reported oracle eventDigest does not match the structured event stream');
    }
    if (artifactEvidence.eventCount !== result.eventCount
      || artifactEvidence.steps !== result.instructions
      || artifactEvidence.finalStateDigest !== result.finalStateDigest) {
      throw new Error('reported oracle summary does not match the structured event artifact');
    }
    evidence = {
      rawOutputDigest: traceEvidence.rawOutputDigest,
      steps: artifactEvidence.steps,
      eventCount: artifactEvidence.eventCount,
      eventDigest: artifactEvidence.eventDigest,
      finalStateDigest: artifactEvidence.finalStateDigest
    };
    await fs.promises.chmod(eventPath, 0o444).catch(() => undefined);
  }
  if (outcome.steps !== undefined && outcome.steps !== evidence.steps) {
    throw new Error(`reported oracle steps ${outcome.steps} do not match captured trace evidence ${evidence.steps}`);
  }
  if (outcome.finalStateDigest !== undefined && outcome.finalStateDigest !== evidence.finalStateDigest) {
    throw new Error('reported oracle finalStateDigest does not match captured trace evidence');
  }
  await fs.promises.chmod(tracePath, 0o444).catch(() => undefined);
  asmCase.manifest = {
    ...asmCase.manifest,
    oracle: {
      engine: {
        ...engine,
        ...(result.resolvedRun.runtime.kind === 'java'
          ? {
            legacyProvenance: {
              commandLine: result.status.commandLine,
              cwd: result.status.cwd,
              memoryConfiguration: completeConfiguration.memoryConfiguration
            }
          }
          : {})
      },
      configurationHash: manifestRunConfigurationHash(completeConfiguration, engine),
      runConfiguration: completeConfiguration,
      stopReason: outcome.stopReason,
      steps: evidence.steps,
      eventCount: evidence.eventCount,
      rawOutputDigest: evidence.rawOutputDigest,
      eventDigest: evidence.eventDigest,
      finalStateDigest: evidence.finalStateDigest
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
      const bytes = await readBoundedRegularFile(file, {
        maximumBytes: asmCaseArtifactMaximumBytes(kind, name),
        label: `ASM case ${kind} artifact ${name}`
      });
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
  const dutEntries = Object.fromEntries(Object.entries(metadata).filter(([key]) => key.startsWith('dut.')));
  const provenanceEntries = Object.fromEntries(Object.entries(metadata).filter(([key]) => !key.startsWith('dut.')));
  const dutConfiguration = {
    ...(asmCase.manifest.dut?.configuration ?? {}),
    ...dutEntries
  };
  const mergedMetadata = { ...(asmCase.manifest.metadata ?? {}), ...provenanceEntries };
  asmCase.manifest = {
    ...asmCase.manifest,
    ...(Object.keys(dutConfiguration).length ? {
      dut: {
        configuration: dutConfiguration,
        configurationHash: manifestDutConfigurationHash(dutConfiguration)
      }
    } : {}),
    ...(Object.keys(mergedMetadata).length ? { metadata: mergedMetadata } : {})
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

async function caseSnapshotFile(asmCase: AsmCase, relativePath: string, label: string): Promise<string> {
  if (relativePath.includes('\\') || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
    || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} path is not a canonical case-relative '/' path: ${relativePath}`);
  }
  const file = path.join(asmCase.dir.fsPath, ...relativePath.split('/'));
  const actualRelative = await caseRelativePath(asmCase, file);
  if (actualRelative !== relativePath) {
    throw new Error(`${label} path does not resolve to its manifest entry`);
  }
  return file;
}

function asmCaseArtifactMaximumBytes(kind: AsmCaseArtifactKind, name: string): number {
  const { group, key } = v2ArtifactGroup(kind, name);
  if (group === 'source') return maximumReplaySourceBytes;
  if (group === 'oracle' && (key === 'traceOut' || key === 'events')) return maximumReplayTraceBytes;
  return maximumReplaySnapshotBytes;
}

export async function writeAsmCaseArtifact(
  asmCase: AsmCase,
  kind: 'verilog' | 'logisim' | 'oracle' | 'mars',
  fileName: string,
  content: string,
  artifactName = path.basename(fileName, path.extname(fileName))
): Promise<vscode.Uri> {
  assertWritableV2Case(asmCase);
  const maximumBytes = asmCaseArtifactMaximumBytes(kind, artifactName);
  const contentBytes = Buffer.byteLength(content, 'utf8');
  if (contentBytes > maximumBytes) {
    throw new Error(
      `ASM case ${kind} artifact ${artifactName} size ${contentBytes} exceeds the hard limit ${maximumBytes}`
    );
  }
  const dir = artifactDirectory(asmCase, kind);
  await ensureDirectory(dir);
  const uri = vscode.Uri.file(path.join(dir.fsPath, path.basename(fileName)));
  await writeTextFile(uri, content);
  await updateAsmCaseArtifacts(asmCase, kind, { [artifactName]: uri.fsPath });
  return uri;
}

export function asmCaseArtifactUri(
  asmCase: AsmCase,
  kind: 'verilog' | 'logisim' | 'oracle' | 'mars',
  fileName: string
): vscode.Uri {
  return vscode.Uri.file(path.join(artifactDirectory(asmCase, kind).fsPath, path.basename(fileName)));
}

export async function copyAsmCaseArtifact(
  asmCase: AsmCase,
  kind: 'verilog' | 'logisim' | 'oracle' | 'mars',
  source: vscode.Uri,
  fileName = path.basename(source.fsPath),
  artifactName = path.basename(fileName, path.extname(fileName))
): Promise<vscode.Uri> {
  assertWritableV2Case(asmCase);
  if (source.scheme !== 'file') {
    throw new Error(`ASM case artifact copy requires a local file URI: ${source.toString()}`);
  }
  const dir = artifactDirectory(asmCase, kind);
  await ensureDirectory(dir);
  const target = vscode.Uri.file(path.join(dir.fsPath, path.basename(fileName)));
  if (normalizePathKey(source.fsPath) !== normalizePathKey(target.fsPath)) {
    const bytes = await readBoundedRegularFile(source.fsPath, {
      maximumBytes: asmCaseArtifactMaximumBytes(kind, artifactName),
      label: `ASM case ${kind} artifact copy ${artifactName}`
    });
    await vscode.workspace.fs.writeFile(target, bytes);
  }
  await updateAsmCaseArtifacts(asmCase, kind, { [artifactName]: target.fsPath });
  return target;
}

export async function listAsmCaseManifests(resource?: vscode.Uri): Promise<Array<{ manifest: AsmCaseManifestUnion; uri: vscode.Uri }>> {
  const root = caseWorkspaceRoot(resource);
  const casesDir = path.join(root, CO_CASES_DIR);
  let directory: fs.Dir;
  try {
    await assertContainedDirectoryPath(root, casesDir);
    directory = await fs.promises.opendir(casesDir);
  } catch {
    return [];
  }

  const manifests: Array<{ manifest: AsmCaseManifestUnion; uri: vscode.Uri }> = [];
  let caseEntries = 0;
  let aggregateManifestBytes = 0;
  for await (const entry of directory) {
    if (!entry.isDirectory()) {
      continue;
    }
    caseEntries += 1;
    if (caseEntries > maximumAsmCaseIndexEntries) {
      throw new Error(`ASM case index exceeds the trusted ${maximumAsmCaseIndexEntries}-entry limit`);
    }
    const uri = vscode.Uri.file(path.join(casesDir, entry.name, 'case.json'));
    let bytes: Buffer;
    try {
      await assertContainedDirectoryPath(casesDir, path.dirname(uri.fsPath));
      bytes = await readBoundedRegularFile(uri.fsPath, {
        maximumBytes: maximumReplayManifestBytes,
        label: `ASM case manifest ${entry.name}`
      });
    } catch {
      // Ignore incomplete, linked, or oversized case directories.
      continue;
    }
    aggregateManifestBytes += bytes.byteLength;
    if (aggregateManifestBytes > maximumAsmCaseIndexManifestBytes) {
      throw new Error(
        `ASM case index manifest bytes exceed the trusted ${maximumAsmCaseIndexManifestBytes}-byte limit`
      );
    }
    try {
      const manifest = JSON.parse(bytes.toString('utf8')) as unknown;
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
    const bytes = await readBoundedRegularFile(manifestPath, {
      maximumBytes: maximumReplayManifestBytes,
      label: 'adjacent ASM case manifest'
    });
    const manifest = JSON.parse(bytes.toString('utf8')) as unknown;
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
  if (stdin.scheme !== 'file') {
    throw new Error(`标准输入快照要求本地文件 URI：${stdin.toString()}`);
  }
  const bytes = await readBoundedRegularFile(stdin.fsPath, {
    maximumBytes: maximumReplayStdinBytes,
    label: 'stdin snapshot'
  });
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`标准输入必须是无损 UTF-8 文本：${stdin.fsPath}`);
  }
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

function artifactDirectory(asmCase: AsmCase, kind: 'verilog' | 'logisim' | 'oracle' | 'mars'): vscode.Uri {
  return vscode.Uri.file(path.join(asmCase.dir.fsPath, kind));
}

async function writeAsmCaseManifest(asmCase: AsmCase): Promise<void> {
  await writeManifestAtomic(asmCase.manifestUri.fsPath, asmCase.manifest);
}

function assertWorkspaceTrustedForCaseCapture(): void {
  if (vscode.workspace.isTrusted === false) {
    throw new Error('ASM case capture is disabled in an untrusted workspace (legacy-mars.workspace-untrusted)');
  }
}

function assertWritableV2Case(
  asmCase: AsmCase
): asserts asmCase is AsmCase & { manifest: AsmCaseManifestV2 } {
  if (!isManifestV2(asmCase.manifest)) {
    throw new Error('ASM case manifest v1 is read-only; create a new v2 case before recording results');
  }
}

/**
 * Verify the case-local root plus the complete content-addressed SourceUnit graph. New cases
 * execute only the captured materialization; the original workspace path is provenance and may
 * be moved or deleted. Early-v2 cases without a graph retain the stricter legacy fallback.
 */
export async function assertAsmCaseSourceSnapshotCurrent(asmCase: AsmCase): Promise<void> {
  assertWritableV2Case(asmCase);
  const expected = asmCase.manifest.asmSnapshot;
  const snapshotFile = await caseSnapshotFile(asmCase, expected.path, 'ASM root snapshot');
  if (normalizePathKey(asmCase.asm.fsPath) !== normalizePathKey(snapshotFile)) {
    throw new Error('ASM case root URI is not the manifest-bound case-local snapshot');
  }
  const snapshotBytes = await readIntegrityFile(
    snapshotFile,
    'case-local ASM snapshot',
    expected,
    maximumReplaySourceBytes
  );
  assertSnapshotBytes(snapshotBytes, expected, 'case-local ASM snapshot');

  const graphReference = asmCase.manifest.program.sourceGraph;
  if (graphReference) {
    const graph = await loadAndVerifySourceGraph(asmCase.dir.fsPath, graphReference.path);
    const root = graph.units.find((unit) => unit.id === graph.rootId);
    if (!root || root.contentHash !== expected.sha256 || root.bytes !== expected.bytes) {
      throw new Error('captured SourceUnit graph root does not match case-local ASM snapshot');
    }
    const expectedMaterialized = path.join(asmCase.dir.fsPath, ...root.materializedPath.split('/'));
    if (normalizePathKey(expectedMaterialized) !== normalizePathKey(asmCase.sourceAsm.fsPath)) {
      throw new Error('ASM provider source is not the immutable SourceUnit graph root');
    }
    return;
  }

  if (normalizePathKey(asmCase.sourceAsm.fsPath) === normalizePathKey(asmCase.asm.fsPath)) {
    return;
  }
  const sourceBytes = await readIntegrityFile(
    asmCase.sourceAsm.fsPath,
    'ASM source',
    expected,
    maximumReplaySourceBytes
  );
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

/**
 * Read the only stdin bytes an archived case is allowed to execute. The original
 * workspace path is provenance only and is never a second live input source.
 */
export async function readAsmCaseStdinSnapshot(asmCase: AsmCase): Promise<string | undefined> {
  assertWritableV2Case(asmCase);
  const expected = asmCase.manifest.stdin;
  if (!expected) {
    if (asmCase.stdin) throw new Error('ASM case exposes stdin bytes that are absent from its manifest');
    return undefined;
  }
  const normalized = expected.path;
  if (normalized.includes('\\') || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`ASM case stdin snapshot path is unsafe: ${expected.path}`);
  }
  const file = path.join(asmCase.dir.fsPath, ...normalized.split('/'));
  const relative = await caseRelativePath(asmCase, file);
  if (relative !== normalized) throw new Error('ASM case stdin snapshot path does not resolve to its manifest entry');
  if (asmCase.stdin && normalizePathKey(asmCase.stdin.fsPath) !== normalizePathKey(file)) {
    throw new Error('ASM case stdin URI is not the manifest-bound case-local snapshot');
  }
  const bytes = await readIntegrityFile(
    file,
    'case-local stdin snapshot',
    expected,
    maximumReplayStdinBytes
  );
  assertSnapshotBytes(bytes, expected, 'case-local stdin snapshot');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error('case-local stdin snapshot is not lossless UTF-8');
  }
  return text;
}

export async function assertAsmCaseStdinSnapshotCurrent(asmCase: AsmCase): Promise<void> {
  await readAsmCaseStdinSnapshot(asmCase);
}

async function readIntegrityFile(
  file: string,
  label: string,
  expected: { bytes: number },
  maximumBytes: number
): Promise<Buffer> {
  try {
    return await readBoundedRegularFile(file, {
      maximumBytes,
      expectedBytes: expected.bytes,
      label
    });
  } catch (error) {
    throw new Error(
      `${label} 已偏离 case manifest 或无法有界读取：${error instanceof Error ? error.message : String(error)}`
    );
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

async function completeReplayRunConfiguration(
  asmCase: AsmCase & { manifest: AsmCaseManifestV2 },
  configuration: ManifestRunConfiguration,
  stopReason: AsmCaseManifestV2['oracle']['stopReason'],
  resolvedRun: ResolvedEngineRun
): Promise<ManifestRunConfiguration> {
  const graphReference = asmCase.manifest.program.sourceGraph;
  const graph = graphReference
    ? await loadAndVerifySourceGraph(asmCase.dir.fsPath, graphReference.path)
    : undefined;
  if (configuration.profile !== resolvedRun.profile) {
    throw new Error(`requested profile ${configuration.profile} differs from executed profile ${resolvedRun.profile}`);
  }
  if (configuration.memoryConfiguration !== resolvedRun.memoryConfiguration) {
    throw new Error(
      `requested memory configuration ${configuration.memoryConfiguration} differs from executed ${resolvedRun.memoryConfiguration}`
    );
  }
  const interrupts = [...(configuration.interruptSchedule ?? [])];
  const probeMetadataDigest = asmCase.manifest.p7?.probe === undefined
    ? null
    : sha256Canonical(JSON.parse(JSON.stringify(asmCase.manifest.p7.probe)) as CanonicalJson);
  const traceLevel = configuration.traceLevel ?? null;
  const maxSteps = configuration.maxSteps ?? null;
  const haltPc = configuration.haltPc ?? null;
  const policyKind = stopReason === 'error' ? 'engine-error' : stopReason === 'unknown' ? 'engine-error' : stopReason;
  const limits = graph?.limits ?? defaultSourceCaptureLimits;
  return {
    ...configuration,
    interruptSchedule: interrupts,
    executionOptions: {
      delayedBranching: ['P5', 'P6', 'P7'].includes(configuration.profile),
      courseTrace: configuration.courseTrace ?? false,
      traceOutput: configuration.traceOutput ?? false,
      traceLevel,
      p7RiInstruction: resolvedRun.p7RiInstruction
    },
    stdin: asmCase.manifest.stdin
      ? { sha256: asmCase.manifest.stdin.sha256, bytes: asmCase.manifest.stdin.bytes, mode: 'bytes' }
      : { sha256: null, bytes: 0, mode: 'bytes' },
    deviceTimeline: {
      schemaRevision: 1,
      events: interrupts.map((value) => ({ kind: 'external-interrupt', trigger: 'macro-pc', value })),
      probeMetadataDigest
    },
    cycleContract: {
      id: configuration.profile === 'P7' ? 'buaa-co-p7-cycle-contract' : 'architectural-commit-v1',
      revision: 1
    },
    stopPolicy: { kind: policyKind, haltPc },
    haltPolicy: stopReason === 'halt-loop'
      ? { kind: 'course-self-branch-nop', branchWord: 0x1000ffff, delaySlotWord: 0 }
      : { kind: 'none', branchWord: null, delaySlotWord: null },
    stepPolicy: { unit: 'architectural-instruction', limit: maxSteps },
    seed: asmCase.manifest.metadata?.['source.seed'] ?? null,
    resourceLimits: {
      wallClockMs: resolvedRun.wallClockMs,
      maxSteps,
      // The production MARS process runner enforces this raw stdout/stderr ceiling before retaining output.
      maxTraceBytes: maximumReplayTraceBytes,
      maxSourceBytes: limits.maxBytes,
      maxIncludeDepth: limits.maxDepth,
      maxIncludeUnits: limits.maxUnits
    },
    runtime: resolvedRun.runtime
  };
}

interface SourceBundleManifestFields {
  graph: NonNullable<AsmCaseManifestV2['program']['sourceGraph']>;
  artifacts: NonNullable<AsmCaseManifestV2['artifacts']>['source'];
}

async function sourceBundleManifestFields(
  captured: CapturedSourceBundle,
  caseDir: string
): Promise<SourceBundleManifestFields> {
  const graphBytes = await readBoundedRegularFile(captured.graphPath, {
    maximumBytes: maximumReplayManifestBytes,
    label: 'captured source graph JSON'
  });
  const artifacts: Record<string, ManifestArtifactReference> = {
    graph: snapshotForCaseFile(caseDir, captured.graphPath, graphBytes)
  };
  for (const unit of captured.graph.units) {
    const materialized = path.join(caseDir, ...unit.materializedPath.split('/'));
    const materializedBytes = await readBoundedRegularFile(materialized, {
      maximumBytes: maximumReplaySourceBytes,
      label: `captured source materialization ${unit.id}`
    });
    artifacts[`blob/${unit.contentHash}`] = {
      path: unit.blobPath,
      sha256: unit.contentHash,
      bytes: unit.bytes
    };
    artifacts[`materialized/${unit.id}`] = snapshotForCaseFile(caseDir, materialized, materializedBytes);
  }
  return {
    graph: snapshotForCaseFile(caseDir, captured.graphPath, graphBytes),
    artifacts
  };
}

function snapshotForCaseFile(caseDir: string, file: string, bytes: Uint8Array): AsmCaseManifestV2['asmSnapshot'] {
  return {
    path: path.relative(caseDir, file).split(path.sep).join('/'),
    sha256: sha256Bytes(bytes),
    bytes: bytes.byteLength
  };
}

async function writeImmutableReplayArtifact(file: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > maximumReplayProgramImageBytes) {
    throw new Error(
      `immutable replay artifact size ${bytes.byteLength} exceeds the hard limit ${maximumReplayProgramImageBytes}`
    );
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  try {
    const existing = await readBoundedRegularFile(file, {
      maximumBytes: maximumReplayProgramImageBytes,
      expectedBytes: bytes.byteLength,
      label: 'existing immutable replay artifact'
    });
    if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
      throw new Error(`immutable replay artifact collision: ${file}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    await fs.promises.writeFile(temp, bytes, { flag: 'wx', mode: 0o444 });
    await fs.promises.rename(temp, file);
    await fs.promises.chmod(file, 0o444).catch(() => undefined);
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
  }
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
  p7: AsmCaseP7Metadata | undefined,
  replaySource: SourceBundleManifestFields
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
      sourceGraph: replaySource.graph,
      assembler: {
        id: LEGACY_MARS_DESCRIPTOR.id,
        build: LEGACY_MARS_DESCRIPTOR.build,
        semanticsRevision: LEGACY_MARS_DESCRIPTOR.semanticsRevision,
        capabilitiesRevision: LEGACY_MARS_DESCRIPTOR.capabilitiesRevision,
        catalogRevision: 1,
        courseContractRevision: 1,
        normalizerRevision: 1,
        eventSchemaRevision: 1
      }
    },
    oracle: {
      engine: {
        id: LEGACY_MARS_DESCRIPTOR.id,
        build: LEGACY_MARS_DESCRIPTOR.build,
        semanticsRevision: LEGACY_MARS_DESCRIPTOR.semanticsRevision,
        capabilitiesRevision: LEGACY_MARS_DESCRIPTOR.capabilitiesRevision,
        catalogRevision: 1,
        courseContractRevision: 1,
        normalizerRevision: 1,
        eventSchemaRevision: 1
      },
      configurationHash: manifestRunConfigurationHash(
        { profile, memoryConfiguration },
        LEGACY_MARS_DESCRIPTOR
      ),
      runConfiguration: { profile, memoryConfiguration },
      stopReason: 'unknown'
    },
    artifacts: { source: replaySource.artifacts }
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
    capabilitiesRevision: descriptor.capabilitiesRevision,
    catalogRevision: 1,
    courseContractRevision: 1,
    normalizerRevision: 1,
    eventSchemaRevision: 1
  };
  if (artifact) {
    info.artifact = {
      sha256: artifact.sha256,
      role: artifact.role,
      fileName: artifact.fileName,
      dependencies: artifact.dependencies?.map((dependency) => ({
        sha256: dependency.sha256,
        role: dependency.role,
        fileName: dependency.fileName
      }))
    };
  }
  return info;
}

async function persistBuiltinEngineArtifact(
  asmCase: AsmCase,
  descriptor: EngineDescriptor,
  role: 'assembler' | 'executor',
  reported: EngineArtifactIdentity | undefined
): Promise<EngineArtifactIdentity | undefined> {
  if (descriptor.id !== 'builtin-ts') return reported;
  const artifact = role === 'assembler'
    ? builtinAssemblerEngineArtifact()
    : builtinExecutionEngineArtifact();
  if (!reported
    || reported.sha256.toLowerCase() !== artifact.identity.sha256
    || reported.role !== artifact.identity.role
    || reported.fileName !== artifact.identity.fileName) {
    throw new Error(`builtin-ts ${role} result did not bind the current compiled engine artifact`);
  }
  const caseRoot = path.resolve(asmCase.dir.fsPath);
  const workspaceRoot = path.dirname(path.dirname(path.dirname(caseRoot)));
  const registry = new ImmutableEngineArtifactRegistry(
    workspaceEngineRegistryRoot(workspaceRoot),
    workspaceRoot
  );
  const registered = await registry.registerBytes(
    artifact.identity.role!,
    artifact.bytes,
    artifact.identity.fileName!
  );
  return { ...registered.identity };
}
