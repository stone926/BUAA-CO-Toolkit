// @index mips-providers — LegacyMarsProvider：完整包装现有 runMarsFile 行为（dumpText/dumpKernel/run）
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { runMarsFile, MarsRunOptions } from '../../mips';
import { AppServices } from '../../types';
import {
  AssembleRequest,
  AssembleResult,
  CapabilityDiagnostic,
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
import {
  resolveLegacyMarsLaunch,
  type ResolvedLegacyMarsLaunch
} from './legacyMarsLaunch';

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
    if ('imageRef' in request && request.imageRef.kind === 'program-image') {
      diagnostics.push({
        code: 'legacy-mars.program-image-unsupported',
        capability: 'program-image-execution',
        message: 'legacy MARS provider 不能执行 ProgramImage；它只能运行与已验证 MARS dump 对应的源文件'
      });
    }
    const mode = 'target' in request
      ? request.target.kind === 'kernelText' ? 'dumpKernel' : 'dumpText'
      : 'run';
    const marsOptions = marsOptionsForRequest(request);
    const resolution = await resolveLegacyMarsLaunch(request.sourceUri, mode, marsOptions);
    diagnostics.push(...resolution.diagnostics);
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
    const marsOptions: MarsRunOptions = Object.freeze({
      showMessages: false,
      revealOutput: snapshot.revealOutput ?? false,
      courseTrace: snapshot.courseTrace,
      p7RiInstruction: snapshot.p7RiInstruction,
      dumpOutputFile: snapshot.target.outputFile,
      signal: snapshot.signal,
      resolvedLaunch: launch.value
    });
    const output = await runMarsFile(this.services, snapshot.sourceUri, mode, marsOptions);
    return {
      ok: output?.result.ok ?? false,
      outputFile: output?.outputFile,
      courseHaltPc: output?.courseHaltPc,
      status: engineRunStatus(output?.result),
      descriptor: this.descriptor,
      engineArtifact: output?.engineArtifact,
      resolvedRun: output?.resolvedRun
    };
  }

  async execute(request: ExecuteRequest, context?: ProviderRunContext): Promise<ExecuteResult> {
    // Capture every value the invocation can observe before launchFor reaches its first await.
    // launchFor still rejects mutations around preflight; this private frozen copy additionally
    // prevents a mutation in the promise-continuation gap from changing the actual invocation.
    const snapshot = snapshotExecuteRequest(request, context?.signal);
    // The legacy engine re-assembles and re-executes from source; the validated
    // dump reference stays available to callers for image-level checking.
    const launch = await this.launchFor(request);
    if (!launch.ok) return executePreflightFailure(this.descriptor, launch.preflight);
    if (snapshot.requestFingerprint !== legacyRequestFingerprint(request)) {
      return executePreflightFailure(this.descriptor, failedPreflight(this.descriptor, [{
        code: 'legacy-mars.request-changed-after-preflight',
        capability: 'immutable-preflight',
        message: 'legacy MARS request 在 preflight 后发生变化；已拒绝执行'
      }]));
    }
    const marsOptions: MarsRunOptions = Object.freeze({
      showMessages: false,
      revealOutput: snapshot.revealOutput ?? false,
      stdin: snapshot.stdin,
      stdinSource: snapshot.stdinSource,
      courseTrace: snapshot.courseTrace,
      traceOutput: snapshot.traceOutput,
      traceLevel: snapshot.traceLevel,
      runOutputFile: snapshot.runOutputFile,
      interruptSchedule: snapshot.interruptSchedule
        ? Object.freeze([...snapshot.interruptSchedule]) as unknown as number[]
        : undefined,
      p7RiInstruction: snapshot.p7RiInstruction,
      maxSteps: snapshot.maxSteps,
      haltPc: snapshot.haltPc ?? (snapshot.imageRef.kind === 'mars-dump' ? snapshot.imageRef.haltPc : undefined),
      signal: snapshot.signal,
      resolvedLaunch: launch.value
    });
    const output = await runMarsFile(this.services, snapshot.sourceUri, 'run', marsOptions);
    return {
      ok: output?.result.ok ?? false,
      outputFile: output?.outputFile,
      status: engineRunStatus(output?.result),
      descriptor: this.descriptor,
      engineArtifact: output?.engineArtifact,
      resolvedRun: output?.resolvedRun
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
  imageRef:
    | Readonly<{ kind: 'mars-dump'; machineCodeUri: vscode.Uri; haltPc?: number }>
    | Readonly<{ kind: 'program-image'; fingerprint: string }>;
  stdin?: string;
  stdinSource?: vscode.Uri;
  traceOutput?: boolean;
  traceLevel?: 1 | 2;
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
  const imageRef: LegacyExecuteRequestSnapshot['imageRef'] = request.imageRef.kind === 'mars-dump'
    ? Object.freeze({
      kind: 'mars-dump',
      machineCodeUri: cloneLocalUri(request.imageRef.machineCodeUri),
      haltPc: request.imageRef.haltPc
    })
    : Object.freeze({ kind: 'program-image', fingerprint: request.imageRef.image.fingerprint });
  const interruptSchedule = request.interruptSchedule
    ? Object.freeze([...request.interruptSchedule])
    : undefined;
  return Object.freeze({
    requestFingerprint: legacyRequestFingerprint(request),
    sourceUri: cloneLocalUri(request.sourceUri),
    imageRef,
    stdin: request.stdin,
    stdinSource: request.stdinSource ? cloneLocalUri(request.stdinSource) : undefined,
    traceOutput: request.traceOutput,
    traceLevel: request.traceLevel,
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

function legacyRequestFingerprint(request: AssembleRequest | ExecuteRequest): string {
  const semantic = 'target' in request ? {
    kind: 'assemble',
    source: request.sourceUri.fsPath,
    target: request.target.kind,
    output: request.target.outputFile?.fsPath ?? null,
    courseTrace: request.courseTrace ?? false,
    p7RiInstruction: request.p7RiInstruction ?? null,
    revealOutput: request.revealOutput ?? false
  } : {
    kind: 'execute',
    source: request.sourceUri.fsPath,
    image: request.imageRef.kind === 'mars-dump' ? {
      kind: request.imageRef.kind,
      machineCode: request.imageRef.machineCodeUri.fsPath,
      haltPc: request.imageRef.haltPc ?? null
    } : { kind: request.imageRef.kind, fingerprint: request.imageRef.image.fingerprint },
    stdinSha256: request.stdin === undefined
      ? null
      : crypto.createHash('sha256').update(request.stdin, 'utf8').digest('hex'),
    stdinSource: request.stdinSource?.fsPath ?? null,
    courseTrace: request.courseTrace ?? false,
    traceOutput: request.traceOutput ?? false,
    traceLevel: request.traceLevel ?? null,
    maxSteps: request.maxSteps ?? null,
    haltPc: request.haltPc ?? null,
    interruptSchedule: request.interruptSchedule ?? [],
    p7RiInstruction: request.p7RiInstruction ?? null,
    output: request.runOutputFile?.fsPath ?? null,
    revealOutput: request.revealOutput ?? false
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
    traceOutput: request.traceOutput,
    traceLevel: request.traceLevel,
    runOutputFile: request.runOutputFile,
    interruptSchedule: request.interruptSchedule,
    p7RiInstruction: request.p7RiInstruction,
    maxSteps: request.maxSteps,
    haltPc: request.haltPc ?? (request.imageRef.kind === 'mars-dump' ? request.imageRef.haltPc : undefined),
    revealOutput: request.revealOutput
  };
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
