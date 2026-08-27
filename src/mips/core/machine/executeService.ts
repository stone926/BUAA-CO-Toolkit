// @index mips-core — CLI/Worker 共用的执行与设备周期服务 DTO（固定字宽输出，无宿主依赖）
import { ProgramImage, ProgramSegment } from '../api';
import { CourseDeviceBus } from '../devices/deviceBus';
import { ExternalInterruptRequest } from '../devices/interruptController';
import { TimerRegisterIndex, timerRegisterIndex, TimerSnapshot } from '../devices/timer';
import { CommitEvent, ExecutionDiagnostic, HaltReason, StepStatus } from '../events/commitEvent';
import { CoverageBin, ExecutionCoverageCollector } from '../events/coverage';
import {
  ArchitecturalWriteRecord,
  formatArchitecturalWrite,
  projectCommitEvent
} from '../events/traceProjection';
import { CourseProfile, InstructionLayer } from '../generated/isaCatalog';
import { courseProfileIds, resolveCourseProfile } from '../profiles/courseProfiles';
import { hex8 } from '../values';
import { runCourseProgram } from './execution';
import { UnloadedInstructionPolicy } from './memoryBus';
import { buildProgramImage } from '../programImage';
import { CourseSystemSession, DeviceSchedule } from './system';
import { UndefinedBehaviorPolicy } from './transition';

/**
 * 与 `isa/service.ts` 同构的投影层：把执行核心暴露成稳定、固定字宽的 DTO，
 * 供版本化 JSONL CLI 与 Worker 复用。独立 conformance runner 只通过这层调用
 * 生产引擎，不 import 任何生产实现（计划第 7.1 节）。
 */

/** Course IM holds 4,096 words; the same ceiling bounds every submitted segment. */
export const maximumExecuteSegmentWords = 4096;
export const maximumExecuteSteps = 4096 * 64;
export const maximumExecuteTraceLines = 100_000;

/**
 * Executor semantics revision. It is deliberately separate from the ISA catalog
 * revision: execution evidence must not be invalidated by an assembler-only
 * change, and assembly evidence must not be invalidated by an executor-only
 * change (计划第 7.6/7.7 节 evidence fingerprint 分桶).
 */
export const executorSemanticsRevision = 1 as const;

export interface ExecuteSegmentInput {
  readonly name: string;
  readonly baseAddress: number;
  readonly words: readonly number[];
}

export interface ExecuteServiceRequest {
  readonly profile: CourseProfile;
  readonly enabledLayers?: readonly InstructionLayer[];
  readonly segments: readonly ExecuteSegmentInput[];
  readonly entryPc?: number;
  readonly maxSteps?: number;
  readonly haltPc?: number;
  readonly undefinedBehavior?: UndefinedBehaviorPolicy;
  readonly unloadedInstruction?: UnloadedInstructionPolicy;
  readonly externalInterrupts?: readonly ExternalInterruptRequest[];
  readonly deviceSchedule?: DeviceSchedule;
  readonly collectTrace?: boolean;
  readonly collectCoverage?: boolean;
  readonly checkpointInterval?: number;
}

export interface ExecuteServiceFinalState {
  readonly pc: string;
  readonly gpr: readonly string[];
  readonly hi: string;
  readonly lo: string;
  readonly hiDefined: boolean;
  readonly loDefined: boolean;
  readonly cp0?: { readonly status: string; readonly cause: string; readonly epc: string };
  readonly dataWords: readonly { readonly address: string; readonly value: string }[];
}

export interface ExecuteServiceResult {
  readonly status: string;
  readonly haltReason?: string;
  readonly instructions: number;
  readonly eventCount: number;
  readonly haltPc?: string;
  readonly finalStateDigest: string;
  readonly imageFingerprint: string;
  readonly finalState: ExecuteServiceFinalState;
  readonly diagnostic?: {
    readonly code: string;
    readonly message: string;
    readonly reason?: string;
    readonly pc?: string;
    readonly instructionWord?: string;
    readonly address?: string;
    readonly contractId?: string;
  };
  readonly trace?: readonly string[];
  readonly coverage?: readonly CoverageBin[];
  readonly checkpoints?: readonly { readonly instruction: number; readonly digest: string }[];
}

