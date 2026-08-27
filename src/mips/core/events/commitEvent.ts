// @index mips-core — canonical CommitEvent 事件模型、可观测性掩码与执行诊断
import { CourseExceptionName, ExceptionStage, RegionId } from '../profiles/profile';

/**
 * Canonical `CommitEvent`（计划第 5.4 节）。执行核心直接产生结构化事件，文本
 * `coL1/coL2` 只是 legacy 适配层。
 *
 * 每条写记录都带 `defined` 标记：`false` 表示该值是架构未定义的（例如 HI/LO
 * 未初始化时的 `mfhi`），它可以确定性地出现在诊断里，但不得进入严格比较或
 * final digest。时间戳属于 DUT observation，不属于 oracle 架构状态，因此这里
 * 没有 cycle 字段。
 */

export interface RegisterWrite {
  /** GPR index 1..31; `$0` writes are never recorded. */
  readonly register: number;
  readonly value: number;
  /** `false` when the written value is architecturally undefined. */
  readonly defined?: boolean;
}

export interface HiLoWrite {
  readonly register: 'hi' | 'lo';
  readonly value: number;
  readonly defined?: boolean;
}

export interface Cp0Write {
  /** CP0 register number (12 = SR, 13 = Cause, 14 = EPC). */
  readonly register: number;
  readonly value: number;
  /** Value before the write, so a projector can render transitions. */
  readonly valueBefore: number;
}

export interface MemoryWrite {
  /** Raw effective address computed by the instruction (unaligned for `sb/sh`). */
  readonly address: number;
  /** Raw source value before byte-lane selection. */
  readonly rawValue: number;
  /** Aligned word address actually updated; what the course DM module logs. */
  readonly wordAddress: number;
  /** Byte enables inside the word: bit `i` covers byte lane `i` (little endian). */
  readonly byteMask: number;
  readonly valueBefore: number;
  /** Merged word after the byte lanes were applied; what the course DM module logs. */
  readonly valueAfter: number;
  readonly region: RegionId;
}

/**
 * One data read. The course DUT never logs loads, but first-diff diagnostics and
 * byte-lane coverage need to know which word the load actually observed.
 */
export interface MemoryRead {
  readonly address: number;
  readonly wordAddress: number;
  readonly width: number;
  /** Aligned word behind the access. */
  readonly wordValue: number;
  /** Value delivered to the destination register after sign/zero extension. */
  readonly value: number;
  readonly region: RegionId;
}

export type DeviceEventKind =
  | 'timer-register-write'
  | 'timer-register-read'
  | 'timer-irq-asserted'
  | 'timer-irq-cleared'
  | 'timer-state-transition'
  | 'timer-mode-undefined'
  | 'interrupt-generator-ack'
  | 'external-interrupt-asserted';

export interface DeviceEvent {
  readonly kind: DeviceEventKind;
  readonly device: RegionId;
  readonly address?: number;
  readonly value?: number;
  /** Device cycle index when the event belongs to the cycle domain. */
  readonly cycle?: number;
  readonly detail?: string;
}

/** Exception or interrupt accepted at one commit point. */
export interface TrapRecord {
  readonly kind: 'exception' | 'interrupt';
  readonly name: CourseExceptionName;
  /** Value written into `Cause.ExcCode`. */
  readonly code: number;
  /** Macroscopic PC of the victim instruction. */
  readonly victimPc: number;
  /** `true` when the victim sits in a branch/jump delay slot. */
  readonly branchDelay: boolean;
  /** Value written into EPC (`victimPc - 4` for a delay-slot victim). */
  readonly epc: number;
  /** Detection stage of an exception; interrupts arbitrate at the commit point. */
  readonly stage?: ExceptionStage;
  readonly handlerPc: number;
  /** HWInt bits sampled when an interrupt was accepted. */
  readonly hardwareInterrupts?: number;
}

export type HaltReason =
  | 'course-halt-loop'
  | 'step-limit'
  | 'out-of-domain'
  | 'cancelled'
  | 'engine-error';

