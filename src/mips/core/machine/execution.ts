// @index mips-core — 有界执行驱动：slice/yield、取消、checkpoint、trace 与覆盖率收集
import {
  CommitEvent,
  ExecutionDiagnostic,
  HaltReason,
  StepStatus
} from '../events/commitEvent';
import { CoverageBin, ExecutionCoverageCollector } from '../events/coverage';
import {
  ArchitecturalWriteRecord,
  projectCommitEvent
} from '../events/traceProjection';
import { CourseExecutionProfile } from '../profiles/profile';
import { MachineSnapshot, SnapshotLevel } from './session';
import { CourseSystemSession } from './system';

/**
 * 驱动一次完整课程运行。事件默认流式消费：host 内存不保存与总事件数等长的
 * 完整数组（计划第 8.1 节），`retainEvents` 只保留一个有界窗口用于报告。
 *
 * Worker 每个 slice 之后 yield 一次，检查取消；`cancellation` 用结构化的
 * `{ aborted }` 而不是宿主的 `AbortSignal`，保持 core 不依赖任何运行时环境。
 */

export interface ExecutionCancellation {
  readonly aborted: boolean;
}

export interface ExecutionCheckpoint {
  readonly instruction: number;
  readonly digest: string;
}

export interface ExecutionRunOptions {
  /** Instructions per slice before the driver yields to the caller's cancel check. */
  readonly sliceSize?: number;
  readonly cancellation?: ExecutionCancellation;
  /** Streaming consumer; receives each slice's events in order. */
  readonly onEvents?: (events: readonly CommitEvent[]) => void;
  /** Collect the projected course architectural write trace. */
  readonly collectTrace?: boolean;
  readonly collectCoverage?: boolean;
  /** Bounded retention window for reports; defaults to 0 (stream only). */
  readonly retainEvents?: number;
  /** Snapshot digest every N committed instructions; 0 disables checkpoints. */
  readonly checkpointInterval?: number;
  readonly finalSnapshotLevel?: SnapshotLevel;
}

export interface ExecutionOutcome {
  readonly status: StepStatus;
  readonly haltReason?: HaltReason;
  readonly diagnostic?: ExecutionDiagnostic;
  readonly instructions: number;
  /** PC of the validated course halt-loop self-branch, not of its delay-slot `nop`. */
  readonly haltPc?: number;
  readonly finalSnapshot: MachineSnapshot;
  readonly finalStateDigest: string;
  readonly checkpoints: readonly ExecutionCheckpoint[];
  readonly trace?: readonly ArchitecturalWriteRecord[];
  readonly coverage?: readonly CoverageBin[];
  /** Bounded tail of the event stream, oldest first. */
  readonly retainedEvents: readonly CommitEvent[];
  readonly eventCount: number;
}

const defaultSliceSize = 256;

export function runCourseProgram(
  session: CourseSystemSession,
  options: ExecutionRunOptions = {}
): ExecutionOutcome {
  const profile: CourseExecutionProfile = session.profile;
  const sliceSize = options.sliceSize ?? defaultSliceSize;
  if (!Number.isSafeInteger(sliceSize) || sliceSize <= 0) {
    throw new Error(`sliceSize must be a positive safe integer, got ${sliceSize}`);
  }
  const retainLimit = options.retainEvents ?? 0;
  const checkpointInterval = options.checkpointInterval ?? 0;
  const coverage = options.collectCoverage ? new ExecutionCoverageCollector(profile) : undefined;
  const trace: ArchitecturalWriteRecord[] | undefined = options.collectTrace ? [] : undefined;
  const retained: CommitEvent[] = [];
  const checkpoints: ExecutionCheckpoint[] = [];

  let status: StepStatus = 'committed';
  let haltReason: HaltReason | undefined;
  let diagnostic: ExecutionDiagnostic | undefined;
  let eventCount = 0;

  for (;;) {
    if (options.cancellation?.aborted) {
      status = 'halted';
      haltReason = 'cancelled';
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
        if (trace) {
          trace.push(...projectCommitEvent(result.event, profile));
        }
        if (retainLimit > 0) {
          retained.push(result.event);
          if (retained.length > retainLimit) {
            retained.shift();
          }
        }
      }
      if (checkpointInterval > 0
        && session.instructionsExecuted > 0
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
    if (slice.length) {
      options.onEvents?.(slice);
    }
    if (sliceStatus !== 'committed') {
      status = sliceStatus;
      break;
    }
  }

  const finalSnapshot = session.snapshot(options.finalSnapshotLevel ?? 'full');
  const haltPc = session.courseHaltPc;
  return {
    status,
    ...(haltReason ? { haltReason } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    instructions: session.instructionsExecuted,
    ...(haltPc === undefined ? {} : { haltPc }),
    finalSnapshot,
    finalStateDigest: finalSnapshot.digest,
    checkpoints,
    ...(trace ? { trace } : {}),
    ...(coverage ? { coverage: coverage.bins() } : {}),
    retainedEvents: retained,
    eventCount
  };
}