export interface PreparedCourseExecution {
  readonly session: CourseSystemSession;
  readonly image: ProgramImage;
}

/** Build the bounded session/image pair shared by the sync, worker and CLI boundaries. */
export function prepareCourseExecution(request: ExecuteServiceRequest): PreparedCourseExecution {
  const profile = resolveCourseProfile(request.profile);
  const segments: ProgramSegment[] = request.segments.map((segment) => {
    if (segment.words.length > maximumExecuteSegmentWords) {
      throw new Error(`segment "${segment.name}" 超过课程上限 ${maximumExecuteSegmentWords} 个字`);
    }
    return {
      name: segment.name,
      baseAddress: segment.baseAddress >>> 0,
      words: segment.words.map((word) => word >>> 0)
    };
  });
  const image = buildProgramImage({
    ...(request.entryPc === undefined ? {} : { entryPc: request.entryPc }),
    segments,
    inputGraph: [{ id: 'execute-service', contentHash: '0'.repeat(64) }]
  });
  const maxSteps = Math.min(request.maxSteps ?? 65_536, maximumExecuteSteps);
  const session = new CourseSystemSession({
    profile,
    image,
    maxSteps,
    ...(request.enabledLayers ? { layers: request.enabledLayers } : {}),
    ...(request.haltPc === undefined ? {} : { haltPc: request.haltPc }),
    ...(request.undefinedBehavior ? { undefinedBehavior: request.undefinedBehavior } : {}),
    ...(request.unloadedInstruction ? { unloadedInstruction: request.unloadedInstruction } : {}),
    ...(request.externalInterrupts ? { externalInterrupts: request.externalInterrupts } : {}),
    ...(request.deviceSchedule ? { deviceSchedule: request.deviceSchedule } : {})
  });
  return { session, image };
}

/** Project one `runCourseProgram` outcome to the fixed-width service DTO. */
export function projectCourseExecutionOutcome(
  prepared: PreparedCourseExecution,
  outcome: ReturnType<typeof runCourseProgram>
): ExecuteServiceResult {
  const snapshot = outcome.finalSnapshot;
  const trace = outcome.trace?.slice(0, maximumExecuteTraceLines)
    .map((record) => formatArchitecturalWrite(record));

  return {
    status: outcome.status,
    ...(outcome.haltReason ? { haltReason: outcome.haltReason } : {}),
    instructions: outcome.instructions,
    eventCount: outcome.eventCount,
    ...(outcome.haltPc === undefined ? {} : { haltPc: word(outcome.haltPc) }),
    finalStateDigest: outcome.finalStateDigest,
    imageFingerprint: prepared.image.fingerprint,
    finalState: {
      pc: word(snapshot.pc),
      gpr: snapshot.gpr.map(word),
      hi: word(snapshot.hi),
      lo: word(snapshot.lo),
      hiDefined: snapshot.hiDefined,
      loDefined: snapshot.loDefined,
      ...(snapshot.cp0
        ? {
          cp0: {
            status: word(snapshot.cp0.status),
            cause: word(snapshot.cp0.cause),
            epc: word(snapshot.cp0.epc)
          }
        }
        : {}),
      dataWords: (snapshot.dataWords ?? []).map((entry) => ({
        address: word(entry.address),
        value: word(entry.value)
      }))
    },
    ...(outcome.diagnostic
      ? {
        diagnostic: {
          code: outcome.diagnostic.code,
          message: outcome.diagnostic.message,
          ...(outcome.diagnostic.reason ? { reason: outcome.diagnostic.reason } : {}),
          ...(outcome.diagnostic.pc === undefined ? {} : { pc: word(outcome.diagnostic.pc) }),
          ...(outcome.diagnostic.instructionWord === undefined
            ? {}
            : { instructionWord: word(outcome.diagnostic.instructionWord) }),
          ...(outcome.diagnostic.address === undefined
            ? {}
            : { address: word(outcome.diagnostic.address) }),
          ...(outcome.diagnostic.contractId ? { contractId: outcome.diagnostic.contractId } : {})
        }
      }
      : {}),
    ...(trace ? { trace } : {}),
    ...(outcome.coverage ? { coverage: outcome.coverage } : {}),
    ...(outcome.checkpoints.length ? { checkpoints: outcome.checkpoints } : {})
  };
}

