// @index generator-semantics — 内置生成器 GPR 写回值、溢出与分支判定的纯语义（随机体与冒险求解共用）
import { clo32, clz32, signExtend16, signed32, unsigned32 } from '../mipsUtil';

/** Registers the random body treats as small enough for non-overflowing signed arithmetic. */
export function isSmallArithmeticOperand(value: number): boolean {
  return Math.abs(signed32(value)) <= 0x2000;
}

export function signedAddOverflows(left: number, right: number): boolean {
  const result = signed32(left) + signed32(right);
  return result > 0x7fffffff || result < -0x80000000;
}

export function signedSubtractOverflows(left: number, right: number): boolean {
  const result = signed32(left) - signed32(right);
  return result > 0x7fffffff || result < -0x80000000;
}

/** Three-register ALU result (`op rd, rs, rt`). */
export function registerRegisterResult(mnemonic: string, left: number, right: number): number {
  switch (mnemonic) {
    case 'add':
    case 'addu':
      return (left + right) | 0;
    case 'sub':
    case 'subu':
      return (left - right) | 0;
    case 'and':
      return left & right;
    case 'or':
      return left | right;
    case 'xor':
      return left ^ right;
    case 'nor':
      return ~(left | right);
    case 'slt':
      return signed32(left) < signed32(right) ? 1 : 0;
    case 'sltu':
      return unsigned32(left) < unsigned32(right) ? 1 : 0;
    case 'mul':
      return Math.imul(left, right);
    default:
      throw new Error(`Internal generator error: ${mnemonic} is not a three-register ALU instruction.`);
  }
}

/** Register-immediate ALU result (`op rt, rs, imm`). */
export function registerImmediateResult(mnemonic: string, left: number, imm: number): number {
  switch (mnemonic) {
    case 'addi':
    case 'addiu':
      return (left + signExtend16(imm)) | 0;
    case 'andi':
      return left & (imm & 0xffff);
    case 'ori':
      return left | (imm & 0xffff);
    case 'xori':
      return left ^ (imm & 0xffff);
    case 'slti':
      return signed32(left) < signExtend16(imm) ? 1 : 0;
    case 'sltiu':
      return unsigned32(left) < unsigned32(signExtend16(imm)) ? 1 : 0;
    default:
      throw new Error(`Internal generator error: ${mnemonic} is not an immediate ALU instruction.`);
  }
}

/** Fixed or variable shift result; variable shifts use only the low five amount bits. */
export function shiftResult(mnemonic: string, value: number, amount: number): number {
  const shamt = amount & 0x1f;
  switch (mnemonic) {
    case 'sll':
    case 'sllv':
      return value << shamt;
    case 'srl':
    case 'srlv':
      return value >>> shamt | 0;
    case 'sra':
    case 'srav':
      return value >> shamt;
    default:
      throw new Error(`Internal generator error: ${mnemonic} is not a shift instruction.`);
  }
}

export function countBitsResult(mnemonic: string, value: number): number {
  return mnemonic === 'clz' ? clz32(unsigned32(value)) : clo32(unsigned32(value));
}

/** Branch condition for the course branch family; operands absent from the form are ignored. */
export function branchTaken(mnemonic: string, first: number, second: number): boolean {
  switch (mnemonic) {
    case 'beq':
      return first === second;
    case 'bne':
      return first !== second;
    case 'bgez':
    case 'bgezal':
      return signed32(first) >= 0;
    case 'bgtz':
      return signed32(first) > 0;
    case 'blez':
      return signed32(first) <= 0;
    case 'bltz':
    case 'bltzal':
      return signed32(first) < 0;
    default:
      return false;
  }
}
