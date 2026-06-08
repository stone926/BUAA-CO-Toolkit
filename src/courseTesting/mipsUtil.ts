export function signed32(value: number): number {
  return value | 0;
}

export function unsigned32(value: number): number {
  return value >>> 0;
}

export function signExtend8(value: number): number {
  return (value << 24) >> 24;
}

export function signExtend16(value: number): number {
  return (value << 16) >> 16;
}

export function clz32(value: number): number {
  return Math.clz32(value);
}

export function clo32(value: number): number {
  return Math.clz32(~value >>> 0);
}

export function formatImmediate(value: number): string {
  if (value < 0) {
    return String(value);
  }
  return value > 9 ? `0x${value.toString(16)}` : String(value);
}

export function formatUnsignedImmediate(value: number): string {
  return value > 9 ? `0x${(value & 0xffff).toString(16)}` : String(value);
}

export function alignDown(value: number, alignment: number): number {
  return Math.floor(value / alignment) * alignment;
}
