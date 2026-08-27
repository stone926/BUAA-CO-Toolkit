// @index mips-core — MachineSession：原子提交、异常/中断仲裁、停机检测与状态快照
import { ProgramImage } from '../api';
import { DeviceBusPort } from '../devices/deviceBus';
import {
  CommitEvent,
  Cp0Write,
  DeviceEvent,
  HiLoWrite,
  MemoryRead,
  MemoryWrite,
  RegisterWrite,
  RunSliceResult,
  StepResult,
  TrapRecord
} from '../events/commitEvent';
import { sha256Text } from '../digest';
import { InstructionLayer } from '../generated/isaCatalog';
import { InstructionScope } from '../isa/decoder';
import {
  CourseExecutionProfile,
  courseExceptionCodes,
  cp0RegisterNumbers
} from '../profiles/profile';
import { hex8, hex8Address, u32 } from '../values';
import { MemoryBus, UnloadedInstructionPolicy } from './memoryBus';
import { Cp0Snapshot, MachineState, PendingBranch } from './state';
import {
  evaluateInstruction,
  InstructionEffect,
  UndefinedBehaviorPolicy
} from './transition';

/**
 * 架构级 oracle：一次 `stepInstruction` 求值一条指令，完成异常/中断仲裁后**原子**
 * 提交（计划第 5.3 节）。它不会自动推进 Timer——设备时间域由
 * `CourseSystemSession.tickDevices` 显式驱动，避免把一次 `lw/sw` 伪装成一个
 * 流水线周期。
 *
 * `Cause.IP` 在硬件里每周期刷新；架构 anchor 没有周期域，因此在每个指令边界用
 * 当次采样的 HWInt 刷新，并把这一取舍显式记录在这里而不是隐含在代码里。
 */

export type SnapshotLevel = 'registers' | 'full';

export interface MachineSnapshot {
  readonly level: SnapshotLevel;
  readonly profile: string;
  readonly pc: number;
  readonly gpr: readonly number[];
  readonly hi: number;
  readonly lo: number;
  readonly hiDefined: boolean;
  readonly loDefined: boolean;
  readonly cp0?: Cp0Snapshot;
  readonly pendingBranch?: PendingBranch;
  /** Sparse non-zero DM words; only present at `full` level. */
  readonly dataWords?: readonly { readonly address: number; readonly value: number }[];
  /** SHA-256 over the defined and observable fields above. */
  readonly digest: string;
}

export interface MachineSessionOptions {
  readonly profile: CourseExecutionProfile;
  readonly image: ProgramImage;
  /** Instruction layers recognised at runtime; defaults to the profile's own set. */
  readonly layers?: readonly InstructionLayer[];
  readonly undefinedBehavior?: UndefinedBehaviorPolicy;
  readonly unloadedInstruction?: UnloadedInstructionPolicy;
  readonly devices?: DeviceBusPort;
  /** Hard instruction budget; the session reports `step-limit` when it is reached. */
  readonly maxSteps?: number;
  /** Expected PC of the course halt loop; when set, halting elsewhere is rejected. */
  readonly haltPc?: number;
}

export interface StepInput {
  /** HWInt lines asserted at this instruction boundary; overrides the device sample. */
  readonly hardwareInterrupts?: number;
}

export class MachineSession {
  readonly state: MachineState;
  readonly memory: MemoryBus;
  private readonly scope: InstructionScope;
  private readonly devices: DeviceBusPort | undefined;
  private readonly undefinedBehavior: UndefinedBehaviorPolicy;
  private readonly maxSteps: number;
  private readonly haltPc: number | undefined;
  private sequence = 0;
  private executed = 0;
  private finished = false;
  private haltCandidatePc: number | undefined;
  private acceptedHaltPc: number | undefined;
  private pendingDeviceEvents: DeviceEvent[] = [];

