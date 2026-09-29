// @index hazard-witnesses — 黑盒可观察的双操作数、最新写优先和 load/store 字节通路定向序列
import type { HazardEmitHost } from './hazardBlocks';
import type { OperandSteer } from './operandSteer';

type Instruction = { readonly mnemonic: string; readonly steer: OperandSteer };
type Witness =
  | { readonly kind: 'priority'; readonly loadLast: boolean; readonly gap: number }
  | { readonly kind: 'dual'; readonly loadLast: boolean; readonly swap: boolean }
  | { readonly kind: 'address-data'; readonly gap: number }
  | { readonly kind: 'lane'; readonly store: 'sb' | 'sh'; readonly lane: number };

/**
 * Pairwise coverage cannot require two operand muxes to work together, nor distinguish an
 * available older ALU result from a younger load which is not ready yet. These small blocks
 * give every wrong choice a different architectural result. Gaps describe instruction order
 * only: no observation or assertion depends on the DUT's pipeline stages or stall count.
 */
export class HazardWitnessEmitter {
  private readonly pending: Witness[] = [];

  constructor(private readonly host: HazardEmitHost) {
    if (!['ori', 'sw', 'lw', 'add', 'sub'].every((mnemonic) => host.allowed.has(mnemonic))) return;
    for (const gap of [0, 1, 2]) {
      this.pending.push({ kind: 'priority', loadLast: true, gap }, { kind: 'priority', loadLast: false, gap });
    }
    for (const loadLast of [false, true]) {
      for (const swap of [false, true]) this.pending.push({ kind: 'dual', loadLast, swap });
    }
    for (const gap of [0, 1, 2]) this.pending.push({ kind: 'address-data', gap });
    if (!host.allowed.has('lui')) return;
    for (const store of ['sb', 'sh'] as const) {
      if (!host.allowed.has(store)) continue;
      for (const lane of store === 'sb' ? [0, 1, 2, 3] : [0, 2]) this.pending.push({ kind: 'lane', store, lane });
    }
  }

  emitNext(): boolean {
    const witness = this.pending[0];
    if (!witness || this.host.remaining() < 16) return false;
    const registers = [...this.host.hazardRegisters];
    const takeRegister = (): string => registers.splice(this.host.rng.int(0, registers.length - 1), 1)[0];
    const [first, second, result] = [takeRegister(), takeRegister(), takeRegister()];
    const address = this.host.rng.int(0x20, 0x2e0) * 16;
    const instructions: Instruction[] = [];
    const emit = (mnemonic: string, steer: OperandSteer): void => { instructions.push({ mnemonic, steer }); };
    const constant = (register: string, value: number): void => {
      if (value > 0xffff) {
        emit('lui', { write: register, immediate: value >>> 16 });
        emit('ori', { write: register, reads: { rs: register }, immediate: value & 0xffff });
      } else {
        emit('ori', { write: register, reads: { rs: '$0' }, immediate: value });
      }
    };
    const load = (register: string, at: number): void => emit('lw', { write: register, reads: { rs: '$0' }, address: at });
    const store = (register: string, at: number): void => emit('sw', { reads: { rs: '$0', rt: register }, address: at });
    const gap = (count: number): void => {
      // Explicit independent writes keep the gap exact and observable, without risking another
      // random load-use stall or overwriting either source of the intended consumer.
      for (let index = 0; index < count; index++) constant(result, 0x40 + index);
    };
    const left = this.host.rng.int(0x100, 0x3ff);
    const right = this.host.rng.int(0x500, 0x7ff);

    switch (witness.kind) {
      case 'priority':
        constant(second, right);
        store(second, address);
        constant(first, 0x31);
        if (witness.loadLast) {
          constant(first, left);
          load(first, address);
        } else {
          load(first, address);
          constant(first, left);
        }
        gap(witness.gap);
        // Both ports consume the same latest write. Either stale port changes the sum.
        emit('add', { write: result, reads: { rs: first, rt: first } });
        store(result, address + 4);
        break;
      case 'dual':
        constant(result, right);
        store(result, address);
        constant(first, 0x11);
        constant(second, 0x22);
        if (witness.loadLast) {
          constant(first, left);
          load(second, address);
        } else {
          load(second, address);
          constant(first, left);
        }
        // Subtraction also exposes swapped ports, unlike a commutative add.
        emit('sub', { write: result, reads: witness.swap ? { rs: second, rt: first } : { rs: first, rt: second } });
        store(result, address + 4);
        break;
      case 'address-data':
        constant(second, address + 8);
        store(second, address);
        constant(first, address + 12);
        load(first, address);
        gap(witness.gap);
        // One loaded register supplies both an in-range aligned base and the stored data.
        emit('sw', { reads: { rs: first, rt: first }, address: address + 8 });
        load(result, address + 8);
        emit('add', { write: result, reads: { rs: result, rt: result } });
        break;
      case 'lane': {
        constant(second, 0x12345678);
        store(second, address + 4);
        constant(second, witness.store === 'sb' ? 0x81 + witness.lane : 0x81c3 + witness.lane);
        store(second, address);
        constant(first, 0x17);
        load(first, address);
        emit(witness.store, { reads: { rs: '$0', rt: first }, address: address + 4 + witness.lane });
        // Full-word readback exposes damage to untouched lanes, then signed and unsigned
        // readback feed a dependency chain to expose incorrect load extension/forwarding.
        load(result, address + 4);
        const readers = witness.store === 'sb' ? ['lb', 'lbu'] : ['lh', 'lhu'];
        for (const reader of readers.filter((mnemonic) => this.host.allowed.has(mnemonic))) {
          emit(reader, { write: result, reads: { rs: '$0' }, address: address + 4 + witness.lane });
          emit('add', { write: result, reads: { rs: result, rt: result } });
        }
        break;
      }
    }
    if (instructions.length > this.host.remaining() || instructions.some(({ mnemonic }) => !this.host.canEmitSingle(mnemonic))) return false;
    this.pending.shift();
    const detail = witness.kind === 'lane' ? `${witness.store}_${witness.lane}`
      : witness.kind === 'dual' ? `${Number(witness.loadLast)}_${Number(witness.swap)}`
        : witness.kind === 'priority' ? `${Number(witness.loadLast)}_${witness.gap}` : `${witness.gap}`;
    this.host.label(this.host.nextLabel(`hz_witness_${witness.kind.replace('-', '_')}_${detail}`));
    for (const { mnemonic, steer } of instructions) {
      if (!this.host.emitSteered(mnemonic, steer)) throw new Error(`Internal generator error: cannot emit ${mnemonic} in ${witness.kind} witness.`);
    }
    this.host.label(this.host.nextLabel('hz_witness_end'));
    return true;
  }
}
