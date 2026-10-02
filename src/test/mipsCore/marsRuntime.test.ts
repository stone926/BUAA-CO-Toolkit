import { describe, expect, it } from 'vitest';
import { assembleMarsSource } from '../../mips/core/assembler/marsAssembler';
import { MarsIoRequest, MarsIoResponse } from '../../mips/core/mars/api';
import { MarsSession } from '../../mips/core/mars/session';
import { readBytes } from '../../mips/core/mars/syscallMemory';
import { MarsMemoryConfiguration } from '../../mips/core/profiles/marsMemoryLayout';
import { makeSession, op, textImage } from './programFixtures';

function session(text: string, options: { memoryConfiguration?: MarsMemoryConfiguration; delayedBranching?: boolean; maxSteps?: number; maxIoBytes?: number } = {}): MarsSession {
  const assembled = assembleMarsSource({ id: 'main', text }, { memoryConfiguration: options.memoryConfiguration });
  expect(assembled.diagnostics).toEqual([]);
  expect(assembled.image).toBeDefined();
  return new MarsSession({ image: assembled.image!, ...options });
}

function run(machine: MarsSession, respond: (request: MarsIoRequest) => Omit<MarsIoResponse, 'id'> = () => ({})) {
  const requests: MarsIoRequest[] = [];
  for (let i = 0; i < 1000; i++) {
    const result = machine.runSlice(128);
    if (result.status === 'waiting') {
      requests.push(result.request);
      const resumed = machine.resume({ id: result.request.id, ...respond(result.request) });
      if (resumed.status !== 'running') { return { result: resumed, requests }; }
    } else if (result.status !== 'running') { return { result, requests }; }
  }
  throw new Error('Test run did not terminate');
}