  constructor(private readonly options: MachineSessionOptions) {
    const { profile } = options;
    this.state = new MachineState(profile);
    this.devices = options.devices;
    this.memory = new MemoryBus(profile, {
      ...(options.unloadedInstruction ? { unloadedInstruction: options.unloadedInstruction } : {}),
      ...(options.devices ? { devices: options.devices } : {})
    });
    this.memory.loadImage(options.image);
    this.state.pc = u32(options.image.entryPc || profile.reset.pc);
    this.scope = {
      profile: profile.id,
      enabledLayers: options.layers ?? profile.defaultLayers
    };
    this.undefinedBehavior = options.undefinedBehavior ?? 'fail-closed';
    this.maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;
    this.haltPc = options.haltPc === undefined ? undefined : u32(options.haltPc);
  }

  /**
   * Steps charged against the instruction budget. An accepted exception or
   * interrupt counts too: its victim committed nothing, but the step consumed a
   * commit point and an unbounded trap loop must still hit the budget.
   */
  get instructionsExecuted(): number {
    return this.executed;
  }

  get done(): boolean {
    return this.finished;
  }

  /**
   * PC of the validated course halt loop, i.e. the **self-branch** word, not its
   * delay-slot `nop`. `MachineSessionOptions.haltPc`, `AssembleResult.courseHaltPc`
   * and the legacy MARS halt proof all name the branch, so this getter is the one
   * definition of "where the program stopped" (COURSE-COMMON-HALT-001).
   */
  get courseHaltPc(): number | undefined {
    return this.acceptedHaltPc;
  }

  /** Evaluate and commit exactly one instruction. */
  stepInstruction(input: StepInput = {}): StepResult {
    if (this.finished) {
      return { status: 'halted' };
    }
    if (this.executed >= this.maxSteps) {
      this.finished = true;
      return {
        status: 'step-limit',
        event: this.haltEvent('step-limit'),
        diagnostic: {
          code: 'mips-core.exec.step-limit',
          message: `执行超过指令预算 ${this.maxSteps}`,
          pc: this.state.pc
        }
      };
    }

    const pcBefore = u32(this.state.pc);
    const inDelaySlot = this.state.pendingBranch !== undefined;
    const hardwareInterrupts = this.sampleInterrupts(pcBefore, input);
    const interruptAccepted = this.state.cp0?.interruptRequested(hardwareInterrupts) === true;

    const effect = evaluateInstruction({
      profile: this.options.profile,
      state: this.state,
      memory: this.memory,
      scope: this.scope,
      undefinedBehavior: this.undefinedBehavior
    });

    if (interruptAccepted) {
      return this.acceptTrap(effect, {
        kind: 'interrupt',
        name: 'int',
        code: courseExceptionCodes.int,
        branchDelay: inDelaySlot,
        victimPc: pcBefore,
        hardwareInterrupts
      });
    }
    if (effect.outOfDomain) {
      this.finished = true;
      return {
        status: 'out-of-domain',
        event: this.haltEvent('out-of-domain', effect),
        diagnostic: effect.outOfDomain
      };
    }
    if (effect.exception) {
      if (!this.state.cp0) {
        throw new Error(`profile ${this.options.profile.id} 产生了异常但没有 CP0`);
      }
      return this.acceptTrap(effect, {
        kind: 'exception',
        name: effect.exception.name,
        code: courseExceptionCodes[effect.exception.name],
        branchDelay: inDelaySlot,
        victimPc: pcBefore,
        stage: effect.exception.stage
      });
    }
    return this.commit(effect);
  }

  /** Run up to `maxInstructions` steps, stopping at the first non-committed status. */
  runSlice(maxInstructions: number): RunSliceResult {
    if (!Number.isSafeInteger(maxInstructions) || maxInstructions <= 0) {
      throw new Error(`runSlice: maxInstructions must be a positive safe integer, got ${maxInstructions}`);
    }
    const events: CommitEvent[] = [];
    let committed = 0;
    for (let index = 0; index < maxInstructions; index++) {
      const result = this.stepInstruction();
      if (result.event) {
        events.push(result.event);
      }
      if (result.status !== 'committed') {
        return {
          status: result.status,
          events,
          committed,
          ...(result.diagnostic ? { diagnostic: result.diagnostic } : {})
        };
      }
      committed++;
    }
    return { status: 'committed', events, committed };
  }

