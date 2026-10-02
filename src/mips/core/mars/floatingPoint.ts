// @index mips-core — Ordinary COP1 semantics evaluated and committed by the shared machine
import { PreparedMemoryAccess } from '../machine/memoryBus';
import { controlTransferTargets, InstructionEffect, InstructionExtension, TransitionContext } from '../machine/transition';
import { signExtend16, u32 } from '../values';
import { FloatingPointState, FloatingPointWrite } from './floatingPointState';

class FloatingMemoryError extends Error {
  constructor(readonly store: boolean, readonly address: number, message: string) { super(message); }
}

export function floatingPointExtension(fpu: FloatingPointState): InstructionExtension {
  return (context, instruction) => {
    const opcode = instruction.word >>> 26;
    if (![0x11, 0x31, 0x35, 0x39, 0x3d].includes(opcode)) { return undefined; }
    try { return evaluate(fpu, context, instruction); }
    catch (error) {
      if (error instanceof FloatingMemoryError) {
        return { ...instruction, exception: {
          name: error.store ? 'ades' : 'adel', stage: 'memory', address: error.address, message: error.message
        } };
      }
      return { ...instruction, outOfDomain: {
        code: 'mips-core.mars.floating-point',
        message: error instanceof Error ? error.message : String(error),
        pc: instruction.pcBefore
      } };
    }
  };
}

function evaluate(fpu: FloatingPointState, context: TransitionContext, base: InstructionEffect & { readonly word: number }): InstructionEffect {
  const { word, pcBefore } = base;
  const opcode = word >>> 26;
  const fmt = (word >>> 21) & 31;
  const ft = (word >>> 16) & 31;
  const fs = (word >>> 11) & 31;
  const fd = (word >>> 6) & 31;
  const fn = word & 63;
  const write = (writes: readonly FloatingPointWrite[], mnemonic: string): InstructionEffect => ({
    ...base, mnemonic, extensionCommit: () => fpu.commit(writes)
  });
  if (opcode !== 0x11) { return memoryEffect(fpu, context, base, opcode, fmt, ft); }
  if (fmt === 0) {
    return { ...base, mnemonic: 'mfc1', gprWrites: [{ register: ft, value: fpu.raw(fs) }] };
  }
  if (fmt === 4) { return write([{ register: fs, value: context.state.gpr.read(ft) }], 'mtc1'); }
  if (fmt === 8) {
    if ((ft & 2) !== 0) { throw new Error('Unsupported COP1 branch-likely instruction'); }
    if (base.delaySlot && context.profile.delaySlot) { throw new Error('Floating-point branch in a branch delay slot'); }
    const cc = (ft >>> 2) & 7;
    const onTrue = (ft & 1) !== 0;
    const target = u32(pcBefore + 4 + signExtend16(word) * 4);
    const taken = fpu.condition(cc) === onTrue;
    return {
      ...base, mnemonic: onTrue ? 'bc1t' : 'bc1f', controlTransfer: true,
      ...controlTransferTargets(context.profile, pcBefore, u32(pcBefore + 4), target, taken)
    };
  }
  if (![16, 17, 20].includes(fmt)) { throw new Error(`Unsupported COP1 format ${fmt}`); }
  const double = fmt === 17;
  const suffix = double ? 'd' : fmt === 20 ? 'w' : 's';
  const read = (register: number): number => fmt === 20 ? fpu.raw(register) | 0 : double ? fpu.double(register) : fpu.single(register);
  const writeNumber = (value: number, mnemonic: string): InstructionEffect =>
    write(double ? fpu.doubleWrites(fd, value) : fpu.singleWrites(fd, value), `${mnemonic}.${suffix}`);
  const a = read(fs);
  if (fn === 0x20) { return write(fpu.singleWrites(fd, a), `cvt.s.${suffix}`); }
  if (fn === 0x21) { return write(fpu.doubleWrites(fd, a), `cvt.d.${suffix}`); }
  if (fn === 0x24 && fmt !== 20) { return write([{ register: fd, value: javaInteger(a) }], `cvt.w.${suffix}`); }
  if (fmt === 20) { throw new Error('Unsupported word-format floating-point operation'); }
  switch (fn) {
    case 0: return writeNumber(a + read(ft), 'add');
    case 1: return writeNumber(a - read(ft), 'sub');
    case 2: return writeNumber(a * read(ft), 'mul');
    case 3: return writeNumber(a / read(ft), 'div');
    case 4: return writeNumber(Math.sqrt(a), 'sqrt');
    case 5: return writeNumber(Math.abs(a), 'abs');
    case 6: {
      if (double) { fpu.requirePair(fd); }
      return write(double
        ? [{ register: fd, value: fpu.raw(fs) }, { register: fd + 1, value: fpu.raw(fs + 1) }]
        : [{ register: fd, value: fpu.raw(fs) }], `mov.${suffix}`);
    }
    case 7: return writeNumber(-a, 'neg');
    case 12: case 13: case 14: case 15: {
      const names = ['round', 'trunc', 'ceil', 'floor'];
      const rounded = fn === 12 ? roundEven(a) : fn === 13 ? Math.trunc(a) : fn === 14 ? Math.ceil(a) : Math.floor(a);
      const value = !Number.isFinite(a) || a < -0x80000000 || a > (double ? 0x7fffffff : 0x80000000)
        ? 0x7fffffff : javaInteger(rounded);
      return write([{ register: fd, value }], `${names[fn - 12]}.w.${suffix}`);
    }
    case 17: {
      const flag = (ft >>> 2) & 7;
      const taken = fpu.condition(flag) === ((ft & 1) !== 0);
      if (double) { fpu.requirePair(fd); }
      return taken ? write(double
        ? [{ register: fd, value: fpu.raw(fs) }, { register: fd + 1, value: fpu.raw(fs + 1) }]
        : [{ register: fd, value: fpu.raw(fs) }], `mov${ft & 1 ? 't' : 'f'}.${suffix}`) : base;
    }
    case 18: case 19: {
      const value = context.state.gpr.read(ft);
      const taken = fn === 18 ? value === 0 : value !== 0;
      if (double) { fpu.requirePair(fd); }
      return taken ? write(double
        ? [{ register: fd, value: fpu.raw(fs) }, { register: fd + 1, value: fpu.raw(fs + 1) }]
        : [{ register: fd, value: fpu.raw(fs) }], `mov${fn === 18 ? 'z' : 'n'}.${suffix}`) : base;
    }
    case 0x32: case 0x3c: case 0x3e: {
      const b = read(ft);
      const result = fn === 0x32 ? a === b : fn === 0x3c ? a < b : a <= b;
      return { ...base, mnemonic: `c.${fn === 0x32 ? 'eq' : fn === 0x3c ? 'lt' : 'le'}.${suffix}`,
        extensionCommit: () => fpu.setCondition((word >>> 8) & 7, result) };
    }
    default: throw new Error(`Unsupported floating-point function ${fn}`);
  }
}

