// @index mips-core — Ordinary MARS integer/console/file syscall preparation and completion
import { ProgramImage } from '../api';
import { RegisterWrite } from '../events/commitEvent';
import { MemoryBus } from '../machine/memoryBus';
import { MarsMemoryLayout } from '../profiles/marsMemoryLayout';
import { MarsIoRequest, MarsIoResponse } from './api';
import { MarsRandomStreams } from './random';
import { FloatingPointState } from './floatingPointState';
import { formatFloatingPoint, parseFloatingPoint } from './floatingPointText';
import { readBytes, readCString, stringBytes, writeBytes } from './syscallMemory';
import { marsMemoryCapacityBytes } from './profile';

export interface SyscallAction {
  readonly writes?: readonly RegisterWrite[];
  readonly exitCode?: number;
  readonly request?: MarsIoRequest;
  readonly commit?: () => void;
}

export class MarsSyscalls {
  private heap: number;
  private readonly random = new MarsRandomStreams();

  constructor(
    private readonly memory: MemoryBus,
    image: ProgramImage,
    private readonly layout: MarsMemoryLayout,
    private readonly limit: number,
    private readonly fpu: FloatingPointState
  ) {
    this.heap = layout.heapBase;
    for (const segment of image.segments) {
      if (segment.name === 'data') {
        this.heap = Math.max(this.heap, segment.baseAddress + segment.words.length * 4);
      }
    }
  }

  private length(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > this.limit) {
      throw new Error(`Syscall buffer length must be between 0 and ${this.limit}`);
    }
    return value;
  }

  prepare(service: number, args: readonly number[], id: number): SyscallAction {
    const [a0, a1, a2] = args;
    const base = { id, service };
    const print = (text: string): SyscallAction => ({ request: { ...base, kind: 'write', text } });
    switch (service) {
      case 1: return print(String(a0 | 0));
      case 2: return print(formatFloatingPoint(this.fpu.single(12), true));
      case 3: return print(formatFloatingPoint(this.fpu.double(12), false));
      case 4: return print(readCString(this.memory, a0, this.limit));
      case 5: return { request: { ...base, kind: 'read-int' } };
      case 6: return { request: { ...base, kind: 'read-float' } };
      case 7: return { request: { ...base, kind: 'read-double' } };
      case 8: {
        const size = a1 | 0;
        if (size <= 0) { return {}; }
        this.length(size);
        if (size === 1) { writeBytes(this.memory, a0, [0]); return {}; }
        return { request: { ...base, kind: 'read-string', maxLength: size - 1 } };
      }
      case 9: {
        const size = a0 | 0;
        const next = Math.ceil((this.heap + size) / 4) * 4;
        if (size < 0 || next >= Math.min(this.layout.sectionLayout.data.endInclusive, this.layout.dataSegmentBase + marsMemoryCapacityBytes)
          || next >= this.layout.stackPointer) {
          throw new Error('sbrk cannot allocate the requested heap size');
        }
        const address = this.heap;
        this.heap = next;
        return { writes: [{ register: 2, value: address }] };
      }
      case 10: return { exitCode: 0 };
      case 11: return print(String.fromCharCode(a0 & 0xff));
      case 12: return { request: { ...base, kind: 'read-char' } };
      case 13: return { request: { ...base, kind: 'open', path: readCString(this.memory, a0, this.limit), flags: a1 | 0 } };
      case 14: return { request: { ...base, kind: 'read-file', fd: a0 | 0, length: this.length(a2 | 0) } };
      case 15: return { request: { ...base, kind: 'write-file', fd: a0 | 0, bytes: readBytes(this.memory, a1, this.length(a2 | 0)) } };
      case 16: return { request: { ...base, kind: 'close', fd: a0 | 0 } };
      case 17: return { exitCode: a0 | 0 };
      case 30: return { request: { ...base, kind: 'time' } };
      case 32: return { request: { ...base, kind: 'sleep', milliseconds: Math.max(0, a0 | 0) } };
      case 34: return print(a0.toString(16).padStart(8, '0'));
      case 35: return print(a0.toString(2).padStart(32, '0'));
      case 36: return print(String(a0 >>> 0));
      case 40: this.random.seed(a0 | 0, a1 | 0); return {};
      case 41: return { writes: [{ register: 4, value: this.random.integer(a0 | 0) }] };
      case 42: return { writes: [{ register: 4, value: this.random.bounded(a0 | 0, a1 | 0) }] };
      case 43: {
        const writes = this.fpu.singleWrites(0, this.random.single(a0 | 0));
        return { commit: () => this.fpu.commit(writes) };
      }
      case 44: {
        const writes = this.fpu.doubleWrites(0, this.random.double(a0 | 0));
        return { commit: () => this.fpu.commit(writes) };
      }
      default: throw new Error(`Unsupported MARS syscall service ${service}`);
    }
  }

  complete(request: MarsIoRequest, args: readonly number[], response: MarsIoResponse): SyscallAction {
    if (response.id !== request.id) { throw new Error('Syscall response id does not match the pending request'); }
    if (response.error !== undefined) { throw new Error(response.error); }
    const result = (value: number): SyscallAction => ({ writes: [{ register: 2, value }] });
    switch (request.kind) {
      case 'read-float': case 'read-double': {
        const value = response.value ?? (response.text === undefined ? undefined : parseFloatingPoint(response.text));
        if (value === undefined || typeof value !== 'number') { throw new Error('Missing floating-point input'); }
        const writes = request.kind === 'read-float' ? this.fpu.singleWrites(0, value) : this.fpu.doubleWrites(0, value);
        return { commit: () => this.fpu.commit(writes) };
      }
      case 'read-int': {
        if (response.value !== undefined) { return result(signedInteger(response.value)); }
        const text = response.text?.trim();
        if (!text || !/^[+-]?\d+$/.test(text)) { throw new Error('Invalid integer input for syscall 5'); }
        return result(signedInteger(Number(text)));
      }
      case 'read-char': {
        const value = response.value ?? response.text?.charCodeAt(0);
        if (value === undefined || !Number.isInteger(value) || value < 0) {
          throw new Error('No character available for syscall 12');
        }
        return result(value);
      }
      case 'read-string': {
        if (typeof response.text !== 'string') { throw new Error('Missing string input for syscall 8'); }
        const bytes = stringBytes(response.text.slice(0, request.maxLength)).slice(0, request.maxLength);
        if (bytes.length < request.maxLength && bytes[bytes.length - 1] !== 10) { bytes.push(10); }
        writeBytes(this.memory, args[0], [...bytes, 0]);
        return {};
      }
      case 'open': case 'write-file':
        return result(signedInteger(requiredValue(response)));
      case 'read-file': {
        if (response.value !== undefined && response.value < 0) { return result(signedInteger(response.value)); }
        const bytes = response.bytes;
        if (!bytes || bytes.length > request.length
          || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
          throw new Error('Invalid file-read response buffer');
        }
        writeBytes(this.memory, args[1], bytes);
        return result(bytes.length);
      }
      case 'time': {
        const time = response.time;
        if (time === undefined || !Number.isSafeInteger(time) || time < 0) {
          throw new Error('Invalid epoch milliseconds returned for syscall 30');
        }
        return { writes: [{ register: 4, value: time >>> 0 }, { register: 5, value: Math.floor(time / 0x100000000) >>> 0 }] };
      }
      default: return {};
    }
  }
}

function signedInteger(value: number): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new Error('Syscall integer input is outside the signed 32-bit range');
  }
  return value;
}

function requiredValue(response: MarsIoResponse): number {
  if (response.value === undefined) { throw new Error('Missing syscall result value'); }
  return response.value;
}
