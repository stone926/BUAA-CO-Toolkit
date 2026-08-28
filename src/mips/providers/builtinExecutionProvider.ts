// @index mips-providers — BuiltinTsExecutionProvider：phase-2/3 核心的直接 provider（仅 executor，显式 shadow/verify-both）

import * as vscode from 'vscode';

import {
  ArchitecturalWriteTrace,
  BUILTIN_TS_DESCRIPTOR,
  capabilityRequirementDiagnostics,
  CapabilityDiagnostic,
  ExecuteRequest,
  ExecuteResult,
  EngineRunStatus,
  EngineStopKind,
  failedPreflight,
  MipsExecutionProvider,
  okPreflight,
  ProviderPreflight,
  ProviderRunContext,
  ResolvedEngineRun
} from './contracts';
import {
  CommitEvent,
  commitEventsCanonical,
  ExecutionDiagnostic
} from '../core/events/commitEvent';
import { ExecutionCoverageCollector } from '../core/events/coverage';
import {
  ArchitecturalWriteRecord,
  formatArchitecturalWrites,
  projectCommitEvent
} from '../core/events/traceProjection';
import { CourseProfile, isaInstructions } from '../core/generated/isaCatalog';
import { maximumExecuteSteps } from '../core/machine/executeService';
import { CourseSystemSession } from '../core/machine/system';
import { resolveCourseProfile, courseProfileIds } from '../core/profiles/courseProfiles';
import { iterCpuTraceEvents, type CpuTraceEvent } from '../../language/mips/traceParser';
import { programImageIssues } from '../replay/programImage';
import { builtinExecutionEngineArtifact } from '../replay/builtinEngineArtifact';
import { canonicalJson, sha256Canonical, type CanonicalJson } from '../replay/canonical';
import { writeFileAtomicReplace } from '../replay/atomicFile';
import type { WorkerJob, WorkerOutboundMessage } from '../host/workerProtocol';
import type { EngineCapabilities } from '../core/api';

/**
 * Phase-4 registration is executor-only. The assembler half arrives in phase 5,
 * so this provider is intentionally not an `MipsAssemblerProvider` and can only
 * consume a `ProgramImage` produced and frozen by the legacy/phase-5 assembler.
 */
export const BUILTIN_TS_EXECUTION_CAPABILITIES: EngineCapabilities = {
  profiles: ['P3', 'P4', 'P5', 'P6', 'P7'],
  instructionLayers: Object.fromEntries(
    (['required', 'commonExtensions', 'marsCompatibility'] as const).map((layer) => [
      layer,
      [...new Set(isaInstructions
        .filter((instruction) => instruction.layer === layer)
        .map((instruction) => instruction.mnemonic))].sort()
    ])
  ),
  assembly: {
    directives: [],
    pseudoInstructions: 'none',
    macros: false,
    includes: false
  },
  syscalls: { modes: ['course-exception'], deterministic: true },
  devices: ['cp0', 'timer', 'external-interrupt-generator'],
  console: { deterministicInput: false, deterministicOutput: true, interactive: false },
  executionFeatures: [
    'delayed-branching',
    'overflow-traps',
    'cp0-exceptions',
    'timer-devices',
    'external-interrupt',
    'undefined-domain-classification'
  ],
  catalogRevision: 1,
  normalizerRevision: 1,
  eventSchemaRevision: 1,
  courseContractRevision: 1
};

const defaultMaximumSteps = 65_536;
const checkpointInterval = 128;

/** Minimal worker host surface; `MipsRuntimeManager` satisfies it in production. */
export interface BuiltinWorkerRuntime {
  runJob(
    job: WorkerJob,
    options?: { signal?: AbortSignal; onProgress?: (batch: unknown[]) => void | Promise<void> }
  ): Promise<WorkerOutboundMessage>;
}

