// @index waveform-disasm — 32 位机器字反汇编为课程 MIPS 汇编文本（复用 core 解码器、operand form 与寄存器名表）

import { immediateSignedKind, realInstructionForms } from '../../mips/core/assembler/instructionForms';
import { gprNames } from '../../mips/core/assembler/registers';
import { matchExactInstruction } from '../../mips/core/isa/decoder';

const cache = new Map<number, string>();
const cacheLimit = 4096;

/**
 * Disassemble one instruction word in MARS-like syntax (`addu $t1, $t2, $t3`,
 * `lw $t0, -4($sp)`). Branch labels show the signed word offset relative to PC+4;
 * jump targets show the 28-bit region address. Unknown words render as `.word`.
 */
export function disassembleMipsWord(word: number): string {
  const value = word >>> 0;
  const cached = cache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const text = disassembleUncached(value);
  if (cache.size >= cacheLimit) {
    cache.clear();
  }
  cache.set(value, text);
  return text;
}

function disassembleUncached(value: number): string {
  const entry = matchExactInstruction(value);
  if (!entry) {
    return `.word 0x${hex32(value)}`;
  }
  let forms;
  try {
    forms = realInstructionForms(entry.mnemonic, entry);
  } catch {
    return entry.mnemonic;
  }
  const rs = (value >>> 21) & 0x1f;
  const rt = (value >>> 16) & 0x1f;
  const rd = (value >>> 11) & 0x1f;
  const shamt = (value >>> 6) & 0x1f;
  const unsignedImmediate = value & 0xffff;
  const signedImmediate = (unsignedImmediate << 16) >> 16;
  const operands = forms.map((form) => {
    switch (form.kind) {
      case 'register':
        return registerName(form.role === 'rs' ? rs : form.role === 'rt' ? rt : rd);
      case 'shamt':
        return String(shamt);
      case 'immediate':
        return immediateSignedKind(entry.mnemonic) === 'unsigned'
          ? `0x${unsignedImmediate.toString(16)}`
          : String(signedImmediate);
      case 'label':
        return entry.formatKind === 'j'
          ? `0x${hex32(((value & 0x03ffffff) << 2) >>> 0)}`
          : (signedImmediate >= 0 ? `+${signedImmediate}` : String(signedImmediate));
      case 'memory':
        return `${signedImmediate}(${registerName(rs)})`;
      case 'cp0':
        return `$${rd}`;
      default:
        return '?';
    }
  });
  return operands.length ? `${entry.mnemonic} ${operands.join(', ')}` : entry.mnemonic;
}

function registerName(index: number): string {
  return gprNames[index]?.names[0] ?? `$${index}`;
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
