// @index mips-core — Bounded debugger command validation independent of transport and UI
import type { DebugCommand, DebugMemoryRequest } from './api';

export function isDebugRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function requireDebugKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unknown debugger command field');
}
export function requireDebugAddress(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff || (value as number) % 4 !== 0) {
    throw new Error('Debugger address must be an aligned unsigned 32-bit address');
  }
  return value as number;
}
export function parseDebugMemory(value: DebugMemoryRequest): { address: number; words: number } {
  const address = requireDebugAddress(value.address);
  const words = value.words ?? 64;
  if (!Number.isInteger(words) || words < 1 || words > 256 || address + words * 4 > 0x1_0000_0000) {
    throw new Error('Debugger memory page requires 1..256 words without address wraparound');
  }
  return { address, words };
}
export function parseDebugBreakpoints(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error('Debugger permits at most 4096 breakpoints');
  return [...new Set(value.map(requireDebugAddress))].sort((a, b) => a - b);
}
export function parseDebugCommand(value: unknown): DebugCommand {
  if (!isDebugRecord(value)) throw new Error('Debugger response must be a command object');
  switch (value.kind) {
    case 'step': case 'continue': case 'pause': case 'stop':
      requireDebugKeys(value, ['kind']);
      return { kind: value.kind };
    case 'memory':
      requireDebugKeys(value, ['kind', 'address', 'words']);
      return { kind: 'memory', ...parseDebugMemory(value as unknown as DebugMemoryRequest) };
    case 'set-breakpoints':
      requireDebugKeys(value, ['kind', 'addresses']);
      return { kind: 'set-breakpoints', addresses: parseDebugBreakpoints(value.addresses) };
    default: throw new Error('Unknown debugger command');
  }
}
