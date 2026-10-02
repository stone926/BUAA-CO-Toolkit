// @index mips-core — Validated byte buffers for ordinary-MARS syscalls
import { MemoryBus, PreparedMemoryAccess } from '../machine/memoryBus';

export class SyscallMemoryError extends Error {
  constructor(readonly direction: 'load' | 'store', readonly address: number, message: string) { super(message); }
}

function access(memory: MemoryBus, kind: 'load' | 'store', address: number): PreparedMemoryAccess {
  if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff) {
    throw new SyscallMemoryError(kind, address >>> 0, 'Syscall buffer crosses the 32-bit address boundary');
  }
  const prepared = memory.prepare({ kind, address, width: 1 });
  if ('reason' in prepared) { throw new SyscallMemoryError(kind, address, prepared.message); }
  return prepared;
}

export function readBytes(memory: MemoryBus, address: number, length: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < length; i++) { result.push(memory.read(access(memory, 'load', address + i), false)); }
  return result;
}

/** Validate the whole buffer first: an invalid tail never leaves a partial write. */
export function writeBytes(memory: MemoryBus, address: number, bytes: readonly number[]): void {
  const prepared = bytes.map((_, i) => access(memory, 'store', address + i));
  for (let i = 0; i < bytes.length; i++) { memory.commit(prepared[i], bytes[i]); }
}

export function readCString(memory: MemoryBus, address: number, limit: number): string {
  const bytes: number[] = [];
  for (let i = 0; i < limit; i++) {
    const byte = memory.read(access(memory, 'load', address + i), false);
    if (byte === 0) { return new TextDecoder('utf-8').decode(Uint8Array.from(bytes)); }
    bytes.push(byte);
  }
  throw new Error(`NUL-terminated syscall string exceeds the ${limit}-byte limit`);
}

/** Match the shared assembler's UTF-8 string literals for ordinary console/file IO. */
export function stringBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}