interface BuiltinExecuteSnapshot {
  readonly requestFingerprint: string;
  readonly profile: CourseProfile;
  readonly image: ExecuteRequest['image'];
  readonly trace: boolean;
  readonly maxSteps: number;
  readonly haltPc?: number;
  readonly interruptSchedule: readonly number[];
  readonly runOutputFile?: vscode.Uri;
  readonly revealOutput?: boolean;
  readonly signal?: AbortSignal;
}

export class BuiltinTsExecutionProvider implements MipsExecutionProvider {
  readonly descriptor = BUILTIN_TS_DESCRIPTOR;
  readonly capabilities = BUILTIN_TS_EXECUTION_CAPABILITIES;

  private readonly preflightFingerprints = new WeakMap<ExecuteRequest, string>();

  constructor(private readonly workerRuntime?: BuiltinWorkerRuntime) {}

  async preflight(request: ExecuteRequest): Promise<ProviderPreflight> {
    const requestFingerprint = builtinRequestFingerprint(request);
    const diagnostics: CapabilityDiagnostic[] = [];
    const profile = resolveRequestProfile(request);
    if (!profile) {
      diagnostics.push({
        code: 'builtin-ts.profile-required',
        capability: 'profile',
        message: 'builtin executor 需要 ExecuteRequest.profile 或 requirements.profile'
      });
    }
    const imageIssues = programImageIssues(request.image);
    if (imageIssues.length) {
      diagnostics.push({
        code: 'builtin-ts.program-image-invalid',
        capability: 'program-image-execution',
        message: `ProgramImage 无效：${imageIssues.join('; ')}`
      });
    }
    if (request.trace?.kind !== 'architectural-writes' || request.trace?.courseCorrect !== true) {
      diagnostics.push({
        code: 'builtin-ts.course-trace-required',
        capability: 'architectural-write-trace',
        message: 'builtin shadow/verify-both 只支持 course-correct architectural-writes trace'
      });
    }
    if (request.stdin) {
      diagnostics.push({
        code: 'builtin-ts.stdin-unsupported',
        capability: 'deterministic-console',
        message: 'builtin executor 尚未实现 stdin syscall host；shadow 不覆盖带 stdin 的用例'
      });
    }
    if (request.maxSteps !== undefined
      && (!Number.isSafeInteger(request.maxSteps) || request.maxSteps <= 0)) {
      diagnostics.push({
        code: 'builtin-ts.max-steps-invalid',
        capability: 'step-policy',
        message: 'maxSteps 必须是正整数'
      });
    } else if ((request.maxSteps ?? defaultMaximumSteps) > maximumExecuteSteps) {
      diagnostics.push({
        code: 'builtin-ts.max-steps-too-large',
        capability: 'step-policy',
        message: `maxSteps 超过核心上限 ${maximumExecuteSteps}`
      });
    }
    if (request.interruptSchedule?.length && profile !== 'P7') {
      diagnostics.push({
        code: 'builtin-ts.interrupt-schedule-profile-mismatch',
        capability: 'external-interrupt',
        message: '外部中断 schedule 仅适用于 P7 profile'
      });
    }
    if (request.interruptSchedule?.some((pc) => !Number.isSafeInteger(pc))) {
      diagnostics.push({
        code: 'builtin-ts.interrupt-schedule-invalid',
        capability: 'external-interrupt',
        message: 'interruptSchedule 必须由安全整数组成'
      });
    }
    diagnostics.push(...capabilityRequirementDiagnostics(
      this.descriptor,
      this.capabilities,
      request.requirements,
      profile
    ));
    if (profile && request.requirements?.instructionLayers?.length) {
      for (const layer of request.requirements.instructionLayers) {
        if (!this.capabilities.instructionLayers[layer]?.length) {
          diagnostics.push({
            code: 'builtin-ts.instruction-layer-unsupported',
            capability: `instruction-layer:${layer}`,
            message: `builtin executor 未声明指令层 ${layer}`
          });
        }
      }
    }
    if (diagnostics.length) {
      this.preflightFingerprints.delete(request);
      return failedPreflight(this.descriptor, diagnostics);
    }
    this.preflightFingerprints.set(request, requestFingerprint);
    return okPreflight(this.descriptor);
  }