function memoryEffect(fpu: FloatingPointState, context: TransitionContext, base: InstructionEffect & { readonly word: number }, opcode: number, rs: number, ft: number): InstructionEffect {
  const store = opcode === 0x39 || opcode === 0x3d;
  const double = opcode === 0x35 || opcode === 0x3d;
  if (double) { fpu.requirePair(ft); }
  const address = u32(context.state.gpr.read(rs) + signExtend16(base.word));
  if (double && (address & 7) !== 0) { throw new FloatingMemoryError(store, address, 'Floating-point doubleword address must be eight-byte aligned'); }
  const accesses: PreparedMemoryAccess[] = [];
  // Both addresses are validated before either half can commit.
  for (let i = 0; i < (double ? 2 : 1); i++) {
    if (address + i * 4 > 0xffffffff) { throw new FloatingMemoryError(store, address, 'Floating-point transfer crosses the address boundary'); }
    const prepared = context.memory.prepare({ kind: store ? 'store' : 'load', address: address + i * 4, width: 4 });
    if ('reason' in prepared) { throw new FloatingMemoryError(store, address, prepared.message); }
    accesses.push(prepared);
  }
  const mnemonic = `${store ? 's' : 'l'}${double ? 'd' : 'w'}c1`;
  if (store) {
    const values = accesses.map((_, i) => fpu.raw(ft + i));
    return { ...base, mnemonic, extensionCommit: () => {
      for (let i = 0; i < accesses.length; i++) { context.memory.commit(accesses[i], values[i]); }
    } };
  }
  const writes = accesses.map((access, i) => ({ register: ft + i, value: context.memory.read(access, false) }));
  return { ...base, mnemonic, extensionCommit: () => fpu.commit(writes) };
}

/** Java narrowing FP-to-int conversion truncates, clamps infinities, and maps NaN to zero. */
function javaInteger(value: number): number {
  if (Number.isNaN(value)) { return 0; }
  return value >= 0x7fffffff ? 0x7fffffff : value <= -0x80000000 ? -0x80000000 : Math.trunc(value);
}

function roundEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  return fraction === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
}
