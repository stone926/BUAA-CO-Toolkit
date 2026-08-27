// @index mips-providers — LegacyMarsProvider：完整包装现有 runMarsFile 行为（dumpText/dumpKernel/run）
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  marsOutputFileName,
  marsRunOutputDirectory,
  runMarsFile,
  MarsRunOptions
} from '../../mips';
import { AppServices } from '../../types';
import type { ProjectProfile } from '../../projectProfile';
import {
  ArchitecturalWriteTrace,
  AssembleRequest,
  AssembleResult,
  CapabilityDiagnostic,
  capabilityRequirementDiagnostics,
  ExecuteRequest,
  ExecuteResult,
  EngineRunStatus,
  failedPreflight,
  LEGACY_MARS_CAPABILITIES,
  LEGACY_MARS_DESCRIPTOR,
  MipsAssemblerProvider,
  MipsExecutionProvider,
  okPreflight,
  ProviderPreflight,
  ProviderRunContext
} from './contracts';
import { getMachineCode } from '../../config';
import {
  resolveLegacyMarsLaunch,
  type ResolvedLegacyMarsLaunch
} from './legacyMarsLaunch';
import { iterMarsDetailedTraceEvents, type CpuTraceEvent } from '../../language/mips/traceParser';
import { courseTraceMarsHaltError } from '../legacy/haltValidation';
import { courseMarsOracleCompatibilityError } from '../legacy/marsOracleCompatibility';
import {
  maximumOracleDetailedBlockEvents,
  maximumOracleEvidenceEvents,
  createLegacyProgramImage,
  parseStrictHexTextWords,
  programImageFingerprint,
  programImageIssues
} from '../replay/programImage';
import {
  maximumReplayMachineCodeBytes,
  readBoundedRegularFile
} from '../replay/boundedFile';
import { captureSourceGraph } from '../replay/sourceBundle';

/**
 * Wraps the existing MARS pipeline unchanged so phase-1 callers become
 * provider-neutral without any behavior change. The engine executes with the
 * user-configured fork build (as before); the pinned v0.6.3 reference is a
 * conformance-only role and must not be substituted here.
 */
export class LegacyMarsProvider implements MipsAssemblerProvider, MipsExecutionProvider {
  readonly descriptor = LEGACY_MARS_DESCRIPTOR;
  readonly capabilities = LEGACY_MARS_CAPABILITIES;

  private readonly resolvedLaunches = new WeakMap<object, {
    launch: ResolvedLegacyMarsLaunch;
    requestFingerprint: string;
  }>();

  constructor(private readonly services: AppServices) {}

  async preflight(request: AssembleRequest | ExecuteRequest): Promise<ProviderPreflight> {
    // Snapshot the semantic request before the first await.  Otherwise a caller could change the
    // request while launch resolution is pending and bind new options to an old policy decision.
    const requestFingerprint = legacyRequestFingerprint(request);
    const diagnostics: CapabilityDiagnostic[] = [];
    if ('image' in request) {
      const imageIssues = programImageIssues(request.image);
      if (imageIssues.length) {
        diagnostics.push({
          code: 'legacy-mars.program-image-invalid',
          capability: 'program-image-execution',
          message: `ProgramImage 无效：${imageIssues.join('; ')}`
        });
      }
      if (!imageIssues.length && !legacyProgramImageLayoutSupported(request.image)) {
        diagnostics.push({
          code: 'legacy-mars.program-image-layout-unsupported',
          capability: 'program-image-execution',
          message: 'legacy provider 仅支持从 entryPc 开始的单一连续 text ProgramImage'
        });
      }
      const haltImageIssue = !imageIssues.length && request.courseTrace
        ? legacyHaltImageIssue(request.image, request.haltPc)
        : undefined;
      if (haltImageIssue) {
        diagnostics.push({
          code: 'legacy-mars.halt-image-mismatch',
          capability: 'halt-loop-detection',
          message: haltImageIssue
        });
      }
      if (!request.executionBinding
        || request.executionBinding.kind !== 'source-reassembly'
        || request.executionBinding.providerId !== this.descriptor.id
        || request.executionBinding.imageFingerprint !== request.image?.fingerprint) {
        diagnostics.push({
          code: 'legacy-mars.source-binding-required',
          capability: 'source-reassembly-binding',
          message: 'legacy provider 需要由同一 assembler 返回、且绑定当前 ProgramImage fingerprint 的 source-reassembly capability'
        });
      }
    }
    const mode = 'target' in request
      ? request.target.kind === 'kernelText' ? 'dumpKernel' : 'dumpText'
      : 'run';
    const marsOptions = marsOptionsForRequest(request);
    const sourceUri = requestSourceUri(request);
    const resolution = sourceUri
      ? await resolveLegacyMarsLaunch(sourceUri, mode, marsOptions)
      : {
        diagnostics: [{
          code: 'legacy-mars.source-binding-required',
          capability: 'source-reassembly-binding',
          message: 'legacy provider 无法从请求解析 source-reassembly capability'
        } satisfies CapabilityDiagnostic]
      };
    diagnostics.push(...resolution.diagnostics);
    diagnostics.push(...capabilityRequirementDiagnostics(
      this.descriptor,
      this.capabilities,
      request.requirements,
      resolution.launch?.profile
    ));
    if (requestFingerprint !== legacyRequestFingerprint(request)) {
      diagnostics.push({
        code: 'legacy-mars.request-changed-during-preflight',
        capability: 'immutable-preflight',
        message: 'legacy MARS request 在 preflight 期间发生变化；已拒绝绑定过期的启动策略'
      });
    }
    if (diagnostics.length) {
      this.resolvedLaunches.delete(request);
      return failedPreflight(this.descriptor, diagnostics);
    }
    this.resolvedLaunches.set(request, {
      launch: resolution.launch!,
      requestFingerprint
    });
    return okPreflight(this.descriptor);
  }