  snapshot(level: SnapshotLevel = 'registers'): MachineSnapshot {
    const gpr = this.state.gpr.toArray();
    const dataWords = level === 'full' ? this.memory.nonZeroWords('data') : undefined;
    const base = {
      level,
      profile: this.options.profile.id,
      pc: u32(this.state.pc),
      gpr,
      hi: u32(this.state.hi),
      lo: u32(this.state.lo),
      hiDefined: this.state.hiDefined,
      loDefined: this.state.loDefined,
      ...(this.state.cp0 ? { cp0: this.state.cp0.snapshot() } : {}),
      ...(this.state.pendingBranch ? { pendingBranch: this.state.pendingBranch } : {}),
      ...(dataWords ? { dataWords } : {})
    };
    return { ...base, digest: sha256Text(canonicalSnapshotText(base)) };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private sampleInterrupts(pcBefore: number, input: StepInput): number {
    if (input.hardwareInterrupts !== undefined) {
      const value = u32(input.hardwareInterrupts) & 0x3f;
      this.state.cp0?.setInterruptPending(value);
      return value;
    }
    if (!this.devices) {
      this.state.cp0?.setInterruptPending(0);
      return 0;
    }
    // Offer the macroscopic PC first so a scheduled external request can assert
    // before this instruction becomes eligible to commit.
    if (this.devices.observeMacroPc) {
      this.pendingDeviceEvents.push(...this.devices.observeMacroPc(pcBefore));
    }
    const sampled = u32(this.devices.sampleInterrupts()) & 0x3f;
    this.state.cp0?.setInterruptPending(sampled);
    return sampled;
  }

  private takeDeviceEvents(): DeviceEvent[] {
    const events = this.pendingDeviceEvents;
    this.pendingDeviceEvents = [];
    return events;
  }

  private commit(effect: InstructionEffect): StepResult {
    const gprWrites: RegisterWrite[] = [];
    for (const write of effect.gprWrites) {
      if (write.register === 0) {
        continue;
      }
      this.state.gpr.write(write.register, write.value);
      gprWrites.push(write);
    }

    const hiLoWrites: HiLoWrite[] = [];
    for (const write of effect.hiLoWrites) {
      if (write.register === 'hi') {
        this.state.hi = u32(write.value);
        this.state.hiDefined = write.defined !== false;
      } else {
        this.state.lo = u32(write.value);
        this.state.loDefined = write.defined !== false;
      }
      hiLoWrites.push(write);
    }
    if (effect.invalidateHiLo) {
      this.state.hiDefined = false;
      this.state.loDefined = false;
    }

    const cp0Writes: Cp0Write[] = [];
    for (const write of effect.cp0Writes) {
      this.state.requireCp0().write(write.register, write.value);
      cp0Writes.push(write);
    }

    const memoryWrites: MemoryWrite[] = [];
    const deviceEvents = this.takeDeviceEvents();
    if (effect.store) {
      const { prepared, rawValue, valueBefore, valueAfter } = effect.store;
      this.memory.commit(prepared, rawValue);
      memoryWrites.push({
        address: prepared.address,
        rawValue,
        wordAddress: prepared.wordAddress,
        byteMask: prepared.byteMask,
        valueBefore,
        valueAfter,
        region: prepared.region
      });
    }
    if (effect.deviceAccess && this.devices) {
      deviceEvents.push(...this.devices.commit(effect.deviceAccess));
    }

    const memoryReads: MemoryRead[] = [];
    if (effect.load) {
      const { prepared, wordValue, value } = effect.load;
      memoryReads.push({
        address: prepared.address,
        wordAddress: prepared.wordAddress,
        width: prepared.width,
        wordValue,
        value,
        region: prepared.region
      });
    }

    this.state.pc = u32(effect.nextPc);
    this.state.pendingBranch = effect.pendingBranch;
    this.executed++;

    const event: CommitEvent = {
      sequence: this.sequence++,
      kind: 'instruction',
      pcBefore: effect.pcBefore,
      ...(effect.word === undefined ? {} : { instructionWord: effect.word }),
      pcAfter: u32(effect.nextPc),
      ...(effect.delaySlot ? { delaySlot: true } : {}),
      ...(effect.branchOriginPc === undefined ? {} : { branchOriginPc: effect.branchOriginPc }),
      gprWrites,
      hiLoWrites,
      cp0Writes,
      memoryWrites,
      ...(memoryReads.length ? { memoryReads } : {}),
      deviceEvents,
      ...(effect.branchTaken === undefined ? {} : { branchTaken: effect.branchTaken }),
      ...(effect.controlTarget === undefined ? {} : { controlTarget: effect.controlTarget }),
      ...(effect.mnemonic ? { mnemonic: effect.mnemonic } : {})
    };

    const halted = this.updateHaltDetector(effect);
    if (halted) {
      this.finished = true;
      return { status: 'halted', event: { ...event, haltReason: 'course-halt-loop' } };
    }
    return { status: 'committed', event };
  }

  private acceptTrap(
    effect: InstructionEffect,
    trap: {
      readonly kind: 'exception' | 'interrupt';
      readonly name: TrapRecord['name'];
      readonly code: number;
      readonly branchDelay: boolean;
      readonly victimPc: number;
      readonly stage?: TrapRecord['stage'];
      readonly hardwareInterrupts?: number;
    }
  ): StepResult {
    const policy = this.options.profile.exceptions;
    const cp0 = this.state.cp0;
    if (!policy || !cp0) {
      throw new Error(`profile ${this.options.profile.id} 不支持异常/中断`);
    }
    // The victim contributes no architectural side effect at all: suppress the
    // prepared device transaction before the bridge observes it.
    if (effect.deviceAccess && this.devices) {
      this.devices.abort(effect.deviceAccess);
    }

    const before = cp0.snapshot();
    const epc = trap.branchDelay ? u32(trap.victimPc - 4) : u32(trap.victimPc);
    cp0.enterTrap({ code: trap.code, branchDelay: trap.branchDelay, epc });
    const after = cp0.snapshot();

    this.state.pc = u32(policy.cp0.handlerPc);
    this.state.pendingBranch = undefined;
    this.executed++;

    const cp0Writes: Cp0Write[] = [];
    if (after.cause !== before.cause) {
      cp0Writes.push({ register: cp0RegisterNumbers.cause, valueBefore: before.cause, value: after.cause });
    }
    if (after.epc !== before.epc) {
      cp0Writes.push({ register: cp0RegisterNumbers.epc, valueBefore: before.epc, value: after.epc });
    }
    if (after.status !== before.status) {
      cp0Writes.push({ register: cp0RegisterNumbers.status, valueBefore: before.status, value: after.status });
    }

    const record: TrapRecord = {
      kind: trap.kind,
      name: trap.name,
      code: trap.code,
      victimPc: u32(trap.victimPc),
      branchDelay: trap.branchDelay,
      epc,
      handlerPc: u32(policy.cp0.handlerPc),
      ...(trap.stage ? { stage: trap.stage } : {}),
      ...(trap.hardwareInterrupts === undefined
        ? {}
        : { hardwareInterrupts: trap.hardwareInterrupts })
    };

    this.haltCandidatePc = undefined;
    return {
      status: 'committed',
      event: {
        sequence: this.sequence++,
        kind: trap.kind,
        pcBefore: u32(trap.victimPc),
        ...(effect.word === undefined ? {} : { instructionWord: effect.word }),
        pcAfter: u32(policy.cp0.handlerPc),
        ...(trap.branchDelay ? { delaySlot: true } : {}),
        ...(effect.branchOriginPc === undefined ? {} : { branchOriginPc: effect.branchOriginPc }),
        gprWrites: [],
        hiLoWrites: [],
        cp0Writes,
        memoryWrites: [],
        deviceEvents: this.takeDeviceEvents(),
        trap: record,
        ...(effect.mnemonic ? { mnemonic: effect.mnemonic } : {})
      }
    };
  }

  /**
   * Course completion is the full two-instruction sequence: the self-targeting
   * `beq` plus, on delay-slot profiles, its delay-slot `nop`. Seeing the branch
   * PC alone never stops the run (COURSE-P56-DOMAIN-001).
   */
  private updateHaltDetector(effect: InstructionEffect): boolean {
    const halt = this.options.profile.halt;
    const word = effect.word;
    const candidate = this.haltCandidatePc;
    if (candidate !== undefined
      && effect.pcBefore === u32(candidate + 4)
      && word === halt.delaySlotWord) {
      this.haltCandidatePc = undefined;
      return this.acceptHaltPc(candidate);
    }
    this.haltCandidatePc = undefined;
    if (word !== halt.selfBranchWord) {
      return false;
    }
    const selfTarget = this.options.profile.delaySlot
      ? effect.pendingBranch?.targetPc
      : effect.nextPc;
    if (u32(selfTarget ?? -1) !== u32(effect.pcBefore)) {
      return false;
    }
    if (!halt.requireDelaySlotCommit) {
      return this.acceptHaltPc(effect.pcBefore);
    }
    this.haltCandidatePc = effect.pcBefore;
    return false;
  }

  private acceptHaltPc(pc: number): boolean {
    if (this.haltPc !== undefined && u32(pc) !== this.haltPc) {
      return false;
    }
    this.acceptedHaltPc = u32(pc);
    return true;
  }

  private haltEvent(
    reason: 'step-limit' | 'out-of-domain',
    effect?: InstructionEffect
  ): CommitEvent {
    return {
      sequence: this.sequence++,
      kind: 'halt',
      pcBefore: u32(effect?.pcBefore ?? this.state.pc),
      ...(effect?.word === undefined ? {} : { instructionWord: effect.word }),
      pcAfter: u32(this.state.pc),
      gprWrites: [],
      hiLoWrites: [],
      cp0Writes: [],
      memoryWrites: [],
      deviceEvents: this.takeDeviceEvents(),
      haltReason: reason
    };
  }
}

/**
 * Canonical digest text: only defined and observable fields participate, so an
 * undefined HI/LO cannot silently make two runs look different (计划第 5.4 节).
 */
export function canonicalSnapshotText(snapshot: Omit<MachineSnapshot, 'digest'>): string {
  const lines: string[] = [
    `profile=${snapshot.profile}`,
    `pc=${hex8(snapshot.pc)}`
  ];
  for (let index = 1; index < 32; index++) {
    lines.push(`r${index}=${hex8(snapshot.gpr[index] ?? 0)}`);
  }
  lines.push(`hi=${snapshot.hiDefined ? hex8(snapshot.hi) : 'undefined'}`);
  lines.push(`lo=${snapshot.loDefined ? hex8(snapshot.lo) : 'undefined'}`);
  if (snapshot.cp0) {
    lines.push(`sr=${hex8(snapshot.cp0.status)}`);
    lines.push(`cause=${hex8(snapshot.cp0.cause)}`);
    lines.push(`epc=${hex8(snapshot.cp0.epc)}`);
  }
  if (snapshot.pendingBranch) {
    lines.push(`delay=${hex8Address(snapshot.pendingBranch.originPc)}->${hex8Address(snapshot.pendingBranch.targetPc)}`);
  }
  for (const word of snapshot.dataWords ?? []) {
    lines.push(`m${hex8(word.address)}=${hex8(word.value)}`);
  }
  return lines.join('\n');
}