  async execute(request: ExecuteRequest, context?: ProviderRunContext): Promise<ExecuteResult> {
    const snapshot = snapshotRequest(request, context?.signal);
    let expectedFingerprint = this.preflightFingerprints.get(request);
    this.preflightFingerprints.delete(request);
    if (expectedFingerprint === undefined) {
      // Provider contracts always resolve through preflight; direct API users get
      // the same fail-closed gate instead of a side effect without a decision.
      const preflight = await this.preflight(request);
      if (!preflight.ok) {
        return {
          ok: false,
          status: {
            ok: false,
            exitCode: null,
            stdout: '',
            stderr: preflight.diagnostics.map((item) => `[${item.code}] ${item.message}`).join('\n'),
            timedOut: false,
            stopReason: 'engine-error'
          },
          descriptor: this.descriptor,
          stop: { kind: 'engine-error' }
        };
      }
      expectedFingerprint = this.preflightFingerprints.get(request);
      this.preflightFingerprints.delete(request);
    }
    if (expectedFingerprint !== snapshot.requestFingerprint) {
      return {
        ok: false,
        status: {
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: '[builtin-ts.request-changed-after-preflight] request 在 preflight 后发生变化；已拒绝执行',
          timedOut: false,
          stopReason: 'engine-error'
        },
        descriptor: this.descriptor,
        stop: { kind: 'engine-error' }
      };
    }
    const started = Date.now();
    if (this.workerRuntime) {
      return await this.executeWithWorkerRuntime(request, snapshot, started, context?.onCommitEvent);
    }
    const session = new CourseSystemSession({
      profile: resolveCourseProfile(snapshot.profile),
      image: snapshot.image,
      layers: request.requirements?.instructionLayers ?? ['required', 'commonExtensions', 'marsCompatibility'],
      maxSteps: snapshot.maxSteps,
      ...(snapshot.haltPc === undefined ? {} : { haltPc: snapshot.haltPc }),
      externalInterrupts: snapshot.interruptSchedule.map((victimPc) => ({
        victimPc: victimPc >>> 0,
        occurrence: 1
      })),
      // Phase 4 never fabricates a Timer cycle mapping; accesses without an
      // explicit device timeline fail closed as out-of-domain.
      deviceSchedule: { kind: 'disabled' }
    });
    const outcome = await runBuiltinCourseProgram(session, {
      signal: snapshot.signal,
      collectTrace: snapshot.trace,
      onCommitEvent: context?.onCommitEvent
    });
    const events = outcome.events;

    const rawText = snapshot.trace
      ? formatArchitecturalWrites(outcome.trace ?? [])
      : '';
    const eventDigest = sha256Canonical(commitEventsCanonical(events) as CanonicalJson);
    const stop = builtinStop(outcome.status, outcome.haltReason, outcome.haltPc, outcome.diagnostic);
    const success = outcome.status === 'halted' && outcome.haltReason !== 'cancelled';
    const status = builtinStatus(success, stop.kind, outcome.diagnostic, rawText);
    const resolvedRun: ResolvedEngineRun = {
      profile: snapshot.profile,
      memoryConfiguration: request.memoryConfiguration ?? 'course-contract-v1',
      runtime: { kind: 'builtin-ts' },
      wallClockMs: Math.max(1, Date.now() - started),
      p7RiInstruction: false
    };

    const trace: ArchitecturalWriteTrace | undefined = snapshot.trace
      ? {
        schemaRevision: 1,
        eventSchema: 'buaa-co-architectural-write-v1',
        events: parseRawTrace(rawText),
        rawText,
        rawTraceRevision: 1
      }
      : undefined;

    const outputFile = await writeBuiltinRunOutput(
      snapshot.runOutputFile,
      rawText,
      snapshot.trace
    );
    const eventArtifact = await writeBuiltinEventArtifact(outputFile, {
      schemaRevision: 1,
      eventSchema: 'buaa-co-commit-event-v1',
      engine: this.descriptor,
      imageFingerprint: snapshot.image.fingerprint,
      profile: snapshot.profile,
      stop,
      status: outcome.status,
      instructions: outcome.instructions,
      eventCount: outcome.eventCount,
      eventDigest,
      finalStateDigest: outcome.finalStateDigest,
      events: commitEventsCanonical(events) as CanonicalJson,
      coverage: outcome.coverage ?? [],
      checkpoints: outcome.checkpoints
    });

    return {
      ok: success,
      ...(outputFile ? { outputFile } : {}),
      ...(eventArtifact ? { eventArtifact } : {}),
      status,
      descriptor: this.descriptor,
      engineArtifact: builtinExecutionEngineArtifact().identity,
      resolvedRun,
      ...(trace ? { trace } : {}),
      events,
      instructions: outcome.instructions,
      eventCount: outcome.eventCount,
      eventDigest,
      coverage: outcome.coverage,
      finalStateDigest: outcome.finalStateDigest,
      checkpoints: outcome.checkpoints,
      stop
    };
  }

