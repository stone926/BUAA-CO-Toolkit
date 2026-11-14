// @index mips-core — Fixed-width arithmetic helpers exposed by the custom instruction SDK
export { u32, s32, addSigned32WithOverflow as addSigned32, subSigned32WithOverflow as subtractSigned32 } from '../values';

function checkedWidth(width: number): void {
  if (!Number.isInteger(width) || width < 1 || width > 32) throw new Error('Bit width must be in 1..32');
}
export function zeroExtend(value: number, width: number): number {
  checkedWidth(width); return width === 32 ? value >>> 0 : (value & (2 ** width - 1)) >>> 0;
}
export function signExtend(value: number, width: number): number {
  checkedWidth(width); const bits = zeroExtend(value, width); return width === 32 ? bits | 0 : bits >= 2 ** (width - 1) ? bits - 2 ** width : bits;
}
export function oneExtend(value: number, width: number): number {
  checkedWidth(width); return width === 32 ? value >>> 0 : (zeroExtend(value, width) | ~(2 ** width - 1)) >>> 0;
}