describe('ordinary MARS runtime on the shared machine', () => {
  it('executes Default text, sparse static data, heap, and high stack addresses', () => {
    const machine = session(`.data\nvalue: .word 42\n.text\nla $t0, value\nlw $t1, 0($t0)\naddiu $sp, $sp, -4\nsw $t1, 0($sp)\nli $a0, 8\nli $v0, 9\nsyscall\nmove $t2, $v0\nsw $t1, 0($t2)\nlw $a0, 0($sp)\nli $v0, 1\nsyscall\nli $v0, 10\nsyscall`);
    const { result, requests } = run(machine);
    expect(result).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(requests).toMatchObject([{ kind: 'write', text: '42' }]);
    expect(machine.machine.state.gpr.read(28)).toBe(0x10008000);
    expect(machine.machine.state.gpr.read(29)).toBe(0x7fffeff8);
    expect(machine.machine.state.gpr.read(10)).toBe(0x10040000);
    expect(machine.machine.memory.readDataWord(0x10040000)).toBe(42);
    expect(machine.snapshot('full').dataWords).toContainEqual({ address: 0x7fffeff8, value: 42 });
  });

  it('keeps course P7 syscall as an architectural exception for the same service number', () => {
    const course = makeSession('P7', [op('addiu', { rt: 2, rs: 0, immediate: 1 }), op('syscall')]);
    course.stepInstruction();
    const result = course.stepInstruction();
    expect(result.event?.trap).toMatchObject({ name: 'syscall', code: 8, epc: 0x3004, handlerPc: 0x4180 });
    expect(course.machine.state.cp0?.snapshot()).toMatchObject({ cause: 32, epc: 0x3004, status: 2 });
    expect(course.machine.state.pc).toBe(0x4180);
    const ordinary = run(session('li $v0, 1\nli $a0, 123\nsyscall\nli $v0, 10\nsyscall'));
    expect(ordinary.requests).toMatchObject([{ kind: 'write', text: '123' }]);
  });

  it('suspends exactly once and charges syscall commit only after its response', () => {
    const machine = session('li $v0, 5\nsyscall\nmove $a0, $v0\nli $v0, 1\nsyscall');
    const pending = machine.runSlice(20);
    expect(pending.status).toBe('waiting');
    if (pending.status !== 'waiting') { throw new Error('Expected pending read'); }
    const count = machine.instructionsExecuted;
    const pc = machine.machine.state.pc;
    expect(machine.step()).toEqual({ status: 'waiting', request: pending.request });
    expect(machine.instructionsExecuted).toBe(count);
    expect(machine.machine.state.pc).toBe(pc);
    expect(machine.resume({ id: pending.request.id, text: '-2147483648' })).toEqual({ status: 'running' });
    expect(machine.instructionsExecuted).toBe(count + 1);
    expect(machine.machine.state.gpr.read(2)).toBe(0x80000000);
    expect(run(machine).requests).toMatchObject([{ kind: 'write', text: '-2147483648' }]);
  });

  it('implements fgets truncation, newline, NUL, character input and numeric formats', () => {
    const machine = session(`.data\nbuf: .space 16\n.text\nla $a0, buf\nli $a1, 6\nli $v0, 8\nsyscall\nli $v0, 4\nsyscall\nli $v0, 12\nsyscall\nmove $a0, $v0\nli $v0, 11\nsyscall\nli $a0, -1\nli $v0, 34\nsyscall\nli $v0, 35\nsyscall\nli $v0, 36\nsyscall`);
    const { requests, result } = run(machine, (request) => request.kind === 'read-string' ? { text: 'abc' } : request.kind === 'read-char' ? { text: 'Z' } : {});
    expect(result.status).toBe('exited');
    expect(readBytes(machine.machine.memory, 0x10010000, 6)).toEqual([97, 98, 99, 10, 0, 0]);
    expect(requests.filter((request) => request.kind === 'write').map((request) => request.text)).toEqual(['abc\n', 'Z', 'ffffffff', '1'.repeat(32), '4294967295']);
  });

  it('truncates full read-string buffers without inserting an extra newline', () => {
    const machine = session('.data\nbuf: .space 4\n.text\nla $a0, buf\nli $a1, 4\nli $v0, 8\nsyscall');
    run(machine, () => ({ text: 'abcdef' }));
    expect(readBytes(machine.machine.memory, 0x10010000, 4)).toEqual([97, 98, 99, 0]);
  });

  it('uses opaque file descriptors and bounds byte transfers', () => {
    const machine = session(`.data\npath: .asciiz "input.txt"\nbuf: .space 8\n.text\nla $a0, path\nli $a1, 0\nli $v0, 13\nsyscall\nmove $s0, $v0\nmove $a0, $s0\nla $a1, buf\nli $a2, 4\nli $v0, 14\nsyscall\nmove $a2, $v0\nli $a0, 1\nli $v0, 15\nsyscall\nmove $a0, $s0\nli $v0, 16\nsyscall`);
    const { requests, result } = run(machine, (request) => {
      if (request.kind === 'open') { return { value: 3 }; }
      if (request.kind === 'read-file') { return { bytes: [65, 0, 255] }; }
      if (request.kind === 'write-file') { return { value: request.bytes.length }; }
      return {};
    });
    expect(result.status).toBe('exited');
    expect(requests).toMatchObject([
      { kind: 'open', path: 'input.txt', flags: 0 },
      { kind: 'read-file', fd: 3, length: 4 },
      { kind: 'write-file', fd: 1, bytes: [65, 0, 255] },
      { kind: 'close', fd: 3 }
    ]);
  });

  it('returns negative file errors and exit2 status', () => {
    const machine = session('.data\np: .asciiz "missing"\n.text\nla $a0, p\nli $v0, 13\nsyscall\nmove $a0, $v0\nli $v0, 17\nsyscall');
    expect(run(machine, () => ({ value: -1 })).result).toMatchObject({ status: 'exited', exitCode: -1 });
  });

  it('uses UTF-8 consistently for non-ASCII output, file paths and bounded string input', () => {
    const machine = session('.data\np: .asciiz "目录/输入 文件.txt"\n.align 2\nbuf: .space 8\n.text\nla $a0, p\nli $v0, 4\nsyscall\nli $v0, 13\nsyscall\nla $a0, buf\nli $a1, 5\nli $v0, 8\nsyscall\nli $v0, 4\nsyscall');
    const { requests, result } = run(machine, (request) => request.kind === 'open' ? { value: 3 } : request.kind === 'read-string' ? { text: '中a余' } : {});
    expect(result.status).toBe('exited');
    expect(requests).toMatchObject([
      { kind: 'write', text: '目录/输入 文件.txt' },
      { kind: 'open', path: '目录/输入 文件.txt' },
      { kind: 'read-string', maxLength: 4 },
      { kind: 'write', text: '中a' }
    ]);
    const dataAddress = machine.machine.state.gpr.read(4);
    expect(readBytes(machine.machine.memory, dataAddress, 6)).toEqual([0xe4, 0xb8, 0xad, 97, 0, 0]);
  });

  it('supports compact data and text memory configurations, including PC zero', () => {
    for (const memoryConfiguration of ['CompactDataAtZero', 'CompactTextAtZero'] as const) {
      const machine = session('li $a0, 7\nli $v0, 1\nsyscall', { memoryConfiguration });
      expect(machine.machine.state.pc).toBe(memoryConfiguration === 'CompactTextAtZero' ? 0 : 0x3000);
      expect(run(machine).requests).toMatchObject([{ kind: 'write', text: '7' }]);
    }
  });

  it('executes or skips branch delay slots according to ordinary MARS settings', () => {
    const text = 'li $a0, 1\nb target\nli $a0, 2\ntarget: li $v0, 1\nsyscall';
    expect(run(session(text)).requests).toMatchObject([{ text: '1' }]);
    expect(run(session(text, { delayedBranching: true })).requests).toMatchObject([{ text: '2' }]);
  });

  it('does not treat the course halt loop as ordinary program completion', () => {
    const machine = session('loop: beq $zero, $zero, loop\nnop', { maxSteps: 6 });
    const result = machine.runSlice(20);
    expect(result.status).toBe('step-limit');
    expect(machine.instructionsExecuted).toBe(6);
  });

  it('reports invalid integer, buffer limits, unknown services and overflow', () => {
    const invalid = run(session('li $v0, 5\nsyscall'), () => ({ text: '2147483648' })).result;
    expect(invalid).toMatchObject({ status: 'fault', diagnostic: { message: expect.stringContaining('signed 32-bit') } });
    expect(run(session('li $v0, 999\nsyscall')).result).toMatchObject({ status: 'fault', diagnostic: { message: 'Unsupported MARS syscall service 999' } });
    expect(run(session('.data\ns: .asciiz "abcdef"\n.text\nla $a0, s\nli $v0, 4\nsyscall', { maxIoBytes: 4 })).result.status).toBe('fault');
    expect(run(session('li $t0, 0x7fffffff\naddi $t1, $t0, 1')).result).toMatchObject({ status: 'fault', diagnostic: { code: 'mips-core.exec.ov' } });
  });

  it('never partly writes an invalid read-string target', () => {
    const machine = session('li $a0, 0x7fffffff\nli $a1, 4\nli $v0, 8\nsyscall');
    const { result } = run(machine, () => ({ text: 'ab' }));
    expect(result.status).toBe('fault');
    expect(machine.machine.memory.readDataWord(0x7ffffffc)).toBe(0);
  });

  it('matches seeded java.util.Random integer streams and splits epoch time', () => {
    const machine = session('li $a0, 1\nli $a1, 0\nli $v0, 40\nsyscall\nli $v0, 41\nsyscall\nmove $s0, $a0\nli $v0, 30\nsyscall');
    run(machine, () => ({ time: 0x123456789ab }));
    expect(machine.machine.state.gpr.read(16)).toBe((-1155484576) >>> 0);
    expect(machine.machine.state.gpr.read(4)).toBe(0x456789ab);
    expect(machine.machine.state.gpr.read(5)).toBe(0x123);
  });

  it('dispatches ordinary overflow to its kernel handler and returns through eret', () => {
    const machine = session('li $t0, 0x7fffffff\naddi $t1, $t0, 1\nli $a0, 7\nli $v0, 1\nsyscall\nli $v0, 10\nsyscall\n.ktext 0x80000180\nmfc0 $k0, $13\nsrl $s0, $k0, 2\nandi $s0, $s0, 31\nmfc0 $k1, $14\naddiu $k1, $k1, 4\nmtc0 $k1, $14\neret');
    const { result, requests } = run(machine);
    expect(result.status).toBe('exited');
    expect(requests).toMatchObject([{ kind: 'write', text: '7' }]);
    expect(machine.machine.state.gpr.read(16)).toBe(12);
    expect(machine.machine.state.gpr.read(9)).toBe(0);
    expect(machine.machine.state.cp0?.exceptionLevel).toBe(false);
    expect(machine.machine.state.cp0?.status).toBe(0xff11);
  });

  it('records ordinary unmapped addresses and fails cleanly when no handler is loaded', () => {
    const machine = session('lui $t0, 0x4000\nlw $t1, 0($t0)');
    const result = machine.runSlice(20);
    expect(result).toMatchObject({ status: 'fault', diagnostic: { code: 'mips-core.exec.adel' } });
    expect(machine.machine.state.cp0?.snapshot()).toMatchObject({ badVaddr: 0x40000000, cause: 16, epc: 0x400004 });
    expect(machine.machine.state.gpr.read(9)).toBe(0);
    expect(machine.done).toBe(true);
  });

  it('rejects heap requests beyond MARS Default segment storage capacity', () => {
    const machine = session('li $a0, 0x400000\nli $v0, 9\nsyscall');
    expect(run(machine).result).toMatchObject({ status: 'fault', diagnostic: { message: expect.stringContaining('sbrk') } });
  });

  it('commits a resumed service syscall in a branch delay slot before transferring', () => {
    const machine = session('li $v0, 5\nb target\nsyscall\ntarget: move $a0, $v0\nli $v0, 1\nsyscall', { delayedBranching: true });
    const { result, requests } = run(machine, (request) => request.kind === 'read-int' ? { text: '19' } : {});
    expect(result.status).toBe('exited');
    expect(requests).toMatchObject([{ kind: 'read-int' }, { kind: 'write', text: '19' }]);
  });

  it('preserves HI/LO and continues after raw signed and unsigned division by zero', () => {
    const words = [
      op('addiu', { rt: 8, rs: 0, immediate: -21 }), op('mtlo', { rs: 8 }),
      op('addiu', { rt: 9, rs: 0, immediate: 9 }), op('mthi', { rs: 9 }),
      op('div', { rs: 8, rt: 0 }), op('divu', { rs: 8, rt: 0 }),
      op('mflo', { rd: 10 }), op('mfhi', { rd: 11 }),
      op('addiu', { rt: 16, rs: 0, immediate: 1 })
    ];
    const ordinary = new MarsSession({ image: textImage(words, { base: 0x400000 }) });
    expect(ordinary.runSlice(30).status).toBe('exited');
    expect(ordinary.machine.state.gpr.read(10)).toBe((-21) >>> 0);
    expect(ordinary.machine.state.gpr.read(11)).toBe(9);
    expect(ordinary.machine.state.gpr.read(16)).toBe(1);
    expect(ordinary.snapshot()).toMatchObject({ hi: 9, lo: (-21) >>> 0, hiDefined: true, loDefined: true });
    const course = makeSession('P7', words);
    expect(course.machine.runSlice(30)).toMatchObject({ status: 'out-of-domain', diagnostic: { reason: 'divide-by-zero' } });
    expect(course.machine.state.gpr.read(16)).toBe(0);
  });

  it('defines MARS MUL HI/LO while retaining course MUL undefined-state behavior', () => {
    const words = [
      op('lui', { rt: 8, immediate: 0x8000 }), op('addiu', { rt: 9, rs: 0, immediate: 2 }),
      op('mul', { rd: 10, rs: 8, rt: 9 }), op('mfhi', { rd: 16 }), op('mflo', { rd: 17 })
    ];
    const ordinary = new MarsSession({ image: textImage(words, { base: 0x400000 }) });
    expect(ordinary.runSlice(30).status).toBe('exited');
    expect(ordinary.machine.state.gpr.read(16)).toBe(0xffffffff);
    expect(ordinary.machine.state.gpr.read(17)).toBe(0);
    expect(ordinary.snapshot()).toMatchObject({ hi: 0xffffffff, lo: 0, hiDefined: true, loDefined: true });
    const course = makeSession('P7', words, { layers: ['required', 'commonExtensions', 'marsCompatibility'] });
    expect(course.machine.runSlice(30)).toMatchObject({ status: 'out-of-domain', diagnostic: { reason: 'undefined-hi-lo-read' } });
    expect(course.machine.snapshot()).toMatchObject({ hiDefined: false, loDefined: false });
  });
});