  /** Execute through the lazy Worker host; no MIPS semantics run on the extension-host thread. */
  private async executeWithWorkerRuntime(
    request: ExecuteRequest,
    snapshot: BuiltinExecuteSnapshot,
    started: number,
    onCommitEvent?: (event: CommitEvent) => void
  ): Promise<ExecuteResult> {
    const runtime = this.workerRuntime!;
    const workerEvents: CommitEvent[] = [];
    const message = await runtime.runJob({
      kind: 'machine-execute',
      payload: builtinWorkerPayload(request, snapshot)
    }, {
      signal: snapshot.signal,
      onProgress: (batch) => {
        for (const item of batch) {
          if (!isCommitEventLike(item)) {
            throw new Error('builtin worker emitted a malformed commit event batch');
          }
          workerEvents.push(item);
          onCommitEvent?.(item);
        }
      }
    });
    if (message.kind !== 'result') {
      throw new Error('builtin worker returned progress as its terminal message');
    }
    if (!message.ok) {
      return {
        ok: false,
        status: {
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: message.cancelled ? 'cancelled' : (message.error ?? 'worker execution failed'),
          timedOut: false,
          stopped: true,
          stopReason: message.cancelled ? 'cancelled' : 'engine-error'
        },
        descriptor: this.descriptor,
        stop: { kind: message.cancelled ? 'cancelled' : 'engine-error' }
      };
    }
    const value = workerExecutePayload(message.payload);
    const rawText = snapshot.trace ? (value.trace ?? []).join('\n') : '';
    const success = value.status === 'halted' && value.haltReason !== 'cancelled';
    const stop = builtinStop(
      value.status === 'halted' || value.status === 'out-of-domain' || value.status === 'step-limit'
        ? value.status
        : 'step-limit',
      value.haltReason,
      value.haltPc === undefined ? undefined : Number.parseInt(value.haltPc, 16),
      value.diagnostic
    );
    const status = builtinStatus(
      success,
      stop.kind,
      value.diagnostic,
      rawText
    );
    const trace = snapshot.trace
      ? {
        schemaRevision: 1 as const,
        eventSchema: 'buaa-co-architectural-write-v1' as const,
        events: parseRawTrace(rawText),
        rawText,
        rawTraceRevision: 1 as const
      }
      : undefined;
    const outputFile = await writeBuiltinRunOutput(snapshot.runOutputFile, rawText, snapshot.trace);
    const eventDigest = sha256Canonical(commitEventsCanonical(workerEvents) as CanonicalJson);
    const eventArtifact = await writeBuiltinEventArtifact(outputFile, {
      schemaRevision: 1,
      eventSchema: 'buaa-co-commit-event-v1',
      engine: this.descriptor,
      imageFingerprint: snapshot.image.fingerprint,
      profile: snapshot.profile,
      stop,
      status: value.status,
      instructions: value.instructions,
      eventCount: value.eventCount,
      eventDigest,
      finalStateDigest: value.finalStateDigest,
      events: commitEventsCanonical(workerEvents) as CanonicalJson,
      coverage: value.coverage ?? [],
      checkpoints: value.checkpoints ?? []
    });
    return {
      ok: success,
      ...(outputFile ? { outputFile } : {}),
      ...(eventArtifact ? { eventArtifact } : {}),
      status,
      descriptor: this.descriptor,
      engineArtifact: builtinExecutionEngineArtifact().identity,
      resolvedRun: {
        profile: snapshot.profile,
        memoryConfiguration: request.memoryConfiguration ?? 'course-contract-v1',
        runtime: { kind: 'builtin-ts' },
        wallClockMs: Math.max(1, Date.now() - started),
        p7RiInstruction: false
      },
      ...(trace ? { trace } : {}),
      events: workerEvents,
      instructions: value.instructions,
      eventCount: value.eventCount,
      eventDigest,
      coverage: value.coverage,
      finalStateDigest: value.finalStateDigest,
      checkpoints: value.checkpoints,
      stop
    };
  }
}

