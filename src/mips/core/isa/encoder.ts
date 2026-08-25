// @index mips-core — 基于生成 catalog 的机器码编码（真实指令，不含 pseudo）
import { IsaInstructionEntry, isaInstructionByMnemonic } from '../generated/isaCatalog';

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
  if (mnemonic === 'nop' || mnemonic === 'eret') {
    if (Object.values(operands).some((value) => value !== undefined)) {
      throw new InstructionEncodeError(`${mnemonic} does not accept operand fields`);
    }
    return mnemonic === 'nop' ? 0 : 0x42000018;
  }
  rejectUnexpectedOperands(mnemonic, entry, operands);
  const rs = field5(operands.rs, `${mnemonic}: rs`);
  const rt = field5(operands.rt, `${mnemonic}: rt`);
  const rd = field5(operands.rd, `${mnemonic}: rd`);
  const shamt = field5(operands.shamt, `${mnemonic}: shamt`);
  const immediate = field16(operands.immediate, `${mnemonic}: immediate`);
  const index = field26(operands.index, `${mnemonic}: index`);
  const opcode = entry.formatOpcode;

  let word: number;
  switch (entry.formatKind) {
    case 'r':
      word = ((opcode << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (shamt << 6) | entry.formatFunct) >>> 0;
      break;
    case 'regimm':
      word = ((opcode << 26) | (rs << 21) | (entry.formatRt << 16) | immediate) >>> 0;
      break;
    case 'j':
      word = ((opcode << 26) | index) >>> 0;
      break;
    case 'branch':
      word = ((opcode << 26) | (rs << 21) | (rt << 16) | immediate) >>> 0;
      break;
    case 'imm':
      word = ((opcode << 26) | (rs << 21) | (rt << 16) | immediate) >>> 0;
      break;
    case 'cop0':
      word = ((opcode << 26) | (entry.formatRs << 21) | (rt << 16) | (rd << 11)) >>> 0;
      break;
    case 'load':
    case 'store':
      word = ((opcode << 26) | (rs << 21) | (rt << 16) | immediate) >>> 0;
      break;
    case 'special2':
      word = ((opcode << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (shamt << 6) | entry.formatFunct) >>> 0;
      break;
    default:
      throw new InstructionEncodeError(`unsupported format kind: ${entry.formatKind}`);
  }
  for (const [mask, label] of entry.canonicalFixedZeroBits) {
    if ((word & mask) !== 0) {
      throw new InstructionEncodeError(`${mnemonic}: reserved field ${label} must be zero`);
    }
  }
  if (mnemonic === 'mfc0' && ![12, 13, 14].includes(rd)) {
    throw new InstructionEncodeError(`mfc0: unsupported course CP0 register ${rd}`);
  }
  if (mnemonic === 'mtc0' && ![12, 14].includes(rd)) {
    throw new InstructionEncodeError(`mtc0: unsupported writable course CP0 register ${rd}`);
  }
  return word;
}

function rejectUnexpectedOperands(
  mnemonic: string,
  entry: IsaInstructionEntry,
  operands: EncodeOperands
): void {
  const allowed = new Set<keyof EncodeOperands>();
  switch (entry.formatKind) {
    case 'r':
    case 'special2':
      addEffectRegisterFields(allowed, entry.gprReads);
      addEffectRegisterFields(allowed, entry.gprWrites);
      if (['sll', 'srl', 'sra'].includes(mnemonic)) {
        allowed.add('shamt');
      }
      break;
    case 'regimm':
      allowed.add('rs');
      allowed.add('immediate');
      break;
    case 'j':
      allowed.add('index');
      break;
    case 'branch':
    case 'imm':
    case 'load':
    case 'store':
      addEffectRegisterFields(allowed, entry.gprReads);
      addEffectRegisterFields(allowed, entry.gprWrites);
      allowed.add('immediate');
      break;
    case 'cop0':
      addEffectRegisterFields(allowed, entry.gprReads);
      addEffectRegisterFields(allowed, entry.gprWrites);
      allowed.add('rd');
      break;
    default:
      break;
  }
  for (const [field, value] of Object.entries(operands) as Array<[keyof EncodeOperands, number | undefined]>) {
    if (value !== undefined && !allowed.has(field)) {
      throw new InstructionEncodeError(`${mnemonic}: operand field ${field} is not used by this instruction`);
    }
  }
}

function addEffectRegisterFields(
  target: Set<keyof EncodeOperands>,
  roles: readonly (string | number)[]
): void {
  for (const role of roles) {
    if (role === 'rs' || role === 'rt' || role === 'rd') {
      target.add(role);
    }
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