/** Execute one ProgramImage built from raw segments and project the result. */
export function executeProgramForService(request: ExecuteServiceRequest): ExecuteServiceResult {
  const prepared = prepareCourseExecution(request);
  const outcome = runCourseProgram(prepared.session, {
    ...(request.collectTrace ? { collectTrace: true } : {}),
    ...(request.collectCoverage ? { collectCoverage: true } : {}),
    ...(request.checkpointInterval === undefined
      ? {}
      : { checkpointInterval: request.checkpointInterval }),
    finalSnapshotLevel: 'full'
  });
  return projectCourseExecutionOutcome(prepared, outcome);
}

export interface ExecuteServiceAsyncHooks {
  /** Cooperative cancellation checked before every slice. */
  readonly aborted?: () => boolean;
  /** Called after each slice; worker implementations await progress ACK here. */
  readonly onSlice?: (events: readonly CommitEvent[]) => void | Promise<void>;
  /** Keep the full stream in the returned result as well; workers stream instead. */
  readonly retainEvents?: boolean;
}

export interface ExecuteServiceAsyncResult extends ExecuteServiceResult {
  /** Full canonical commit stream; present because the worker streams it back. */
  readonly events: readonly CommitEvent[];
}

/**
 * Worker-only async driver. It runs the same bounded session/image and projects
 * the same DTO as `executeProgramForService`, but yields to the worker message
 * loop between slices and forwards each slice's CommitEvents for backpressure.
 */
export async function executeProgramForServiceAsync(
  request: ExecuteServiceRequest,
  hooks: ExecuteServiceAsyncHooks = {}
): Promise<ExecuteServiceAsyncResult> {
  const prepared = prepareCourseExecution(request);
  const session = prepared.session;
  const coverage = request.collectCoverage
    ? new ExecutionCoverageCollector(session.profile)
    : undefined;
  const trace: ArchitecturalWriteRecord[] | undefined = request.collectTrace ? [] : undefined;
  const events: CommitEvent[] = [];
  const checkpoints: { instruction: number; digest: string }[] = [];
  const sliceSize = 128;
  let outcomeStatus: StepStatus = 'committed';
  let outcomeHaltReason: HaltReason | undefined;
  let outcomeDiagnostic: ExecutionDiagnostic | undefined;
  let eventCount = 0;

  for (;;) {
    if (hooks.aborted?.()) {
      outcomeStatus = 'halted';
      outcomeHaltReason = 'cancelled';
      break;
    }
    const slice: CommitEvent[] = [];
    let sliceStatus: StepStatus = 'committed';
    for (let index = 0; index < sliceSize; index++) {
      const result = session.stepInstruction();
      if (result.event) {
        eventCount++;
        slice.push(result.event);
        coverage?.observe(result.event);
        if (trace) trace.push(...projectCommitEvent(result.event, session.profile));
      }
      if (request.checkpointInterval !== undefined
        && request.checkpointInterval > 0
        && session.instructionsExecuted > 0
        && session.instructionsExecuted % request.checkpointInterval === 0
        && result.status === 'committed') {
        checkpoints.push({
          instruction: session.instructionsExecuted,
          digest: session.snapshot('registers').digest
        });
      }
      if (result.status !== 'committed') {
        sliceStatus = result.status;
        outcomeHaltReason = result.event?.haltReason ?? outcomeHaltReason;
        outcomeDiagnostic = result.diagnostic ?? outcomeDiagnostic;
        break;
      }
    }
    if (slice.length) {
      if (hooks.retainEvents !== false) events.push(...slice);
      await hooks.onSlice?.(slice);
    }
    if (sliceStatus !== 'committed') {
      outcomeStatus = sliceStatus;
      break;
    }
  }

  const finalSnapshot = session.snapshot('full');
  const projected = projectCourseExecutionOutcome(prepared, {
    status: outcomeStatus,
    ...(outcomeHaltReason ? { haltReason: outcomeHaltReason } : {}),
    ...(outcomeDiagnostic ? { diagnostic: outcomeDiagnostic } : {}),
    instructions: session.instructionsExecuted,
    ...(session.courseHaltPc === undefined ? {} : { haltPc: session.courseHaltPc }),
    finalSnapshot,
    finalStateDigest: finalSnapshot.digest,
    checkpoints,
    ...(trace ? { trace } : {}),
    ...(coverage ? { coverage: coverage.bins() } : {}),
    retainedEvents: [],
    eventCount
  });
  return { ...projected, events };
}

