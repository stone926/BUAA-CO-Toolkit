// @index mips-core — Debugger disassembly using shared integer operand forms and COP1 facts
import { immediateSignedKind, realInstructionForms } from '../assembler/instructionForms';
import { gprNames } from '../assembler/registers';
import { marsFpArithmetic, marsFpComparison, marsFpMemoryOpcodes, marsFpRounding, marsFpUnary } from '../assembler/marsInstructionFacts';
import { matchExactInstruction } from '../isa/decoder';
import { hex8Address, signExtend16, u32 } from '../values';
import type { DebugMode } from './api';
const gprName = (number: number): string => gprNames[number].names[0];

export function disassembleDebugInstruction(word: number, address: number, mode: DebugMode): string {
  const rs = (word >>> 21) & 31, rt = (word >>> 16) & 31, rd = (word >>> 11) & 31;
  const signedImmediate = signExtend16(word), target = hex8Address(u32(address + 4 + signedImmediate * 4));
  if (mode.kind === 'mars') {
    const fp = disassembleFloatingPoint(word, target);
    if (fp) return fp;
    if (((word & 0xfc00003f) >>> 0) === 13) return `break ${(word >>> 6) & 0xfffff}`;
    if (((word & 0xfc00003f) >>> 0) === 1) return `mov${rt & 1 ? 't' : 'f'} ${gprName(rd)}, ${gprName(rs)}, ${(rt >>> 2) & 7}`;
  }
  const entry = matchExactInstruction(word, { profile: mode.kind === 'course' ? mode.profile : 'P7',
    enabledLayers: mode.kind === 'course' ? ['required', 'commonExtensions'] : ['required', 'commonExtensions', 'marsCompatibility'] });
  if (!entry) return `.word ${hex8Address(word)}`;
  const operands = realInstructionForms(entry.mnemonic, entry).map(form => {
    switch (form.kind) {
      case 'register': return gprName(form.role === 'rs' ? rs : form.role === 'rt' ? rt : rd);
      case 'shamt': return String((word >>> 6) & 31);
      case 'immediate': return String(immediateSignedKind(entry.mnemonic) === 'unsigned' ? word & 0xffff : signedImmediate);
      case 'label': return entry.formatKind === 'j' ? hex8Address(u32(((address + 4) & 0xf0000000) | ((word & 0x3ffffff) * 4))) : target;
      case 'memory': return `${signedImmediate}(${gprName(rs)})`;
      case 'cp0': return `$${rd}`;
    }
  });
  return `${entry.mnemonic}${operands.length ? ` ${operands.join(', ')}` : ''}`;
}

function nameFor(table: Readonly<Record<string, number>>, code: number): string | undefined {
  return Object.keys(table).find(name => table[name] === code);
}
function disassembleFloatingPoint(word: number, target: string): string | undefined {
  const opcode = word >>> 26, fmt = (word >>> 21) & 31, ft = (word >>> 16) & 31;
  const fs = (word >>> 11) & 31, fd = (word >>> 6) & 31, fn = word & 63;
  const memoryName = nameFor(marsFpMemoryOpcodes, opcode);
  if (memoryName) return `${memoryName} $f${ft}, ${signExtend16(word)}(${gprName(fmt)})`;
  if (opcode !== 17) return undefined;
  if (fmt === 0 || fmt === 4) return `${fmt === 0 ? 'mfc1' : 'mtc1'} ${gprName(ft)}, $f${fs}`;
  if (fmt === 8 && !(ft & 2)) return `bc1${ft & 1 ? 't' : 'f'} ${(ft >>> 2) & 7}, ${target}`;
  if (![16, 17, 20].includes(fmt)) return undefined;
  const suffix = fmt === 16 ? 's' : fmt === 17 ? 'd' : 'w';
  if ([32, 33, 36].includes(fn)) return `cvt.${fn === 32 ? 's' : fn === 33 ? 'd' : 'w'}.${suffix} $f${fd}, $f${fs}`;
  const arithmetic = nameFor(marsFpArithmetic, fn);
  if (arithmetic) return `${arithmetic}.${suffix} $f${fd}, $f${fs}, $f${ft}`;
  const unary = nameFor(marsFpUnary, fn);
  if (unary) return `${unary}.${suffix} $f${fd}, $f${fs}`;
  const rounding = nameFor(marsFpRounding, fn);
  if (rounding) return `${rounding}.w.${suffix} $f${fd}, $f${fs}`;
  const comparison = nameFor(marsFpComparison, fn);
  if (comparison) return `c.${comparison}.${suffix} ${(word >>> 8) & 7}, $f${fs}, $f${ft}`;
  if (fn === 17) return `mov${ft & 1 ? 't' : 'f'}.${suffix} $f${fd}, $f${fs}, ${(ft >>> 2) & 7}`;
  if (fn === 18 || fn === 19) return `mov${fn === 18 ? 'z' : 'n'}.${suffix} $f${fd}, $f${fs}, ${gprName(ft)}`;
  return undefined;
}
