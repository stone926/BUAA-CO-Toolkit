// @index mips-core — 基于生成 catalog 的机器码编码（真实指令，不含 pseudo）
import { isaInstructionByMnemonic } from '../generated/isaCatalog';

/**
 * Operand fields for one real instruction encoding. Field layouts follow the
 * standard MIPS layouts (R / I / J / REGIMM / SPECIAL2 / COP0).
 */
export interface EncodeOperands {
  rs?: number;
  rt?: number;
  rd?: number;
  shamt?: number;
  /** Signed 16-bit immediate (branch offset, memory offset, or immediate). */
  immediate?: number;
  /** J-type 26-bit word index. */
  index?: number;
}

export class InstructionEncodeError extends Error {}

/**
 * Encode one real (non-pseudo) instruction. Returns the 32-bit word.
 * Throws InstructionEncodeError for unknown mnemonics or out-of-range fields.
 */
export function encodeInstructionWord(mnemonic: string, operands: EncodeOperands = {}): number {
  const entry = isaInstructionByMnemonic.get(mnemonic);
  if (!entry) {
    throw new InstructionEncodeError(`unknown instruction mnemonic: ${mnemonic}`);
  }
  const rs = field5(operands.rs, `${mnemonic}: rs`);
  const rt = field5(operands.rt, `${mnemonic}: rt`);
  const rd = field5(operands.rd, `${mnemonic}: rd`);
  const shamt = field5(operands.shamt, `${mnemonic}: shamt`);
  const immediate = field16(operands.immediate, `${mnemonic}: immediate`);
  const index = field26(operands.index, `${mnemonic}: index`);
  const opcode = entry.formatOpcode;

  switch (entry.formatKind) {
    case 'nop':
      return 0;
    case 'eret':
      return 0x42000018;
    case 'r':
      return ((opcode << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (shamt << 6) | entry.formatFunct) >>> 0;
    case 'regimm':
      return ((opcode << 26) | (rs << 21) | (entry.formatRt << 16) | immediate) >>> 0;
    case 'j':
      return ((opcode << 26) | index) >>> 0;
    case 'branch':
      return ((opcode << 26) | (rs << 21) | (rt << 16) | immediate) >>> 0;
    case 'imm':
      return ((opcode << 26) | (rs << 21) | (rt << 16) | immediate) >>> 0;
    case 'cop0':
      return ((opcode << 26) | (entry.formatRs << 21) | (rt << 16) | (rd << 11)) >>> 0;
    case 'load':
    case 'store':
      return ((opcode << 26) | (rs << 21) | (rt << 16) | immediate) >>> 0;
    case 'special2':
      return ((opcode << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (shamt << 6) | entry.formatFunct) >>> 0;
    default:
      throw new InstructionEncodeError(`unsupported format kind: ${entry.formatKind}`);
  }
}

function field5(value: number | undefined, label: string): number {
  const field = value ?? 0;
  if (!Number.isInteger(field) || field < 0 || field > 31) {
    throw new InstructionEncodeError(`${label} out of range: ${value}`);
  }
  return field;
}

function field16(value: number | undefined, label: string): number {
  const field = value ?? 0;
  if (!Number.isInteger(field) || field < -32768 || field > 65535) {
    throw new InstructionEncodeError(`${label} out of range: ${value}`);
  }
  return field & 0xffff;
}

function field26(value: number | undefined, label: string): number {
  const field = value ?? 0;
  if (!Number.isInteger(field) || field < 0 || field > 0x03ffffff) {
    throw new InstructionEncodeError(`${label} out of range: ${value}`);
  }
  return field;
}