interface BuiltinRunOutcome {
  readonly status: 'committed' | 'halted' | 'out-of-domain' | 'step-limit';
  readonly haltReason?: string;
  readonly diagnostic?: ExecutionDiagnostic;
  readonly instructions: number;
  readonly haltPc?: number;
  readonly events: readonly CommitEvent[];
  readonly eventCount: number;
  readonly finalSnapshot: ReturnType<CourseSystemSession['snapshot']>;
  readonly finalStateDigest: string;
  readonly checkpoints: readonly { readonly instruction: number; readonly digest: string }[];
  readonly trace?: readonly ArchitecturalWriteRecord[];
  readonly coverage?: ReturnType<ExecutionCoverageCollector['bins']>;
}

/**
 * Provider-side async driver. The core `runCourseProgram` is intentionally
 * synchronous for CLI/Worker callers; the extension host needs to yield between
 * slices so a long shadow run cannot block VS Code. Semantics stay identical:
 * same slice size, same checkpoint rule, same cancellation shape.
 */
async function runBuiltinCourseProgram(
  session: CourseSystemSession,
  options: {
    readonly signal?: AbortSignal;
    readonly collectTrace: boolean;
    readonly onCommitEvent?: (event: CommitEvent) => void;
  }
): Promise<BuiltinRunOutcome> {
  const profile = session.profile;
  const coverage = new ExecutionCoverageCollector(profile);
  const events: CommitEvent[] = [];
  const trace: ArchitecturalWriteRecord[] | undefined = options.collectTrace ? [] : undefined;
  const checkpoints: { instruction: number; digest: string }[] = [];

  let status: BuiltinRunOutcome['status'] = 'committed';
  let haltReason: string | undefined;
  let diagnostic: ExecutionDiagnostic | undefined;
  let eventCount = 0;

  for (;;) {
    if (options.signal?.aborted) {
      status = 'halted';
      haltReason = 'cancelled';
      break;
    }
    let sliceStatus: BuiltinRunOutcome['status'] = 'committed';
    for (let index = 0; index < 128; index++) {
      const result = session.stepInstruction();
      if (result.event) {
        eventCount++;
        events.push(result.event);
        options.onCommitEvent?.(result.event);
        coverage.observe(result.event);
        if (trace) trace.push(...projectCommitEvent(result.event, profile));
      }
      if (session.instructionsExecuted > 0
        && session.instructionsExecuted % checkpointInterval === 0
        && result.status === 'committed') {
        checkpoints.push({
          instruction: session.instructionsExecuted,
          digest: session.snapshot('registers').digest
        });
      }
      if (result.status !== 'committed') {
        sliceStatus = result.status;
        haltReason = result.event?.haltReason ?? haltReason;
        diagnostic = result.diagnostic ?? diagnostic;
        break;
      }
    }
    if (sliceStatus !== 'committed') {
      status = sliceStatus;
      break;
    }
    // Yield to the extension-host message loop. This is the same cooperative
    // boundary the phase-1 worker uses, without spawning a Worker for one case.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const finalSnapshot = session.snapshot('full');
  return {
    status,
    ...(haltReason ? { haltReason } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    instructions: session.instructionsExecuted,
    ...(session.courseHaltPc === undefined ? {} : { haltPc: session.courseHaltPc }),
    events,
    eventCount,
    finalSnapshot,
    finalStateDigest: finalSnapshot.digest,
    checkpoints,
    ...(trace ? { trace } : {}),
    coverage: coverage.bins()
  };
}

function builtinWorkerPayload(
  request: ExecuteRequest,
  snapshot: BuiltinExecuteSnapshot
): unknown {
  return {
    profile: snapshot.profile,
    enabledLayers: request.requirements?.instructionLayers
      ?? ['required', 'commonExtensions', 'marsCompatibility'],
    segments: snapshot.image.segments.map((segment) => ({
      name: segment.name,
      baseAddress: fixedHex(segment.baseAddress),
      words: segment.words.map(fixedHex)
    })),
    entryPc: fixedHex(snapshot.image.entryPc),
    maxSteps: snapshot.maxSteps,
    ...(snapshot.haltPc === undefined ? {} : { haltPc: fixedHex(snapshot.haltPc) }),
    ...(snapshot.interruptSchedule.length
      ? {
        externalInterrupts: snapshot.interruptSchedule.map((victimPc) => ({
          victimPc: fixedHex(victimPc),
          occurrence: 1
        }))
      }
      : {}),
    collectTrace: snapshot.trace,
    collectCoverage: true,
    checkpointInterval
  };
}

interface BuiltinWorkerExecutePayload {
  readonly status?: string;
  readonly haltReason?: string;
  readonly instructions?: number;
  readonly eventCount?: number;
  readonly haltPc?: string;
  readonly finalStateDigest?: string;
  readonly trace?: readonly string[];
  readonly coverage?: ExecuteResult['coverage'];
  readonly checkpoints?: readonly { readonly instruction: number; readonly digest: string }[];
  readonly diagnostic?: ExecutionDiagnostic;
}

function workerExecutePayload(value: unknown): BuiltinWorkerExecutePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('builtin worker returned a malformed execute payload');
  }
  const payload = value as BuiltinWorkerExecutePayload;
  if (typeof payload.status !== 'string'
    || !['halted', 'out-of-domain', 'step-limit'].includes(payload.status)) {
    throw new Error('builtin worker returned an invalid status');
  }
  return {
    ...payload,
    trace: Array.isArray(payload.trace) ? payload.trace.filter((line) => typeof line === 'string') : undefined
  };
}

