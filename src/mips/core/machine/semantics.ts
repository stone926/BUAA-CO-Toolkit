// @index mips-core — 纯算术/比较/移位/部分字访存语义（不接触任何状态）
import {
  addSigned32WithOverflow,
  divideSigned32,
  divideUnsigned32,
  fromHalves,
  high32,
  low32,
  multiplySigned64,
  multiplyUnsigned64,
  s32,
  signedLessThan,
  signExtend16,
  subSigned32WithOverflow,
  u32,
  unsignedLessThan,
  zeroExtend16
} from '../values';

/**
 * 每个 handler 独立实现，不共享"聪明"的通用表达式（计划第 5.9 节）：这样一个
 * mutation 只能破坏一条指令，sign/zero extend 互换之类的错误无法靠邻居掩盖。
 *
 * 本模块是纯函数集合：输入是已经读出的 32 位值，输出是 32 位值与标志位；
 * 它不知道寄存器编号、内存或 profile。
 */

export interface AluOutcome {
  readonly value: number;
  /** Signed 32-bit overflow flag; only `add/addi/sub` act on it. */
  readonly overflow: boolean;
}

const noOverflow = (value: number): AluOutcome => ({ value: u32(value), overflow: false });

/** Register-register ALU handlers (`rs`, `rt`) and shifts (`rt`, `shamt`). */
export function registerAlu(
  handlerId: string,
  rs: number,
  rt: number,
  shamt: number
): AluOutcome | undefined {
  switch (handlerId) {
    case 'add': {
      const { result, overflow } = addSigned32WithOverflow(rs, rt);
      return { value: result, overflow };
    }
    case 'addu':
      return noOverflow(u32(rs) + u32(rt));
    case 'sub': {
      const { result, overflow } = subSigned32WithOverflow(rs, rt);
      return { value: result, overflow };
    }
    case 'subu':
      return noOverflow(u32(rs) - u32(rt));
    case 'and':
      return noOverflow(u32(rs) & u32(rt));
    case 'or':
      return noOverflow(u32(rs) | u32(rt));
    case 'xor':
      return noOverflow(u32(rs) ^ u32(rt));
    case 'nor':
      return noOverflow(~(u32(rs) | u32(rt)));
    case 'slt':
      return noOverflow(signedLessThan(rs, rt) ? 1 : 0);
    case 'sltu':
      return noOverflow(unsignedLessThan(rs, rt) ? 1 : 0);
    case 'sll':
      return noOverflow(u32(rt) << (shamt & 0x1f));
    case 'srl':
      return noOverflow(u32(rt) >>> (shamt & 0x1f));
    case 'sra':
      return noOverflow(s32(rt) >> (shamt & 0x1f));
    case 'sllv':
      return noOverflow(u32(rt) << (u32(rs) & 0x1f));
    case 'srlv':
      return noOverflow(u32(rt) >>> (u32(rs) & 0x1f));
    case 'srav':
      return noOverflow(s32(rt) >> (u32(rs) & 0x1f));
    case 'clz':
      return noOverflow(countLeadingZeros(u32(rs)));
    case 'clo':
      return noOverflow(countLeadingZeros(u32(~u32(rs))));
    default:
      return undefined;
  }
}

/** Register-immediate ALU handlers; `immediate` is the raw 16-bit field. */
export function immediateAlu(
  handlerId: string,
  rs: number,
  immediate: number
): AluOutcome | undefined {
  switch (handlerId) {
    case 'addi': {
      const { result, overflow } = addSigned32WithOverflow(rs, signExtend16(immediate));
      return { value: result, overflow };
    }
    case 'addiu':
      return noOverflow(u32(rs) + u32(signExtend16(immediate)));
    case 'slti':
      return noOverflow(signedLessThan(rs, u32(signExtend16(immediate))) ? 1 : 0);
    case 'sltiu':
      // The immediate is sign-extended first and then compared as unsigned.
      return noOverflow(unsignedLessThan(rs, u32(signExtend16(immediate))) ? 1 : 0);
    case 'andi':
      return noOverflow(u32(rs) & zeroExtend16(immediate));
    case 'ori':
      return noOverflow(u32(rs) | zeroExtend16(immediate));
    case 'xori':
      return noOverflow(u32(rs) ^ zeroExtend16(immediate));
    case 'lui':
      return noOverflow(zeroExtend16(immediate) << 16);
    default:
      return undefined;
  }
}

/** Branch condition for every conditional branch handler. */
export function branchCondition(
  handlerId: string,
  rs: number,
  rt: number
): boolean | undefined {
  switch (handlerId) {
    case 'beq':
      return u32(rs) === u32(rt);
    case 'bne':
      return u32(rs) !== u32(rt);
    case 'blez':
      return s32(rs) <= 0;
    case 'bgtz':
      return s32(rs) > 0;
    case 'bltz':
    case 'bltzal':
      return s32(rs) < 0;
    case 'bgez':
    case 'bgezal':
      return s32(rs) >= 0;
    default:
      return undefined;
  }
}

