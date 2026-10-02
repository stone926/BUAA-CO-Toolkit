// @index mips-core — Bounded ordinary-MARS execution on MachineSession with resumable host IO
import { StepResult } from '../events/commitEvent';
import { canonicalSnapshotText, MachineSession, MachineSnapshot, SnapshotLevel } from '../machine/session';
import { sha256Text } from '../digest';
import { getMarsMemoryLayout } from '../profiles/marsMemoryLayout';
import { MarsIoRequest, MarsIoResponse, MarsSessionOptions, MarsSliceResult, MarsStepResult } from './api';
import { createMarsProfile } from './profile';
import { MarsSyscalls, SyscallAction } from './syscalls';
import { marsInstructionExtension } from './instructionExtensions';
import { FloatingPointState } from './floatingPointState';
import { SyscallMemoryError } from './syscallMemory';

interface PendingSyscall {
  readonly request: MarsIoRequest;
  readonly args: readonly number[];
}

export interface MarsSnapshot extends MachineSnapshot {
  readonly fpr: readonly number[];
  readonly fpConditionFlags: number;
}

export class MarsSession {
  readonly machine: MachineSession;
  readonly fpu = new FloatingPointState();
  private readonly syscalls: MarsSyscalls;
  private readonly maxSteps: number;
  private readonly textEnd: number;
  private pending?: PendingSyscall;
  private terminal?: MarsStepResult;
  private nextRequestId = 1;
  private readonly memoryConfiguration: string;

  constructor(options: MarsSessionOptions) {
    this.maxSteps = options.maxSteps ?? 10_000_000;
    const limit = options.maxIoBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.maxSteps) || this.maxSteps <= 0) {
      throw new Error('maxSteps must be a positive safe integer');
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 16_777_216) {
      throw new Error('maxIoBytes must be a positive integer no larger than 16 MiB');
    }
    const layout = getMarsMemoryLayout(options.memoryConfiguration);
    this.memoryConfiguration = layout.configuration;
    this.machine = new MachineSession({
      image: options.image,
      profile: createMarsProfile(options.memoryConfiguration, options.delayedBranching),
      maxSteps: this.maxSteps,
      detectCourseHalt: false,
      syscallServices: true,
      instructionExtension: marsInstructionExtension(this.fpu)
    });
    this.syscalls = new MarsSyscalls(this.machine.memory, options.image, layout, limit, this.fpu);
    this.textEnd = Math.max(layout.sectionLayout.text.base,
      ...options.image.segments.filter((segment) => segment.name === 'text')
        .map((segment) => segment.baseAddress + segment.words.length * 4));
  }

  get instructionsExecuted(): number { return this.machine.instructionsExecuted; }
  get done(): boolean { return this.terminal !== undefined; }
  snapshot(level: SnapshotLevel = 'registers'): MarsSnapshot {
    const base = { ...this.machine.snapshot(level), profile: `MARS-${this.memoryConfiguration}` };
    const fpr = this.fpu.snapshot();
    const fpConditionFlags = this.fpu.conditionFlags;
    const digest = sha256Text(`${canonicalSnapshotText(base)}\nfpr=${fpr.join(',')}\nfpcc=${fpConditionFlags}`);
    return { ...base, fpr, fpConditionFlags, digest };
  }

  step(): MarsStepResult {
    if (this.terminal) { return this.terminal; }
    if (this.pending) { return { status: 'waiting', request: this.pending.request }; }
    if (this.machine.state.pc === this.textEnd && !this.machine.state.pendingBranch) {
      return this.finish({ status: 'exited', exitCode: 0 });
    }
    if (this.instructionsExecuted >= this.maxSteps) {
      return this.fromMachine(this.machine.stepInstruction());
    }
    const fetched = this.machine.memory.fetch(this.machine.state.pc);
    const word = fetched.word;
    // A syscall may contain a code field; opcode/funct determine its meaning.
    if (word === undefined || ((word & 0xfc00003f) >>> 0) !== 0x0000000c) {
      return this.fromMachine(this.machine.stepInstruction());
    }
    const service = this.machine.state.gpr.read(2);
    const args = [4, 5, 6, 7].map((register) => this.machine.state.gpr.read(register));
    try {
      const action = this.syscalls.prepare(service, args, this.nextRequestId++);
      if (action.request) {
        this.pending = { request: action.request, args };
        return { status: 'waiting', request: action.request };
      }
      return this.commit(action);
    } catch (error) { return this.fault(error); }
  }

  /** Repeated step() calls while waiting return the same request without executing it. */
  resume(response: MarsIoResponse): MarsStepResult {
    if (this.terminal) { return this.terminal; }
    if (!this.pending) { return this.fault(new Error('No syscall is waiting for a response')); }
    try {
      const action = this.syscalls.complete(this.pending.request, this.pending.args, response);
      this.pending = undefined;
      return this.commit(action);
    } catch (error) { return this.fault(error); }
  }

  runSlice(maxInstructions: number): MarsSliceResult {
    if (!Number.isSafeInteger(maxInstructions) || maxInstructions <= 0 || maxInstructions > 1_000_000) {
      throw new Error('runSlice requires an instruction count between 1 and 1000000');
    }
    const start = this.instructionsExecuted;
    for (let i = 0; i < maxInstructions; i++) {
      const result = this.step();
      if (result.status !== 'running') {
        return { ...result, executed: this.instructionsExecuted - start };
      }
    }
    return { status: 'running', executed: this.instructionsExecuted - start };
  }

  private commit(action: SyscallAction): MarsStepResult {
    const result = this.fromMachine(this.machine.stepInstruction({ syscallWrites: action.writes, syscallCommit: action.commit }));
    if (result.status === 'running' && action.exitCode !== undefined) {
      return this.finish({ status: 'exited', exitCode: action.exitCode });
    }
    return result;
  }

  private fromMachine(result: StepResult): MarsStepResult {
    if (result.status === 'committed') { return { status: 'running' }; }
    if (result.status === 'halted') { return this.finish({ status: 'exited', exitCode: 0 }); }
    const diagnostic = result.diagnostic;
    return this.finish({
      status: result.status === 'step-limit' ? 'step-limit' : 'fault',
      diagnostic: {
        code: diagnostic?.code ?? 'mips-core.mars.execution',
        message: diagnostic?.message ?? 'MARS instruction execution failed',
        pc: diagnostic?.pc ?? this.machine.state.pc
      }
    });
  }

  private fault(error: unknown): MarsStepResult {
    this.pending = undefined;
    const word = this.machine.memory.fetch(this.machine.state.pc).word;
    const message = error instanceof Error ? error.message : String(error);
    if (word !== undefined && ((word & 0xfc00003f) >>> 0) === 12 && !this.machine.done) {
      return this.fromMachine(this.machine.stepInstruction({ syscallException: {
        name: error instanceof SyscallMemoryError ? (error.direction === 'load' ? 'adel' : 'ades') : 'syscall',
        stage: 'execute', message,
        ...(error instanceof SyscallMemoryError ? { address: error.address } : {})
      } }));
    }
    return this.finish({ status: 'fault', diagnostic: {
      code: 'mips-core.mars.syscall',
      message,
      pc: this.machine.state.pc
    } });
  }

  private finish(result: MarsStepResult): MarsStepResult { this.terminal = result; return result; }
}
