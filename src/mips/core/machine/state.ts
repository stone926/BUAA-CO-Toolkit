// @index mips-core — 架构状态：GPR/PC/HI/LO/CP0 与延迟槽记账（纯实例，无全局状态）
import {
  CourseExecutionProfile,
  Cp0Policy,
  cp0RegisterNumbers,
  CourseExceptionName,
  courseExceptionCodes
} from '../profiles/profile';
import { u32 } from '../values';

/**
 * 一次执行会话的完整架构状态。所有字段都是实例成员：核心不保留任何全局
 * singleton，`MachineSession` 可以并发存在于同一进程（计划第 11 节风险表）。
 *
 * 延迟槽用 `pendingBranch` 记账而不是"预取下一条"：这样 delay-slot 受害指令的
 * `Cause.BD` 与 `EPC = victimPc - 4` 可以在提交点直接读出，而不必回溯 PC 历史。
 */

export interface PendingBranch {
  /** Address the delay slot transfers to once it commits. */
  readonly targetPc: number;
  /** PC of the branch/jump that owns the delay slot. */
  readonly originPc: number;
}

export interface Cp0Snapshot {
  readonly status: number;
  readonly cause: number;
  readonly epc: number;
}

/** 32-entry general purpose register file; `$0` is hard-wired to zero. */
export class RegisterFile {
  private readonly values = new Uint32Array(32);

  constructor(reset: readonly number[]) {
    for (let index = 1; index < 32; index++) {
      this.values[index] = u32(reset[index] ?? 0);
    }
  }

  read(index: number): number {
    return index === 0 ? 0 : this.values[index & 0x1f];
  }

  /** Writes to `$0` are discarded; the course GRF module never logs them either. */
  write(index: number, value: number): void {
    if (index !== 0) {
      this.values[index & 0x1f] = u32(value);
    }
  }

  toArray(): number[] {
    return Array.from(this.values, (value) => u32(value));
  }
}

/**
 * Course CP0 (SR/Cause/EPC). Unimplemented bits always read zero and `mtc0` can
 * only change the bits the profile declares writable (P7-2-6 CP0 约束).
 */
export class Cp0Registers {
  private statusValue: number;
  private causeValue: number;
  private epcValue: number;

  constructor(private readonly policy: Cp0Policy, snapshot: Cp0Snapshot) {
    this.statusValue = u32(snapshot.status) & policy.statusWritableMask;
    this.causeValue = u32(snapshot.cause) & this.causeImplementedMask();
    this.epcValue = u32(snapshot.epc);
  }

  private causeImplementedMask(): number {
    return u32(this.policy.causeBranchDelayBit
      | this.policy.causeInterruptPendingBits
      | this.policy.causeExceptionCodeBits);
  }

  get status(): number {
    return this.statusValue;
  }

  get cause(): number {
    return this.causeValue;
  }

  get epc(): number {
    return this.epcValue;
  }

  snapshot(): Cp0Snapshot {
    return { status: this.statusValue, cause: this.causeValue, epc: this.epcValue };
  }

  isReadable(register: number): boolean {
    return this.policy.readableRegisters.includes(register);
  }

  isWritable(register: number): boolean {
    return this.policy.writableRegisters.includes(register);
  }

  read(register: number): number {
    switch (register) {
      case cp0RegisterNumbers.status:
        return this.statusValue;
      case cp0RegisterNumbers.cause:
        return this.causeValue;
      case cp0RegisterNumbers.epc:
        return this.epcValue;
      default:
        return 0;
    }
  }

  /** Value the register would hold after an `mtc0`, with unimplemented bits masked off. */
  maskedWrite(register: number, value: number): number {
    switch (register) {
      case cp0RegisterNumbers.status:
        return u32(value) & this.policy.statusWritableMask;
      case cp0RegisterNumbers.cause:
        return u32((this.causeValue & ~this.policy.causeWritableMask)
          | (u32(value) & this.policy.causeWritableMask));
      case cp0RegisterNumbers.epc:
        return u32(value) & this.policy.epcWritableMask;
      default:
        return 0;
    }
  }

  write(register: number, value: number): void {
    switch (register) {
      case cp0RegisterNumbers.status:
        this.statusValue = u32(value);
        break;
      case cp0RegisterNumbers.cause:
        this.causeValue = u32(value);
        break;
      case cp0RegisterNumbers.epc:
        this.epcValue = u32(value);
        break;
      default:
        break;
    }
  }