// ── Device cycle vectors ─────────────────────────────────────────────────────

export type DeviceVectorTimer = 'timer0' | 'timer1';
export type DeviceVectorRegister = 'ctrl' | 'preset' | 'count';

export type DeviceVectorStep =
  | { readonly kind: 'reset' }
  | { readonly kind: 'tick'; readonly cycles?: number }
  | {
    readonly kind: 'write';
    readonly device: DeviceVectorTimer;
    readonly register: DeviceVectorRegister;
    readonly value: number;
  }
  | {
    readonly kind: 'read';
    readonly device: DeviceVectorTimer;
    readonly register: DeviceVectorRegister;
  }
  | { readonly kind: 'ack-external' };

export interface DeviceVectorObservation {
  readonly step: number;
  readonly kind: string;
  readonly timer0: DeviceTimerObservation;
  readonly timer1: DeviceTimerObservation;
  readonly hardwareInterrupts: string;
  readonly externalInterrupt: boolean;
  /** Present for `read` steps only. */
  readonly readValue?: string;
  readonly events: readonly string[];
  /** Present when the step was rejected before touching the device. */
  readonly fault?: string;
}

export interface DeviceTimerObservation {
  readonly state: string;
  readonly ctrl: string;
  readonly preset: string;
  readonly count: string;
  readonly pendingIrq: boolean;
  readonly irq: boolean;
}

export const maximumDeviceVectorSteps = 100_000;
export const maximumDeviceVectorCycles = 1_000_000;

/**
 * Run a directed device cycle vector against the official Timer contract. This is
 * the only interface a conformance device lane needs: every step is explicit, so
 * no instruction/cycle mapping is ever implied.
 */
export function runDeviceCycleVectorForService(
  steps: readonly DeviceVectorStep[]
): readonly DeviceVectorObservation[] {
  if (steps.length > maximumDeviceVectorSteps) {
    throw new Error(`device vector 超过上限 ${maximumDeviceVectorSteps} 步`);
  }
  const policy = resolveCourseProfile('P7').exceptions;
  if (!policy) {
    throw new Error('P7 profile 缺少异常策略，无法构造设备总线');
  }
  const bus = new CourseDeviceBus(policy, { timersEnabled: true });
  const observations: DeviceVectorObservation[] = [];
  let totalCycles = 0;

  for (const [index, step] of steps.entries()) {
    const events: string[] = [];
    let readValue: number | undefined;
    let fault: string | undefined;

    switch (step.kind) {
      case 'reset':
        bus.tickCycle({ reset: true });
        break;
      case 'tick': {
        const cycles = step.cycles ?? 1;
        totalCycles += cycles;
        if (totalCycles > maximumDeviceVectorCycles) {
          throw new Error(`device vector 超过上限 ${maximumDeviceVectorCycles} 个周期`);
        }
        const result = bus.tickCycle({ cycles });
        events.push(...result.events.map(describeEvent));
        break;
      }
      case 'write': {
        const prepared = bus.prepare({
          kind: 'store',
          device: step.device,
          address: timerAddress(step.device, step.register),
          width: 4,
          value: step.value >>> 0
        });
        if ('fault' in prepared) {
          fault = prepared.fault;
          break;
        }
        events.push(...bus.commit(prepared).map(describeEvent));
        break;
      }
      case 'read': {
        const prepared = bus.prepare({
          kind: 'load',
          device: step.device,
          address: timerAddress(step.device, step.register),
          width: 4
        });
        if ('fault' in prepared) {
          fault = prepared.fault;
          break;
        }
        readValue = bus.read(prepared);
        break;
      }
      default:
        events.push(...bus.interruptGenerator.acknowledge(0x0000_7f20).map(describeEvent));
        break;
    }

    const snapshot = bus.snapshot();
    observations.push({
      step: index,
      kind: step.kind,
      timer0: timerObservation(snapshot.timer0),
      timer1: timerObservation(snapshot.timer1),
      hardwareInterrupts: word(snapshot.hardwareInterrupts),
      externalInterrupt: snapshot.externalInterrupt,
      ...(readValue === undefined ? {} : { readValue: word(readValue) }),
      events,
      ...(fault ? { fault } : {})
    });
  }
  return observations;
}