export type CommitEventKind = 'instruction' | 'exception' | 'interrupt' | 'halt';

export interface CommitEvent {
  readonly sequence: number;
  readonly kind: CommitEventKind;
  readonly pcBefore: number;
  readonly instructionWord?: number;
  readonly pcAfter: number;
  /** `true` when this instruction executed in a control-transfer delay slot. */
  readonly delaySlot?: boolean;
  /** PC of the branch/jump that owns this delay slot. */
  readonly branchOriginPc?: number;
  readonly gprWrites: readonly RegisterWrite[];
  readonly hiLoWrites: readonly HiLoWrite[];
  readonly cp0Writes: readonly Cp0Write[];
  readonly memoryWrites: readonly MemoryWrite[];
  readonly memoryReads?: readonly MemoryRead[];
  readonly deviceEvents: readonly DeviceEvent[];
  /** Present on control-transfer instructions; `false` records a not-taken branch. */
  readonly branchTaken?: boolean;
  /** Address the control transfer resolved to, including a not-taken fall-through. */
  readonly controlTarget?: number;
  readonly trap?: TrapRecord;
  readonly haltReason?: HaltReason;
  /** Resolved mnemonic; diagnostics only, never part of the digest. */
  readonly mnemonic?: string;
}

/**
 * Why the run left the profile's comparable domain (COURSE-P56-DOMAIN-001,
 * COURSE-P7-UNLOADED-IM-001). These are not architectural exceptions: a strict
 * lane must fail closed rather than invent a result.
 */
export type OutOfDomainReason =
  | 'unloaded-instruction'
  | 'unrecognized-instruction'
  | 'unsupported-instruction'
  | 'address-out-of-region'
  | 'misaligned-access'
  | 'undefined-hi-lo-read'
  | 'divide-by-zero'
  | 'jalr-same-register'
  | 'double-delay-slot'
  | 'timer-mode-undefined'
  | 'device-schedule-missing';

/** Stable-code execution diagnostic; hosts map it to their own UI/report shape. */
export interface ExecutionDiagnostic {
  /** Stable diagnostic code, e.g. `mips-core.exec.unloaded-instruction`. */
  readonly code: string;
  readonly message: string;
  readonly pc?: number;
  readonly instructionWord?: number;
  readonly address?: number;
  readonly reason?: OutOfDomainReason;
  /** Course contract id this diagnostic enforces, when one exists. */
  readonly contractId?: string;
}

export type StepStatus =
  | 'committed'
  | 'halted'
  | 'out-of-domain'
  | 'step-limit';

export interface StepResult {
  readonly status: StepStatus;
  readonly event?: CommitEvent;
  readonly diagnostic?: ExecutionDiagnostic;
}

export interface RunSliceResult {
  readonly status: StepStatus;
  readonly events: readonly CommitEvent[];
  readonly diagnostic?: ExecutionDiagnostic;
  /** Instructions committed in this slice. */
  readonly committed: number;
}

/** Event-schema revision embedded in every execution evidence fingerprint. */
export const commitEventSchemaRevision = 1 as const;

/** Stable diagnostic code prefix owned by the execution core. */
export const executionDiagnosticPrefix = 'mips-core.exec';

export function executionDiagnostic(
  reason: OutOfDomainReason,
  message: string,
  detail: {
    readonly pc?: number;
    readonly instructionWord?: number;
    readonly address?: number;
    readonly contractId?: string;
  } = {}
): ExecutionDiagnostic {
  return {
    code: `${executionDiagnosticPrefix}.${reason}`,
    message,
    reason,
    ...(detail.pc === undefined ? {} : { pc: detail.pc }),
    ...(detail.instructionWord === undefined ? {} : { instructionWord: detail.instructionWord }),
    ...(detail.address === undefined ? {} : { address: detail.address }),
    ...(detail.contractId === undefined ? {} : { contractId: detail.contractId })
  };
}