function isCommitEventLike(value: unknown): value is CommitEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const event = value as Partial<CommitEvent>;
  return typeof event.sequence === 'number'
    && typeof event.kind === 'string'
    && typeof event.pcBefore === 'number'
    && typeof event.pcAfter === 'number'
    && Array.isArray(event.gprWrites)
    && Array.isArray(event.hiLoWrites)
    && Array.isArray(event.cp0Writes)
    && Array.isArray(event.memoryWrites)
    && Array.isArray(event.deviceEvents);
}

function fixedHex(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

/** Snapshot every value before execution; builtin has no await before running, but callers can mutate after return. */
function snapshotRequest(request: ExecuteRequest, signal?: AbortSignal): BuiltinExecuteSnapshot {
  const profile = resolveRequestProfile(request);
  if (!profile) throw new Error('builtin preflight must resolve a profile before execute');
  return Object.freeze({
    requestFingerprint: builtinRequestFingerprint(request),
    profile,
    image: request.image,
    trace: request.trace?.kind === 'architectural-writes' && request.trace?.courseCorrect === true,
    maxSteps: Math.min(request.maxSteps ?? defaultMaximumSteps, maximumExecuteSteps),
    haltPc: request.haltPc,
    interruptSchedule: Object.freeze([...(request.interruptSchedule ?? [])]),
    runOutputFile: request.runOutputFile ? cloneUri(request.runOutputFile) : undefined,
    revealOutput: request.revealOutput,
    signal
  });
}

function builtinRequestFingerprint(request: ExecuteRequest): string {
  return JSON.stringify({
    profile: resolveRequestProfile(request) ?? null,
    image: request.image.fingerprint,
    stdin: request.stdin ?? null,
    trace: request.trace ?? null,
    maxSteps: request.maxSteps ?? null,
    haltPc: request.haltPc ?? null,
    interruptSchedule: request.interruptSchedule ?? null,
    requirements: request.requirements ?? null
  });
}

function resolveRequestProfile(request: ExecuteRequest): CourseProfile | undefined {
  const value = request.profile ?? request.requirements?.profile;
  return value && courseProfileIds.includes(value as CourseProfile)
    ? value as CourseProfile
    : undefined;
}

function builtinStop(
  status: 'committed' | 'halted' | 'out-of-domain' | 'step-limit',
  haltReason: string | undefined,
  haltPc: number | undefined,
  diagnostic: ExecutionDiagnostic | undefined
): NonNullable<ExecuteResult['stop']> {
  if (haltReason === 'cancelled') {
    return { kind: 'cancelled' };
  }
  switch (status) {
    case 'halted':
      return diagnostic?.code.endsWith('.step-limit')
        ? { kind: 'step-limit' }
        : { kind: 'halt-loop', haltPc };
    case 'out-of-domain':
      return { kind: 'out-of-domain' };
    default:
      return { kind: 'step-limit' };
  }
}

function builtinStatus(
  ok: boolean,
  stopKind: EngineStopKind,
  diagnostic: ExecutionDiagnostic | undefined,
  stdout = ''
): EngineRunStatus {
  const detail = diagnostic ? `[${diagnostic.code}] ${diagnostic.message}` : '';
  return {
    ok,
    exitCode: null,
    stdout,
    stderr: ok ? '' : detail,
    timedOut: false,
    stopped: stopKind !== 'halt-loop',
    stopReason: stopKind
  };
}

function parseRawTrace(text: string): CpuTraceEvent[] {
  return [...iterCpuTraceEvents(text)];
}

async function writeBuiltinRunOutput(
  uri: vscode.Uri | undefined,
  text: string,
  requestedTrace: boolean
): Promise<vscode.Uri | undefined> {
  if (!uri) return undefined;
  if (!requestedTrace) return undefined;
  await writeFileAtomic(uri.fsPath, Buffer.from(text, 'utf8'));
  return uri;
}

async function writeBuiltinEventArtifact(
  outputFile: vscode.Uri | undefined,
  value: unknown
): Promise<vscode.Uri | undefined> {
  if (!outputFile) return undefined;
  const eventArtifact = vscode.Uri.file(`${outputFile.fsPath}.events.json`);
  const bytes = Buffer.from(`${canonicalJson(value as CanonicalJson)}\n`, 'utf8');
  await writeFileAtomic(eventArtifact.fsPath, bytes);
  return eventArtifact;
}

const writeFileAtomic = writeFileAtomicReplace;

function cloneUri(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.parse(uri.toString(), true);
}