function timerObservation(snapshot: TimerSnapshot): DeviceTimerObservation {
  return {
    state: snapshot.state,
    ctrl: word(snapshot.ctrl),
    preset: word(snapshot.preset),
    count: word(snapshot.count),
    pendingIrq: snapshot.pendingIrq,
    irq: snapshot.irq
  };
}

function timerAddress(device: DeviceVectorTimer, register: DeviceVectorRegister): number {
  const base = device === 'timer0' ? 0x0000_7f00 : 0x0000_7f10;
  return (base + registerIndex(register) * 4) >>> 0;
}

function registerIndex(register: DeviceVectorRegister): TimerRegisterIndex {
  switch (register) {
    case 'ctrl':
      return timerRegisterIndex.ctrl;
    case 'preset':
      return timerRegisterIndex.preset;
    default:
      return timerRegisterIndex.count;
  }
}

function describeEvent(event: { kind: string; device: string; detail?: string }): string {
  return event.detail ? `${event.device}:${event.kind}(${event.detail})` : `${event.device}:${event.kind}`;
}

function word(value: number): string {
  return `0x${hex8(value)}`;
}

// ── Untrusted request parsing ────────────────────────────────────────────────

/**
 * Thrown for a malformed request. The CLI maps it to its stable `invalid-request`
 * code and the Worker to a job error; the parser itself stays host-free so both
 * boundaries validate one DTO shape instead of two.
 */
export class ExecuteRequestError extends Error {}

const courseProfileSet = new Set<string>(courseProfileIds);
const instructionLayerSet = new Set<string>(['required', 'commonExtensions', 'marsCompatibility']);
const undefinedBehaviorPolicies = new Set<string>(['fail-closed', 'deterministic']);
const unloadedInstructionPolicies = new Set<string>(['fail-closed', 'synthetic-zero']);
const deviceVectorTimers = new Set<string>(['timer0', 'timer1']);
const deviceVectorRegisters = new Set<string>(['ctrl', 'preset', 'count']);
const maximumExecuteSegments = 16;
const maximumExternalInterrupts = 256;
const maximumTimelineEntries = 100_000;

const executeRequestKeys = [
  'profile', 'enabledLayers', 'segments', 'entryPc', 'maxSteps', 'haltPc',
  'undefinedBehavior', 'unloadedInstruction', 'externalInterrupts', 'deviceSchedule',
  'collectTrace', 'collectCoverage', 'checkpointInterval'
] as const;

/** Fields a transport envelope may carry in addition to the execute request itself. */
export const executeServiceRequestFields: readonly string[] = executeRequestKeys;

