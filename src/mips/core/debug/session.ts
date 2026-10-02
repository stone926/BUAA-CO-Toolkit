// @index mips-core — Interactive architectural stepping over shared MARS and course machines
import { MachineSession } from '../machine/session';
import type { MarsIoRequest, MarsIoResponse, MarsStepResult } from '../mars/api';
import { MarsSession } from '../mars/session';
import { createMarsProfile } from '../mars/profile';
import { getMarsMemoryLayout } from '../profiles/marsMemoryLayout';
import { resolveCourseProfile } from '../profiles/courseProfiles';
import { isDeviceRegion, regionForAddress, CourseExecutionProfile } from '../profiles/profile';
import type { DebugCommand, DebugMemoryPage, DebugSessionOptions, DebugSnapshot } from './api';
import { parseDebugBreakpoints, parseDebugCommand, parseDebugMemory } from './validation';

export class DebugSession {
  readonly machine: MachineSession;
  private readonly mars?: MarsSession;
  private readonly profile: CourseExecutionProfile;
  private status: DebugSnapshot['status'] = 'paused';
  private reason: DebugSnapshot['reason'] = 'entry';
  private diagnostic?: DebugSnapshot['diagnostic'];
  private exitCode?: number;
  private breakpoints: Set<number>;
  private memoryPage: { address: number; words: number };
  private ignoreBreakpointOnce = false;
  private remaining = Number.POSITIVE_INFINITY;

  constructor(options: DebugSessionOptions) {
    const maxSteps = options.maxSteps ?? 10_000_000;
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100_000_000) throw new Error('Debugger maxSteps must be in 1..100000000');
    this.breakpoints = new Set(parseDebugBreakpoints(options.breakpoints ?? []));
    this.profile = options.mode.kind === 'mars'
      ? createMarsProfile(options.mode.memoryConfiguration, options.mode.delayedBranching)
      : resolveCourseProfile(options.mode.profile);
    this.memoryPage = parseDebugMemory(options.memory ?? { address: options.mode.kind === 'mars'
      ? getMarsMemoryLayout(options.mode.memoryConfiguration).sectionLayout.data.base : 0 });
    if (options.mode.kind === 'mars') {
      this.mars = new MarsSession({ image: options.image, ...options.mode, maxSteps });
      this.machine = this.mars.machine;
    } else {
      this.machine = new MachineSession({ image: options.image, profile: this.profile, maxSteps });
    }
  }
  get done(): boolean { return !['paused', 'running'].includes(this.status); }
  get running(): boolean { return this.status === 'running'; }
  get stopped(): boolean { return this.status === 'stopped'; }

  command(input: DebugCommand): void {
    const command = parseDebugCommand(input);
    if (command.kind === 'memory') { this.memoryPage = parseDebugMemory(command); return; }
    if (command.kind === 'set-breakpoints') { this.breakpoints = new Set(command.addresses); return; }
    if (command.kind === 'stop') { this.status = 'stopped'; this.reason = 'terminal'; return; }
    if (this.done) return;
    if (command.kind === 'pause') { this.status = 'paused'; this.reason = 'pause'; return; }
    this.ignoreBreakpointOnce = command.kind === 'step' || this.reason === 'breakpoint';
    this.remaining = command.kind === 'step' ? 1 : Number.POSITIVE_INFINITY;
    this.status = 'running';
    this.reason = 'slice';
  }

  /** Executes a bounded slice; a suspended syscall consumes its instruction only on resume. */
  advance(maxInstructions = 1024): MarsIoRequest | undefined {
    if (!Number.isInteger(maxInstructions) || maxInstructions < 1 || maxInstructions > 1024) throw new Error('Debugger slice requires 1..1024 instructions');
    for (let index = 0; this.running && index < maxInstructions; index++) {
      if (this.remaining === 0) { this.status = 'paused'; this.reason = 'step'; break; }
      const pc = this.machine.state.pc;
      if (!this.ignoreBreakpointOnce && this.breakpoints.has(pc)) { this.status = 'paused'; this.reason = 'breakpoint'; break; }
      const before = this.machine.instructionsExecuted;
      if (this.mars) {
        const result = this.mars.step();
        if (result.status === 'waiting') return result.request;
        this.handleMarsResult(result);
      } else {
        const result = this.machine.stepInstruction();
        if (result.status === 'halted') { this.status = 'exited'; this.exitCode = 0; }
        else if (result.status !== 'committed') {
          this.status = result.status === 'step-limit' ? 'step-limit' : 'fault';
          this.diagnostic = { code: result.diagnostic?.code ?? 'mips-core.debug.execution',
            message: result.diagnostic?.message ?? 'Course execution stopped', pc: result.diagnostic?.pc ?? pc };
        }
      }
      this.remaining -= this.machine.instructionsExecuted - before;
      this.ignoreBreakpointOnce = false;
      if (this.done) { this.reason = 'terminal'; break; }
      if (this.remaining === 0) { this.status = 'paused'; this.reason = 'step'; break; }
    }
    return undefined;
  }
  resume(response: MarsIoResponse): void {
    if (!this.mars || this.done) throw new Error('No ordinary MARS syscall is pending');
    const before = this.machine.instructionsExecuted;
    this.handleMarsResult(this.mars.resume(response));
    this.remaining -= this.machine.instructionsExecuted - before;
    this.ignoreBreakpointOnce = false;
    if (this.done) this.reason = 'terminal';
    else if (this.remaining === 0) { this.status = 'paused'; this.reason = 'step'; }
  }
  snapshot(): DebugSnapshot {
    return { ...(this.mars?.snapshot() ?? this.machine.snapshot()), instructions: this.machine.instructionsExecuted,
      status: this.status, reason: this.reason, breakpoints: [...this.breakpoints].sort((a, b) => a - b),
      memory: this.readMemory(), ...(this.diagnostic ? { diagnostic: this.diagnostic } : {}),
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }) };
  }
  private readMemory(): DebugMemoryPage {
    const words: DebugMemoryPage['words'][number][] = [];
    for (let index = 0; index < this.memoryPage.words; index++) {
      const address = this.memoryPage.address + index * 4;
      const region = regionForAddress(this.profile, address);
      if (!region || isDeviceRegion(region)) words.push({ address, unavailable: 'unmapped or device memory' });
      else if (region.instructionOnly && !this.machine.memory.isLoadedInstruction(address)) words.push({ address, unavailable: 'instruction not loaded' });
      else words.push({ address, value: this.machine.memory.readDataWord(address) });
    }
    return { address: this.memoryPage.address, words };
  }
  private handleMarsResult(result: MarsStepResult): void {
    if (result.status === 'exited') { this.status = 'exited'; this.exitCode = result.exitCode; }
    else if (result.status === 'fault' || result.status === 'step-limit') { this.status = result.status; this.diagnostic = result.diagnostic; }
  }
}