  async assemble(request: AssembleRequest, context?: ProviderRunContext): Promise<AssembleResult> {
    const snapshot = snapshotAssembleRequest(request, context?.signal);
    const mode = snapshot.target.kind === 'kernelText' ? 'dumpKernel' : 'dumpText';
    const launch = await this.launchFor(request);
    if (!launch.ok) return assemblePreflightFailure(this.descriptor, launch.preflight);
    if (snapshot.requestFingerprint !== legacyRequestFingerprint(request)) {
      return assemblePreflightFailure(this.descriptor, failedPreflight(this.descriptor, [{
        code: 'legacy-mars.request-changed-after-preflight',
        capability: 'immutable-preflight',
        message: 'legacy MARS request 在 preflight 后发生变化；已拒绝执行'
      }]));
    }
    let stageDir: string | undefined;
    try {
      stageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-legacy-assemble-'));
      await fs.promises.chmod(stageDir, 0o700).catch(() => undefined);
      const captured = await captureSourceGraph(
        snapshot.sourceUri.fsPath,
        path.join(stageDir, 'source-bundle'),
        undefined,
        undefined,
        { allowedRoot: legacyAllowedSourceRoot(snapshot.sourceUri) }
      );
      const stagedSourceUri = vscode.Uri.file(captured.rootMaterializedPath);
      const outputFile = snapshot.target.outputFile ?? defaultLegacyDumpOutput(snapshot.sourceUri, mode);
      const stagedLaunch: ResolvedLegacyMarsLaunch = Object.freeze({
        ...launch.value,
        sourcePath: stagedSourceUri.fsPath,
        mode
      });
      const marsOptions: MarsRunOptions = Object.freeze({
        showMessages: false,
        revealOutput: snapshot.revealOutput ?? false,
        courseTrace: snapshot.courseTrace,
        p7RiInstruction: snapshot.p7RiInstruction,
        dumpOutputFile: outputFile,
        signal: snapshot.signal,
        resolvedLaunch: stagedLaunch
      });
      const output = await runMarsFile(this.services, stagedSourceUri, mode, marsOptions);
      const base: AssembleResult = {
        ok: output?.result.ok ?? false,
        outputFile: output?.outputFile,
        courseHaltPc: output?.courseHaltPc,
        status: engineRunStatus(output?.result),
        descriptor: this.descriptor,
        engineArtifact: output?.engineArtifact,
        resolvedRun: output?.resolvedRun
      };
      if (!base.ok || !base.outputFile || mode !== 'dumpText') return base;
      const imageText = (await readBoundedRegularFile(base.outputFile.fsPath, {
        maximumBytes: maximumReplayMachineCodeBytes,
        label: 'legacy assembler ProgramImage dump'
      })).toString('utf8');
      const image = createLegacyProgramImage(imageText, snapshot.inputGraph ?? captured.inputGraph);
      return {
        ...base,
        image,
        executionBinding: {
          kind: 'source-reassembly',
          providerId: this.descriptor.id,
          sourceUri: cloneLocalUri(snapshot.sourceUri),
          imageFingerprint: image.fingerprint
        }
      };
    } catch (error) {
      return {
        ok: false,
        status: {
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: `legacy-mars.private-assembly-failed: ${error instanceof Error ? error.message : String(error)}`,
          timedOut: false
        },
        descriptor: this.descriptor
      };
    } finally {
      if (stageDir) {
        await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async execute(request: ExecuteRequest, context?: ProviderRunContext): Promise<ExecuteResult> {
    // Capture every value the invocation can observe before launchFor reaches its first await.
    // launchFor still rejects mutations around preflight; this private frozen copy additionally
    // prevents a mutation in the promise-continuation gap from changing the actual invocation.
    const snapshot = snapshotExecuteRequest(request, context?.signal);
    // The legacy engine re-assembles from the provider-owned source binding. Orchestration still
    // supplies the authoritative ProgramImage and never handles a MARS dump-shaped request.
    const launch = await this.launchFor(request);
    if (!launch.ok) return executePreflightFailure(this.descriptor, launch.preflight);
    if (snapshot.requestFingerprint !== legacyRequestFingerprint(request)) {
      return executePreflightFailure(this.descriptor, failedPreflight(this.descriptor, [{
        code: 'legacy-mars.request-changed-after-preflight',
        capability: 'immutable-preflight',
        message: 'legacy MARS request 在 preflight 后发生变化；已拒绝执行'
      }]));
    }
    const staged = await prepareVerifiedLegacyExecutionSource(this.services, snapshot, launch.value);
    if (!staged.ok) return staged.result;
    let output: Awaited<ReturnType<typeof runMarsFile>>;
    try {
      const runOutputFile = snapshot.runOutputFile
        ?? vscode.Uri.file(path.join(
          marsRunOutputDirectory(snapshot.sourceUri).fsPath,
          marsOutputFileName(snapshot.sourceUri, snapshot.stdinSource)
        ));
      const stagedRunLaunch: ResolvedLegacyMarsLaunch = Object.freeze({
        ...launch.value,
        sourcePath: staged.sourceUri.fsPath,
        mode: 'run'
      });
      const marsOptions: MarsRunOptions = Object.freeze({
        showMessages: false,
        revealOutput: snapshot.revealOutput ?? false,
        stdin: snapshot.stdin,
        stdinSource: snapshot.stdinSource,
        courseTrace: snapshot.courseTrace,
        traceOutput: snapshot.trace?.kind === 'architectural-writes',
        traceLevel: snapshot.trace?.kind === 'architectural-writes' ? 2 : undefined,
        runOutputFile,
        interruptSchedule: snapshot.interruptSchedule
          ? Object.freeze([...snapshot.interruptSchedule]) as unknown as number[]
          : undefined,
        p7RiInstruction: snapshot.p7RiInstruction,
        maxSteps: snapshot.maxSteps,
        haltPc: snapshot.haltPc,
        signal: snapshot.signal,
        resolvedLaunch: stagedRunLaunch
      });
      output = await runMarsFile(this.services, staged.sourceUri, 'run', marsOptions);
    } finally {
      await fs.promises.rm(staged.stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
    const base: ExecuteResult = {
      ok: output?.result.ok ?? false,
      outputFile: output?.outputFile,
      status: engineRunStatus(output?.result),
      descriptor: this.descriptor,
      engineArtifact: output?.engineArtifact,
      resolvedRun: output?.resolvedRun
    };
    if (!base.ok || !snapshot.trace || !output?.result) {
      return { ...base, stop: stopOutcome(base.status) };
    }
    const projection = legacyCourseTraceProjection(
      snapshot.imageText,
      output.result.stdout,
      launch.value.profile,
      snapshot.haltPc
    );
    if (projection.error) {
      return {
        ...base,
        ok: false,
        status: {
          ...base.status,
          ok: false,
          stderr: base.status.stderr ? `${base.status.stderr}\n${projection.error}` : projection.error
        },
        stop: { kind: 'engine-error' }
      };
    }
    return {
      ...base,
      trace: projection.trace,
      stop: { kind: 'halt-loop', haltPc: snapshot.haltPc }
    };
  }

  private async launchFor(
    request: AssembleRequest | ExecuteRequest
  ): Promise<{ ok: true; value: ResolvedLegacyMarsLaunch } | { ok: false; preflight: ProviderPreflight }> {
    const existing = this.resolvedLaunches.get(request);
    if (existing) {
      this.resolvedLaunches.delete(request);
      if (existing.requestFingerprint !== legacyRequestFingerprint(request)) {
        return {
          ok: false,
          preflight: failedPreflight(this.descriptor, [{
            code: 'legacy-mars.request-changed-after-preflight',
            capability: 'immutable-preflight',
            message: 'legacy MARS request 在 preflight 后发生变化；已拒绝执行'
          }])
        };
      }
      return { ok: true, value: existing.launch };
    }
    const preflight = await this.preflight(request);
    const resolved = this.resolvedLaunches.get(request);
    this.resolvedLaunches.delete(request);
    return preflight.ok && resolved ? { ok: true, value: resolved.launch } : { ok: false, preflight };
  }
}

interface LegacyAssembleRequestSnapshot {
  requestFingerprint: string;
  sourceUri: vscode.Uri;
  inputGraph?: ReadonlyArray<Readonly<{ id: string; uri?: string; contentHash: string }>>;
  target: Readonly<{ kind: AssembleRequest['target']['kind']; outputFile?: vscode.Uri }>;
  courseTrace?: boolean;
  p7RiInstruction?: boolean;
  revealOutput?: boolean;
  signal?: AbortSignal;
}

function snapshotAssembleRequest(
  request: AssembleRequest,
  signal?: AbortSignal
): Readonly<LegacyAssembleRequestSnapshot> {
  return Object.freeze({
    requestFingerprint: legacyRequestFingerprint(request),
    sourceUri: cloneLocalUri(request.sourceUri),
    inputGraph: request.inputGraph
      ? Object.freeze(request.inputGraph.map((unit) => Object.freeze({ ...unit })))
      : undefined,
    target: Object.freeze({
      kind: request.target.kind,
      outputFile: request.target.outputFile ? cloneLocalUri(request.target.outputFile) : undefined
    }),
    courseTrace: request.courseTrace,
    p7RiInstruction: request.p7RiInstruction,
    revealOutput: request.revealOutput,
    signal
  });
}

interface LegacyExecuteRequestSnapshot {
  requestFingerprint: string;
  sourceUri: vscode.Uri;
  imageFingerprint: string;
  imageText: string;
  stdin?: string;
  stdinSource?: vscode.Uri;
  trace?: Readonly<{ kind: 'architectural-writes'; courseCorrect: true }>;
  maxSteps?: number;
  haltPc?: number;
  interruptSchedule?: readonly number[];
  p7RiInstruction?: boolean;
  runOutputFile?: vscode.Uri;
  courseTrace?: boolean;
  revealOutput?: boolean;
  signal?: AbortSignal;
}

function snapshotExecuteRequest(request: ExecuteRequest, signal?: AbortSignal): Readonly<LegacyExecuteRequestSnapshot> {
  const sourceUri = request.executionBinding?.sourceUri;
  if (!sourceUri) throw new Error('legacy source-reassembly binding missing after preflight');
  const interruptSchedule = request.interruptSchedule
    ? Object.freeze([...request.interruptSchedule])
    : undefined;
  return Object.freeze({
    requestFingerprint: legacyRequestFingerprint(request),
    sourceUri: cloneLocalUri(sourceUri),
    imageFingerprint: request.image.fingerprint,
    imageText: legacyProgramImageHexText(request.image),
    stdin: request.stdin,
    stdinSource: request.stdinSource ? cloneLocalUri(request.stdinSource) : undefined,
    trace: request.trace ? Object.freeze({ ...request.trace }) : undefined,
    maxSteps: request.maxSteps,
    haltPc: request.haltPc,
    interruptSchedule,
    p7RiInstruction: request.p7RiInstruction,
    runOutputFile: request.runOutputFile ? cloneLocalUri(request.runOutputFile) : undefined,
    courseTrace: request.courseTrace,
    revealOutput: request.revealOutput,
    signal
  });
}

function cloneLocalUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({});
}

function legacyAllowedSourceRoot(sourceUri: vscode.Uri): string {
  return vscode.workspace?.getWorkspaceFolder?.(sourceUri)?.uri.fsPath
    ?? path.dirname(sourceUri.fsPath);
}

function defaultLegacyDumpOutput(
  sourceUri: vscode.Uri,
  mode: 'dumpText' | 'dumpKernel'
): vscode.Uri {
  if (mode === 'dumpKernel') {
    return vscode.Uri.file(path.join(
      path.dirname(sourceUri.fsPath),
      `${path.basename(sourceUri.fsPath, path.extname(sourceUri.fsPath))}.kernel.txt`
    ));
  }
  const configured = getMachineCode(sourceUri);
  return vscode.Uri.file(path.isAbsolute(configured)
    ? configured
    : path.join(path.dirname(sourceUri.fsPath), configured));
}

function legacyRequestFingerprint(request: AssembleRequest | ExecuteRequest): string {
  const semantic = 'target' in request ? {
    kind: 'assemble',
    source: request.sourceUri.fsPath,
    inputGraph: request.inputGraph ?? null,
    target: request.target.kind,
    output: request.target.outputFile?.fsPath ?? null,
    courseTrace: request.courseTrace ?? false,
    p7RiInstruction: request.p7RiInstruction ?? null,
    revealOutput: request.revealOutput ?? false,
    requirements: request.requirements ?? null
  } : {
    kind: 'execute',
    source: request.executionBinding?.sourceUri.fsPath ?? null,
    binding: request.executionBinding ? {
      kind: request.executionBinding.kind,
      providerId: request.executionBinding.providerId,
      imageFingerprint: request.executionBinding.imageFingerprint
    } : null,
    image: safeProgramImageIdentity(request.image),
    stdinSha256: request.stdin === undefined
      ? null
      : crypto.createHash('sha256').update(request.stdin, 'utf8').digest('hex'),
    stdinSource: request.stdinSource?.fsPath ?? null,
    courseTrace: request.courseTrace ?? false,
    trace: request.trace ?? null,
    maxSteps: request.maxSteps ?? null,
    haltPc: request.haltPc ?? null,
    interruptSchedule: request.interruptSchedule ?? [],
    p7RiInstruction: request.p7RiInstruction ?? null,
    output: request.runOutputFile?.fsPath ?? null,
    revealOutput: request.revealOutput ?? false,
    requirements: request.requirements ?? null
  };
  return crypto.createHash('sha256').update(JSON.stringify(semantic), 'utf8').digest('hex');
}

function marsOptionsForRequest(request: AssembleRequest | ExecuteRequest): MarsRunOptions {
  if ('target' in request) {
    return {
      courseTrace: request.courseTrace,
      p7RiInstruction: request.p7RiInstruction,
      dumpOutputFile: request.target.outputFile,
      revealOutput: request.revealOutput
    };
  }
  return {
    stdin: request.stdin,
    stdinSource: request.stdinSource,
    courseTrace: request.courseTrace,
    traceOutput: request.trace?.kind === 'architectural-writes',
    traceLevel: request.trace?.kind === 'architectural-writes' ? 2 : undefined,
    runOutputFile: request.runOutputFile,
    interruptSchedule: request.interruptSchedule,
    p7RiInstruction: request.p7RiInstruction,
    maxSteps: request.maxSteps,
    haltPc: request.haltPc,
    revealOutput: request.revealOutput
  };
}

function requestSourceUri(request: AssembleRequest | ExecuteRequest): vscode.Uri | undefined {
  return 'target' in request ? request.sourceUri : request.executionBinding?.sourceUri;
}

function legacyProgramImageHexText(image: ExecuteRequest['image']): string {
  if (image.segments.length !== 1 || image.segments[0].baseAddress !== image.entryPc) {
    throw new Error('legacy source adapter requires one contiguous text ProgramImage at entryPc');
  }
  return image.segments[0].words
    .map((word) => (word >>> 0).toString(16).padStart(8, '0'))
    .join('\n') + '\n';
}

function legacyProgramImageLayoutSupported(image: ExecuteRequest['image']): boolean {
  return image.segments.length === 1
    && image.segments[0].name === 'text'
    && image.segments[0].baseAddress === image.entryPc;
}

function legacyHaltImageIssue(image: ExecuteRequest['image'], haltPc: number | undefined): string | undefined {
  if (!Number.isSafeInteger(haltPc) || haltPc! < 0 || haltPc! > 0xffff_ffff) return undefined;
  const address = haltPc! >>> 0;
  for (const segment of image.segments) {
    const offset = address - segment.baseAddress;
    if (offset < 0 || offset % 4 !== 0) continue;
    const index = offset / 4;
    if (index >= segment.words.length) continue;
    if (index + 1 >= segment.words.length
      || (segment.words[index] >>> 0) !== 0x1000ffff
      || (segment.words[index + 1] >>> 0) !== 0) {
      return `haltPc 0x${address.toString(16)} 未指向 ProgramImage 中的 0x1000ffff + nop 标准停机尾`;
    }
    return undefined;
  }
  return `haltPc 0x${address.toString(16)} 不在 ProgramImage 的已装载段内`;
}

function safeProgramImageIdentity(image: unknown): Readonly<{
  claimedFingerprint: string | null;
  computedFingerprint: string | null;
  invalidDigest: string | null;
}> {
  const claimedFingerprint = typeof image === 'object' && image !== null
    && typeof (image as { fingerprint?: unknown }).fingerprint === 'string'
    ? (image as { fingerprint: string }).fingerprint
    : null;
  try {
    return {
      claimedFingerprint,
      computedFingerprint: programImageFingerprint(image as ExecuteRequest['image']),
      invalidDigest: null
    };
  } catch {
    let serialized = '[unserializable]';
    try {
      serialized = JSON.stringify(image) ?? '[undefined]';
    } catch {
      // A cyclic hostile value is still represented by a stable sentinel and rejected by preflight.
    }
    return {
      claimedFingerprint,
      computedFingerprint: null,
      invalidDigest: crypto.createHash('sha256').update(serialized, 'utf8').digest('hex')
    };
  }
}

async function prepareVerifiedLegacyExecutionSource(
  services: AppServices,
  snapshot: Readonly<LegacyExecuteRequestSnapshot>,
  launch: ResolvedLegacyMarsLaunch
): Promise<
  | { ok: true; sourceUri: vscode.Uri; stageDir: string }
  | { ok: false; result: ExecuteResult }
> {
  let stageDir: string | undefined;
  let keepStage = false;
  try {
    stageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-legacy-source-'));
    await fs.promises.chmod(stageDir, 0o700).catch(() => undefined);
    const sourceBundleDir = path.join(stageDir, 'source-bundle');
    const captured = await captureSourceGraph(
      snapshot.sourceUri.fsPath,
      sourceBundleDir,
      undefined,
      undefined,
      { allowedRoot: legacyAllowedSourceRoot(snapshot.sourceUri) }
    );
    const sourceUri = vscode.Uri.file(captured.rootMaterializedPath);
    const dumpFile = vscode.Uri.file(path.join(stageDir, 'verified-image.txt'));
    const dumpLaunch: ResolvedLegacyMarsLaunch = Object.freeze({
      ...launch,
      sourcePath: sourceUri.fsPath,
      mode: 'dumpText'
    });
    const verificationOutput = await runMarsFile(services, sourceUri, 'dumpText', Object.freeze({
      showMessages: false,
      revealOutput: false,
      courseTrace: snapshot.courseTrace,
      p7RiInstruction: snapshot.p7RiInstruction,
      dumpOutputFile: dumpFile,
      signal: snapshot.signal,
      resolvedLaunch: dumpLaunch
    }));
    if (!verificationOutput?.result.ok || !verificationOutput.outputFile) {
      const status = engineRunStatus(verificationOutput?.result);
      return {
        ok: false,
        result: {
          ok: false,
          outputFile: verificationOutput?.outputFile,
          status: {
            ...status,
            ok: false,
            stderr: status.stderr || 'legacy provider 私有重汇编失败，未执行 ProgramImage'
          },
          descriptor: LEGACY_MARS_DESCRIPTOR,
          engineArtifact: verificationOutput?.engineArtifact,
          resolvedRun: verificationOutput?.resolvedRun,
          stop: { kind: 'engine-error' }
        }
      };
    }
    const dumpText = (await readBoundedRegularFile(verificationOutput.outputFile.fsPath, {
      maximumBytes: maximumReplayMachineCodeBytes,
      label: 'legacy provider private ProgramImage verification dump'
    })).toString('utf8');
    const actualWords = parseStrictHexTextWords(dumpText);
    const expectedWords = parseStrictHexTextWords(snapshot.imageText);
    if (actualWords.length !== expectedWords.length
      || actualWords.some((word, index) => word !== expectedWords[index])) {
      const message = 'legacy-mars.program-image-mismatch: 私有重汇编结果与权威 ProgramImage 不一致；已拒绝执行';
      return {
        ok: false,
        result: {
          ok: false,
          status: {
            ...engineRunStatus(verificationOutput.result),
            ok: false,
            stderr: message
          },
          descriptor: LEGACY_MARS_DESCRIPTOR,
          engineArtifact: verificationOutput.engineArtifact,
          resolvedRun: verificationOutput.resolvedRun,
          stop: { kind: 'engine-error' }
        }
      };
    }
    keepStage = true;
    return { ok: true, sourceUri, stageDir };
  } catch (error) {
    const message = `legacy-mars.program-image-verification-failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      result: {
        ok: false,
        status: {
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: message,
          timedOut: false,
          stopReason: 'preflight'
        },
        descriptor: LEGACY_MARS_DESCRIPTOR,
        stop: { kind: 'engine-error' }
      }
    };
  } finally {
    if (stageDir && !keepStage) {
      await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function legacyCourseTraceProjection(
  imageText: string,
  rawText: string,
  profile: string,
  haltPc: number | undefined
): { trace?: ArchitecturalWriteTrace; error?: string } {
  if (!Number.isSafeInteger(haltPc)) {
    return { error: 'provider 未获得可验证的 halt-loop PC' };
  }
  const haltError = courseTraceMarsHaltError(rawText, haltPc!);
  if (haltError) return { error: haltError };
  const compatibilityError = courseMarsOracleCompatibilityError(
    profile as ProjectProfile,
    imageText,
    rawText,
    profile === 'P5' || profile === 'P6' || profile === 'P7'
  );
  if (compatibilityError) return { error: compatibilityError };

  const events: CpuTraceEvent[] = [];
  try {
    for (const event of iterMarsDetailedTraceEvents(rawText, maximumOracleDetailedBlockEvents)) {
      if (events.length >= maximumOracleEvidenceEvents) {
        return { error: `oracle event count exceeds trusted limit ${maximumOracleEvidenceEvents}` };
      }
      events.push(Object.freeze({ ...event }));
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return {
    trace: Object.freeze({
      schemaRevision: 1,
      eventSchema: 'buaa-co-architectural-write-v1',
      events: Object.freeze(events),
      rawText,
      rawTraceRevision: 2
    })
  };
}

function stopOutcome(status: EngineRunStatus): NonNullable<ExecuteResult['stop']> {
  if (status.timedOut) return { kind: 'timeout' };
  if (status.stopReason === 'aborted') return { kind: 'cancelled' };
  return { kind: status.ok ? 'completed' : 'engine-error' };
}

function assemblePreflightFailure(
  descriptor: typeof LEGACY_MARS_DESCRIPTOR,
  preflight: ProviderPreflight
): AssembleResult {
  return {
    ok: false,
    status: preflightStatus(preflight),
    descriptor
  };
}

function executePreflightFailure(
  descriptor: typeof LEGACY_MARS_DESCRIPTOR,
  preflight: ProviderPreflight
): ExecuteResult {
  return {
    ok: false,
    status: preflightStatus(preflight),
    descriptor
  };
}

function preflightStatus(preflight: ProviderPreflight): EngineRunStatus {
  return {
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: preflight.diagnostics.map((item) => `[${item.code}] ${item.message}`).join('\n'),
    timedOut: false,
    stopReason: 'preflight'
  };
}

function engineRunStatus(result: {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stopped?: boolean;
  stopReason?: string;
  commandLine?: string;
  cwd?: string;
} | undefined): EngineRunStatus {
  if (result) {
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      stopped: result.stopped,
      stopReason: result.stopReason,
      commandLine: result.commandLine,
      cwd: result.cwd
    };
  }
  return {
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: 'legacy MARS provider：运行被拒绝（profile 未确定或工具未配置）',
    timedOut: false
  };
}