/** Validate an untrusted object into an `ExecuteServiceRequest`. */
export function parseExecuteServiceRequest(value: unknown): ExecuteServiceRequest {
  const request = requireRecord(value, 'request');
  if (typeof request.profile !== 'string' || !courseProfileSet.has(request.profile)) {
    throw new ExecuteRequestError(`profile is invalid: ${String(request.profile)}`);
  }
  return {
    profile: request.profile as CourseProfile,
    segments: parseSegments(request.segments),
    ...(request.enabledLayers === undefined
      ? {}
      : { enabledLayers: parseLayers(request.enabledLayers) }),
    ...(request.entryPc === undefined
      ? {}
      : { entryPc: parseAddress(request.entryPc, 'entryPc') }),
    ...(request.maxSteps === undefined
      ? {}
      : { maxSteps: parseBoundedInteger(request.maxSteps, 'maxSteps', 1, maximumExecuteSteps) }),
    ...(request.haltPc === undefined ? {} : { haltPc: parseAddress(request.haltPc, 'haltPc') }),
    ...(request.undefinedBehavior === undefined
      ? {}
      : {
        undefinedBehavior: parseEnum(
          request.undefinedBehavior, undefinedBehaviorPolicies, 'undefinedBehavior'
        ) as UndefinedBehaviorPolicy
      }),
    ...(request.unloadedInstruction === undefined
      ? {}
      : {
        unloadedInstruction: parseEnum(
          request.unloadedInstruction, unloadedInstructionPolicies, 'unloadedInstruction'
        ) as UnloadedInstructionPolicy
      }),
    ...(request.externalInterrupts === undefined
      ? {}
      : { externalInterrupts: parseExternalInterrupts(request.externalInterrupts) }),
    ...(request.deviceSchedule === undefined
      ? {}
      : { deviceSchedule: parseDeviceSchedule(request.deviceSchedule) }),
    ...(request.collectTrace === undefined
      ? {}
      : { collectTrace: parseBoolean(request.collectTrace, 'collectTrace') }),
    ...(request.collectCoverage === undefined
      ? {}
      : { collectCoverage: parseBoolean(request.collectCoverage, 'collectCoverage') }),
    ...(request.checkpointInterval === undefined
      ? {}
      : {
        checkpointInterval: parseBoundedInteger(
          request.checkpointInterval, 'checkpointInterval', 0, maximumExecuteSteps
        )
      })
  };
}

/** Validate an untrusted array into a device cycle vector. */
export function parseDeviceVectorSteps(value: unknown): DeviceVectorStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumDeviceVectorSteps) {
    throw new ExecuteRequestError(`steps must contain 1..${maximumDeviceVectorSteps} entries`);
  }
  return value.map((entry, index) => {
    const label = `steps[${index}]`;
    const step = requireRecord(entry, label);
    switch (step.kind) {
      case 'reset':
      case 'ack-external':
        requireOnlyKeys(step, ['kind'], label);
        return { kind: step.kind } as DeviceVectorStep;
      case 'tick':
        requireOnlyKeys(step, ['kind', 'cycles'], label);
        return {
          kind: 'tick',
          ...(step.cycles === undefined
            ? {}
            : { cycles: parseBoundedInteger(step.cycles, `${label}.cycles`, 0, 1_000_000) })
        };
      case 'write':
        requireOnlyKeys(step, ['kind', 'device', 'register', 'value'], label);
        return {
          kind: 'write',
          device: parseEnum(step.device, deviceVectorTimers, `${label}.device`) as DeviceVectorTimer,
          register: parseEnum(
            step.register, deviceVectorRegisters, `${label}.register`
          ) as DeviceVectorRegister,
          value: parseWord(step.value, `${label}.value`)
        };
      case 'read':
        requireOnlyKeys(step, ['kind', 'device', 'register'], label);
        return {
          kind: 'read',
          device: parseEnum(step.device, deviceVectorTimers, `${label}.device`) as DeviceVectorTimer,
          register: parseEnum(
            step.register, deviceVectorRegisters, `${label}.register`
          ) as DeviceVectorRegister
        };
      default:
        throw new ExecuteRequestError(`${label}.kind is invalid: ${String(step.kind)}`);
    }
  });
}

