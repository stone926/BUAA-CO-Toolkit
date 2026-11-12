// @index link-register-coverage — Directed JAL link reads, younger $31 writes, and observable adjusted/restored returns.
import { CpuState } from '../cpuState';
import { RegisterCoverageWriter } from './registerCoverage';

export interface LinkRegisterCoverageWriter extends RegisterCoverageWriter {
  skippedPoison(): void;
  beginDynamicGroup(): void;
  endDynamicGroup(order: readonly number[]): void;
}

const randomReserve = 128;
const savedLinkAddress = 0x94;
const replacementAddress = 0x90;
const observationAddress = 0x98;
type Producer = 'ori' | 'add' | 'sub' | 'lw';
type Consumer = 'alu' | 'branch' | 'branch_rt' | 'store' | 'jr';

/** Each available matrix is atomic; short/focus-only cases retain their random payload. */
export function emitLinkRegisterCoverage(
  writer: LinkRegisterCoverageWriter,
  state: CpuState,
  allowed: ReadonlySet<string>,
  delaySlot: boolean
): void {
  if (!delaySlot || !['ori', 'jal', 'nop'].every((op) => allowed.has(op))) return;
  new LinkCoverage(writer, state, allowed).emit();
}

class LinkCoverage {
  private groupIndex = 0;

  constructor(
    private readonly writer: LinkRegisterCoverageWriter,
    private readonly state: CpuState,
    private readonly allowed: ReadonlySet<string>
  ) {}

  emit(): void {
    this.emitReads();
    this.emitRewrites();
    if (['sub', 'beq', 'jr'].every((op) => this.allowed.has(op)) && this.fits(12)) this.emitReturn('adjust');
    if (['sw', 'lw', 'beq', 'jr'].every((op) => this.allowed.has(op)) && this.fits(11)) this.emitReturn('restore');
    if (['beq', 'jr'].every((op) => this.allowed.has(op)) && this.fits(11)) this.emitReturn('mature');
  }

  private fits(count: number): boolean {
    return this.writer.remaining() >= count + randomReserve;
  }

  private put(op: string, text: string, destination?: string, value?: number): number {
    const index = this.groupIndex++;
    this.writer.emit(op, text);
    if (destination !== undefined && value !== undefined) this.state.setRegister(destination, value);
    return index;
  }

  private ori(register: string, value: number): number {
    return this.put('ori', `ori ${register}, $0, ${value}`, register, value);
  }

  private store(register: string, address: number): number {
    const index = this.put('sw', `sw ${register}, ${address}($0)`);
    this.state.memory.set(address, this.state.regValue(register));
    return index;
  }

  private poison(): void {
    this.groupIndex++;
    this.writer.skippedPoison();
  }

  private jal(label: string): number {
    const link = this.writer.pc() + 8;
    return this.put('jal', `jal ${label}`, '$31', link);
  }

  private emitReads(): void {
    const arithmetic = (['add', 'sub'] as const).filter((op) => this.allowed.has(op));
    const store = Number(this.allowed.has('sw'));
    if (!arithmetic.length || !this.fits(1 + arithmetic.length * 2 * (22 + 4 * store))) return;
    this.ori('$22', 0x30);
    for (const op of arithmetic) {
      for (const role of ['rs', 'rt'] as const) {
        // Gap 3 puts the consumer's D stage after JAL's W stage, exercising the GRF path.
        for (const gap of [0, 1, 2, 3]) {
          const label = `_co_link_cov_read_${op}_${role}_gap${gap}`;
          this.writer.label(label);
          this.ori('$31', 0x123);
          this.writer.label(`${label}_jal`);
          this.jal(`${label}_target`);
          const consume = (): void => {
            this.writer.label(`${label}_consumer`);
            const left = this.state.regValue(role === 'rs' ? '$31' : '$22');
            const right = this.state.regValue(role === 'rt' ? '$31' : '$22');
            this.put(op, `${op} $20, ${role === 'rs' ? '$31, $22' : '$22, $31'}`,
              '$20', op === 'add' ? left + right : left - right);
          };
          if (gap === 0) consume();
          else this.put('nop', 'nop');
          this.poison();
          this.writer.label(`${label}_target`);
          if (gap > 0) {
            for (let index = 1; index < gap; index++) this.put('nop', 'nop');
            consume();
          }
          if (store) this.store('$20', observationAddress);
        }
      }
    }
  }