  /** `Cause.IP` mirrors HWInt every cycle (P7-2-6 CP0 约束). */
  setInterruptPending(hardwareInterrupts: number): void {
    const shift = lowestSetBitIndex(this.policy.causeInterruptPendingBits);
    const pending = u32((hardwareInterrupts << shift) & this.policy.causeInterruptPendingBits);
    this.causeValue = u32((this.causeValue & ~this.policy.causeInterruptPendingBits) | pending);
  }

  /** HWInt bits currently visible in `Cause.IP`. */
  interruptPending(): number {
    const shift = lowestSetBitIndex(this.policy.causeInterruptPendingBits);
    return u32(this.causeValue & this.policy.causeInterruptPendingBits) >>> shift;
  }

  /** `SR.IM` field value (six HWInt mask bits). */
  interruptMask(): number {
    const shift = lowestSetBitIndex(this.policy.statusInterruptMaskBits);
    return u32(this.statusValue & this.policy.statusInterruptMaskBits) >>> shift;
  }

  get exceptionLevel(): boolean {
    return (this.statusValue & this.policy.statusExceptionLevelBit) !== 0;
  }

  get interruptEnable(): boolean {
    return (this.statusValue & this.policy.statusInterruptEnableBit) !== 0;
  }

  /**
   * Interrupt acceptance predicate: `IE = 1`, `EXL = 0` and at least one masked
   * HWInt line asserted (P7-2-3/P7-2-6). All three must hold; the caller samples
   * the pre-instruction SR (COURSE-P7-CP0-SAME-CYCLE-001).
   */
  interruptRequested(hardwareInterrupts: number): boolean {
    return this.interruptEnable
      && !this.exceptionLevel
      && (this.interruptMask() & u32(hardwareInterrupts) & 0x3f) !== 0;
  }

  /** Apply the Cause/EPC/SR side effects of one accepted Req. */
  enterTrap(input: {
    readonly code: number;
    readonly branchDelay: boolean;
    readonly epc: number;
  }): void {
    const bd = input.branchDelay ? this.policy.causeBranchDelayBit : 0;
    const excCode = u32(input.code << this.policy.causeExceptionCodeShift)
      & this.policy.causeExceptionCodeBits;
    const cleared = u32(this.causeValue
      & ~(this.policy.causeBranchDelayBit | this.policy.causeExceptionCodeBits));
    this.causeValue = u32(cleared | bd | excCode);
    this.epcValue = u32(input.epc);
    this.statusValue = u32(this.statusValue | this.policy.statusExceptionLevelBit);
  }

  /** `eret`: clear EXL and hand back the return PC. */
  exitTrap(): number {
    this.statusValue = u32(this.statusValue & ~this.policy.statusExceptionLevelBit);
    return this.epcValue;
  }
}

function lowestSetBitIndex(mask: number): number {
  const value = u32(mask);
  if (value === 0) {
    return 0;
  }
  let index = 0;
  let remaining = value;
  while ((remaining & 1) === 0) {
    remaining >>>= 1;
    index++;
  }
  return index;
}

/** Complete architectural state of one machine session. */
export class MachineState {
  readonly gpr: RegisterFile;
  readonly cp0: Cp0Registers | undefined;
  pc: number;
  hi: number;
  lo: number;
  hiDefined: boolean;
  loDefined: boolean;
  pendingBranch: PendingBranch | undefined;

  constructor(readonly profile: CourseExecutionProfile) {
    const reset = profile.reset;
    this.gpr = new RegisterFile(reset.gpr);
    this.pc = u32(reset.pc);
    this.hi = u32(reset.hi);
    this.lo = u32(reset.lo);
    this.hiDefined = reset.hiLoDefined;
    this.loDefined = reset.hiLoDefined;
    this.pendingBranch = undefined;
    this.cp0 = profile.exceptions
      ? new Cp0Registers(profile.exceptions.cp0, {
        status: reset.cp0Status,
        cause: reset.cp0Cause,
        epc: reset.cp0Epc
      })
      : undefined;
  }

  /** CP0 access for profiles that model exceptions; throws for P3-P6 callers. */
  requireCp0(): Cp0Registers {
    if (!this.cp0) {
      throw new Error(`profile ${this.profile.id} does not implement CP0`);
    }
    return this.cp0;
  }
}

/** Exception code for a course exception name. */
export function exceptionCode(name: CourseExceptionName): number {
  return courseExceptionCodes[name];
}
