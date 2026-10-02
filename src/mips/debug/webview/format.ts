// @index mips-debug — Workbench numeric, memory byte and address formatting without DOM dependencies
export type Radix = 'hex' | 'decimal';
export function hex(value: number): string { return `0x${(value >>> 0).toString(16).padStart(8, '0')}`; }
export function formatValue(value: number, radix: Radix): string { return radix === 'hex' ? hex(value) : String(value | 0); }
export function bytes(value?: number): string {
  if (value === undefined) return '·· ·· ·· ··';
  return [0, 8, 16, 24].map(shift => ((value >>> shift) & 255).toString(16).padStart(2, '0')).join(' ');
}
export function ascii(value?: number): string {
  if (value === undefined) return '····';
  return [0, 8, 16, 24].map(shift => {
    const byte = (value >>> shift) & 255;
    return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '·';
  }).join('');
}
export function parseAddress(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^(?:0x[\da-f]+|\d+)$/i.test(trimmed)) return undefined;
  const address = Number(trimmed);
  return Number.isSafeInteger(address) && address >= 0 && address <= 0xffffffff && address % 4 === 0 ? address : undefined;
}