  private emitRewrites(): void {
    const producers = (['ori', 'add', 'sub', 'lw'] as const).filter((op) =>
      this.allowed.has(op) && (op !== 'lw' || this.allowed.has('sw')));
    const consumers: Consumer[] = [];
    if (this.allowed.has('add') || this.allowed.has('sub')) consumers.push('alu');
    if (this.allowed.has('beq')) consumers.push('branch', 'branch_rt');
    if (this.allowed.has('sw')) consumers.push('store');
    if (this.allowed.has('jr')) consumers.push('jr');
    const cost = (producer: Producer, consumer: Consumer): number => 1 + Number(producer === 'lw') +
      (consumer === 'jr' ? 7 : consumer === 'branch' || consumer === 'branch_rt' ? 6 + Number(this.allowed.has('sw')) :
        consumer === 'alu' ? 4 + Number(this.allowed.has('sw')) : 4);
    if (!this.fits(producers.reduce((sum, producer) =>
      sum + consumers.reduce((total, consumer) => total + cost(producer, consumer), 0), 0))) return;
    for (const producer of producers) {
      for (const consumer of consumers) this.emitRewrite(producer, consumer);
    }
  }

  private emitRewrite(producer: Producer, consumer: Consumer): void {
    const label = `_co_link_cov_rewrite_${producer}_${consumer}`;
    this.writer.label(label);
    // The JR target follows JAL, its slot, poison, JR, its slot, and a second poison.
    const setupLength = 1 + Number(producer === 'lw');
    const replacement = consumer === 'jr' ? this.writer.pc() + 4 * (setupLength + 6) : 0x44;
    this.ori('$22', replacement);
    if (producer === 'lw') this.store('$22', replacementAddress);
    this.writer.label(`${label}_jal`);
    this.jal(`${label}_target`);
    if (producer === 'ori') this.ori('$31', replacement);
    else if (producer === 'lw') this.put('lw', `lw $31, ${replacementAddress}($0)`, '$31', replacement);
    else this.put(producer, `${producer} $31, $22, $0`, '$31', replacement);
    this.poison();
    this.writer.label(`${label}_target`);
    this.writer.label(`${label}_consumer`);
    if (consumer === 'alu') {
      const op = this.allowed.has('add') ? 'add' : 'sub';
      // Addition keeps either source-port priority error visible, including identical errors.
      this.put(op, `${op} $20, $31, ${op === 'add' ? '$31' : '$0'}`, '$20',
        op === 'add' ? replacement * 2 : replacement);
      if (this.allowed.has('sw')) this.store('$20', observationAddress);
    } else if (consumer === 'branch' || consumer === 'branch_rt') {
      // Each port has its own call/write/branch block, preserving the competing-write window.
      this.put('beq', `beq ${consumer === 'branch_rt' ? '$22, $31' : '$31, $22'}, ${label}_done`);
      this.put('nop', 'nop');
      this.poison();
      this.writer.label(`${label}_done`);
      if (this.allowed.has('sw')) this.store('$31', observationAddress);
    } else if (consumer === 'store') {
      this.store('$31', observationAddress);
    } else {
      this.put('jr', 'jr $31');
      this.put('nop', 'nop');
      this.poison();
      this.writer.label(`${label}_done`);
      this.ori('$20', 0x55);
    }
  }

  private emitReturn(mode: 'adjust' | 'restore' | 'mature'): void {
    const restore = mode === 'restore';
    const adjust = mode === 'adjust';
    const label = `_co_link_cov_${mode}_return`;
    this.writer.label(label);
    if (adjust) {
      this.ori('$30', 4);
      this.put('sub', 'sub $30, $0, $30', '$30', -4);
    }
    this.writer.beginDynamicGroup();
    this.groupIndex = 0;
    this.writer.label(`${label}_jal`);
    const call = this.jal(`${label}_callee`);
    const slot = restore ? this.store('$31', savedLinkAddress) : adjust ?
      this.put('sub', 'sub $31, $31, $30', '$31', this.state.regValue('$31') + 4) : this.ori('$21', 0x73);
    // An unadjusted link lands here and exposes the wrong return before the escape branch.
    if (adjust) this.poison();
    const escape = this.put('beq', `beq $0, $0, ${label}_done`);
    const escapeSlot = this.put('nop', 'nop');
    this.poison();
    this.writer.label(`${label}_callee`);
    const body: number[] = [];
    if (restore) {
      body.push(this.ori('$31', this.writer.pc() + 4 * 4));
      body.push(this.put('lw', `lw $31, ${savedLinkAddress}($0)`, '$31', this.state.memory.get(savedLinkAddress) ?? 0));
    } else if (!adjust) {
      // Together with the call's slot these put JR after link writeback, on the GRF path.
      body.push(this.put('nop', 'nop'), this.put('nop', 'nop'));
    }
    this.writer.label(`${label}_jr`);
    const jump = this.put('jr', 'jr $31');
    const jumpSlot = this.put('nop', 'nop');
    this.poison();
    this.writer.label(`${label}_done`);
    const marker = this.ori('$20', restore ? 0x62 : adjust ? 0x61 : 0x63);
    this.writer.endDynamicGroup([call, slot, ...body, jump, jumpSlot, escape, escapeSlot, marker]);
  }
}
