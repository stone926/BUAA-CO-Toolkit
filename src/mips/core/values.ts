// @index mips-core — 32/64 位值边界 helper 与固定宽度 hex 格式化（纯 TS，无宿主依赖）

/**
 * 32 位值在生产核心中用 `number` 表示，每次边界显式归一化；乘除 64 位值用
 * BigInt.asUintN/asIntN。本模块是唯一的位宽语义入口，避免散落各处的
 * `>>>0`/`|0` 行为漂移（计划第 5.3 节）。
 */

/** Unsigned 32-bit normalization. */
export function u32(value: number): number {
  return value >>> 0;
}

/** Signed 32-bit interpretation of a u32 bit pattern. */
export function s32(value: number): number {
  return value | 0;
}

/** Sign-extend a 16-bit immediate taken from the low 16 bits of `value`. */
export function signExtend16(value: number): number {
  return (value << 16) >> 16;
}

/** Zero-extend the low 16 bits. */
export function zeroExtend16(value: number): number {
  return value & 0xffff;
}

/** Format a u32 as a fixed 8-digit hex string (no 0x prefix). */
export function hex8(value: number): string {
  return u32(value).toString(16).padStart(8, '0');
}

/** Format a u32 as `0x` + 8-digit hex (log/display form). */
export function hex8Address(value: number): string {
  return `0x${hex8(value)}`;
}

/** 64-bit signed multiply of two u32 bit patterns, as BigInt in [-2^63, 2^63). */
export function multiplySigned64(left: number, right: number): bigint {
  return BigInt.asIntN(64, BigInt(s32(left)) * BigInt(s32(right)));
}

/** 64-bit unsigned multiply of two u32 values. */
export function multiplyUnsigned64(left: number, right: number): bigint {
  return BigInt.asUintN(64, BigInt(u32(left)) * BigInt(u32(right)));
}

/** Signed 32-bit division: returns { quotient, remainder } with truncated semantics. */
export function divideSigned32(left: number, right: number): { quotient: number; remainder: number } {
  const lhs = s32(left);
  const rhs = s32(right);
  return { quotient: (lhs / rhs) | 0, remainder: lhs % rhs };
}

/** Unsigned 32-bit division: returns { quotient, remainder }. */
export function divideUnsigned32(left: number, right: number): { quotient: number; remainder: number } {
  const lhs = u32(left);
  const rhs = u32(right);
  return { quotient: Math.floor(lhs / rhs), remainder: lhs % rhs };
}

/** High 32 bits of a 64-bit BigInt. */
export function high32(value: bigint): number {
  return Number(BigInt.asUintN(64, value) >> 32n) >>> 0;
}

/** Low 32 bits of a 64-bit BigInt. */
export function low32(value: bigint): number {
  return Number(BigInt.asUintN(64, value) & 0xffffffffn) >>> 0;
}

/** Compose a 64-bit BigInt from high and low u32 halves. */
export function fromHalves(high: number, low: number): bigint {
  return (BigInt(u32(high)) << 32n) | BigInt(u32(low));
}

/** 32-bit signed comparison of two u32 bit patterns. */
export function signedLessThan(left: number, right: number): boolean {
  return s32(left) < s32(right);
}

/** 32-bit unsigned comparison of two u32 bit patterns. */
export function unsignedLessThan(left: number, right: number): boolean {
  return u32(left) < u32(right);
}

/** Signed 32-bit addition with overflow flag (Ov for add/addi/sub per COURSE-P7-EXC-015). */
export function addSigned32WithOverflow(left: number, right: number): { result: number; overflow: boolean } {
  const lhs = s32(left);
  const rhs = s32(right);
  const sum = lhs + rhs;
  return {
    result: u32(sum),
    overflow: sum < -0x80000000 || sum > 0x7fffffff
  };
}

/** Signed 32-bit subtraction with overflow flag. */
export function subSigned32WithOverflow(left: number, right: number): { result: number; overflow: boolean } {
  const lhs = s32(left);
  const rhs = s32(right);
  const difference = lhs - rhs;
  return {
    result: u32(difference),
    overflow: difference < -0x80000000 || difference > 0x7fffffff
  };
}