/** Trap condition for the MIPS trap family (course-external; see transition.ts). */
export function trapCondition(
  handlerId: string,
  rs: number,
  rt: number
): boolean | undefined {
  switch (handlerId) {
    case 'tge':
      return !signedLessThan(rs, rt);
    case 'tgeu':
      return !unsignedLessThan(rs, rt);
    case 'tlt':
      return signedLessThan(rs, rt);
    case 'tltu':
      return unsignedLessThan(rs, rt);
    case 'teq':
      return u32(rs) === u32(rt);
    case 'tne':
      return u32(rs) !== u32(rt);
    default:
      return undefined;
  }
}

/** Immediate trap condition; the immediate is always sign-extended first. */
export function immediateTrapCondition(
  handlerId: string,
  rs: number,
  immediate: number
): boolean | undefined {
  const operand = u32(signExtend16(immediate));
  switch (handlerId) {
    case 'tgei':
      return !signedLessThan(rs, operand);
    case 'tgeiu':
      return !unsignedLessThan(rs, operand);
    case 'tlti':
      return signedLessThan(rs, operand);
    case 'tltiu':
      return unsignedLessThan(rs, operand);
    case 'teqi':
      return u32(rs) === operand;
    case 'tnei':
      return u32(rs) !== operand;
    default:
      return undefined;
  }
}

export interface HiLoOutcome {
  readonly hi: number;
  readonly lo: number;
}

/** Multiply/divide unit results. `div/divu` by zero must be rejected by the caller. */
export function multiplyDivide(
  handlerId: string,
  rs: number,
  rt: number,
  hi: number,
  lo: number
): HiLoOutcome | undefined {
  switch (handlerId) {
    case 'mult': {
      const product = multiplySigned64(rs, rt);
      return { hi: high32(product), lo: low32(product) };
    }
    case 'multu': {
      const product = multiplyUnsigned64(rs, rt);
      return { hi: high32(product), lo: low32(product) };
    }
    case 'div': {
      const { quotient, remainder } = divideSigned32(rs, rt);
      return { hi: u32(remainder), lo: u32(quotient) };
    }
    case 'divu': {
      const { quotient, remainder } = divideUnsigned32(rs, rt);
      return { hi: u32(remainder), lo: u32(quotient) };
    }
    case 'madd': {
      const sum = BigInt.asIntN(64, fromHalvesSigned(hi, lo) + multiplySigned64(rs, rt));
      return { hi: high32(sum), lo: low32(sum) };
    }
    case 'maddu': {
      const sum = BigInt.asUintN(64, fromHalves(hi, lo) + multiplyUnsigned64(rs, rt));
      return { hi: high32(sum), lo: low32(sum) };
    }
    case 'msub': {
      const difference = BigInt.asIntN(64, fromHalvesSigned(hi, lo) - multiplySigned64(rs, rt));
      return { hi: high32(difference), lo: low32(difference) };
    }
    case 'msubu': {
      const difference = BigInt.asUintN(64, fromHalves(hi, lo) - multiplyUnsigned64(rs, rt));
      return { hi: high32(difference), lo: low32(difference) };
    }
    default:
      return undefined;
  }
}

/** Signed interpretation of a HI:LO pair. */
function fromHalvesSigned(hi: number, lo: number): bigint {
  return BigInt.asIntN(64, fromHalves(hi, lo));
}

/**
 * `lwl` (little endian): the memory bytes at and below the aligned word fill the
 * high part of `rt`, keeping the low `24 - 8*byte` bits of the old `rt`.
 */
export function loadWordLeft(oldRt: number, memoryWord: number, address: number): number {
  const byte = u32(address) & 3;
  const shift = 24 - 8 * byte;
  const keepMask = shift === 0 ? 0 : u32((1 << shift) - 1);
  return u32((u32(memoryWord) << shift) | (u32(oldRt) & keepMask));
}

/** `lwr` (little endian): memory bytes fill the low part, keeping the high `8*byte` bits. */
export function loadWordRight(oldRt: number, memoryWord: number, address: number): number {
  const byte = u32(address) & 3;
  const shift = 8 * byte;
  const keepMask = shift === 0 ? 0 : u32(~((1 << (32 - shift)) - 1));
  return u32((u32(oldRt) & keepMask) | (u32(memoryWord) >>> shift));
}

export interface PartialStore {
  /** Value already positioned inside the aligned word. */
  readonly word: number;
  /** Byte enables inside the aligned word. */
  readonly byteMask: number;
}

/** `swl` (little endian): the high bytes of `rt` go into the low byte lanes. */
export function storeWordLeft(rt: number, address: number): PartialStore {
  const byte = u32(address) & 3;
  return {
    word: u32(u32(rt) >>> (24 - 8 * byte)),
    byteMask: (1 << (byte + 1)) - 1
  };
}

/** `swr` (little endian): the low bytes of `rt` go into the high byte lanes. */
export function storeWordRight(rt: number, address: number): PartialStore {
  const byte = u32(address) & 3;
  return {
    word: u32(u32(rt) << (8 * byte)),
    byteMask: (0b1111 << byte) & 0b1111
  };
}

function countLeadingZeros(value: number): number {
  let count = 0;
  for (let bit = 31; bit >= 0; bit--) {
    if ((u32(value) >>> bit) & 1) {
      break;
    }
    count++;
  }
  return count;
}