function parseSegments(value: unknown): ExecuteSegmentInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumExecuteSegments) {
    throw new ExecuteRequestError(`segments must contain 1..${maximumExecuteSegments} entries`);
  }
  return value.map((entry, index) => {
    const label = `segments[${index}]`;
    const segment = requireRecord(entry, label);
    requireOnlyKeys(segment, ['name', 'baseAddress', 'words'], label);
    if (typeof segment.name !== 'string' || !segment.name.trim()) {
      throw new ExecuteRequestError(`${label}.name must be a non-empty string`);
    }
    const words = segment.words;
    if (!Array.isArray(words) || words.length === 0 || words.length > maximumExecuteSegmentWords) {
      throw new ExecuteRequestError(
        `${label}.words must contain 1..${maximumExecuteSegmentWords} entries`
      );
    }
    return {
      name: segment.name,
      baseAddress: parseAddress(segment.baseAddress, `${label}.baseAddress`),
      words: words.map((item, wordIndex) => parseWord(item, `${label}.words[${wordIndex}]`))
    };
  });
}

function parseExternalInterrupts(value: unknown): ExternalInterruptRequest[] {
  if (!Array.isArray(value) || value.length > maximumExternalInterrupts) {
    throw new ExecuteRequestError(
      `externalInterrupts must contain at most ${maximumExternalInterrupts} entries`
    );
  }
  return value.map((entry, index) => {
    const label = `externalInterrupts[${index}]`;
    const item = requireRecord(entry, label);
    requireOnlyKeys(item, ['victimPc', 'occurrence'], label);
    return {
      victimPc: parseAddress(item.victimPc, `${label}.victimPc`),
      occurrence: parseBoundedInteger(item.occurrence, `${label}.occurrence`, 1, 1_000_000)
    };
  });
}

function parseDeviceSchedule(value: unknown): DeviceSchedule {
  const schedule = requireRecord(value, 'deviceSchedule');
  if (schedule.kind === 'disabled') {
    requireOnlyKeys(schedule, ['kind'], 'deviceSchedule');
    return { kind: 'disabled' };
  }
  if (schedule.kind !== 'timeline') {
    throw new ExecuteRequestError('deviceSchedule.kind must be "disabled" or "timeline"');
  }
  requireOnlyKeys(schedule, ['kind', 'entries'], 'deviceSchedule');
  const entries = schedule.entries;
  if (!Array.isArray(entries) || entries.length > maximumTimelineEntries) {
    throw new ExecuteRequestError(
      `deviceSchedule.entries must contain at most ${maximumTimelineEntries} entries`
    );
  }
  return {
    kind: 'timeline',
    entries: entries.map((entry, index) => {
      const label = `deviceSchedule.entries[${index}]`;
      const item = requireRecord(entry, label);
      requireOnlyKeys(item, ['afterInstruction', 'cycles'], label);
      return {
        afterInstruction: parseBoundedInteger(
          item.afterInstruction, `${label}.afterInstruction`, 0, maximumExecuteSteps
        ),
        cycles: parseBoundedInteger(item.cycles, `${label}.cycles`, 0, 1_000_000)
      };
    })
  };
}

function parseLayers(value: unknown): InstructionLayer[] {
  if (!Array.isArray(value)
    || value.length === 0
    || value.some((layer) => typeof layer !== 'string' || !instructionLayerSet.has(layer))
    || new Set(value).size !== value.length) {
    throw new ExecuteRequestError(
      'enabledLayers must be a non-empty unique list of known layers'
    );
  }
  return value as InstructionLayer[];
}

function parseWord(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{8}$/.test(value)) {
    throw new ExecuteRequestError(`${label} must be 0x followed by exactly 8 hex digits`);
  }
  return Number.parseInt(value.slice(2), 16) >>> 0;
}

function parseAddress(value: unknown, label: string): number {
  const address = parseWord(value, label);
  if ((address & 3) !== 0) {
    throw new ExecuteRequestError(`${label} must be word-aligned`);
  }
  return address;
}

function parseBoundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ExecuteRequestError(`${label} must be an integer in [${min}, ${max}]`);
  }
  return value as number;
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ExecuteRequestError(`${label} must be a boolean`);
  }
  return value;
}

function parseEnum(value: unknown, allowed: ReadonlySet<string>, label: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new ExecuteRequestError(`${label} is invalid: ${String(value)}`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExecuteRequestError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) {
    throw new ExecuteRequestError(`${label} has unknown fields: ${unknown.join(', ')}`);
  }
}
