import { describe, expect, it } from 'vitest';
import { assembleMarsSource } from '../../mips/core/assembler/marsAssembler';
import { DebugSession } from '../../mips/core/debug/session';
import { DebugListing } from '../../mips/core/debug/listing';
import { parseDebugCommand } from '../../mips/core/debug/validation';
import { op, textImage } from './programFixtures';

function ordinary(text: string, delayedBranching = false): DebugSession {
  const result = assembleMarsSource({ id: 'main', text }, { delayedBranching });
  expect(result.diagnostics).toEqual([]);
  return new DebugSession({ image: result.image!, mode: { kind: 'mars', delayedBranching } });
}
function step(session: DebugSession): void { session.command({ kind: 'step' }); session.advance(); }

describe('interactive architectural debug session', () => {
  it('starts paused and stops before breakpoints; continue skips only the just-hit visit', () => {
    const session = ordinary('loop: addiu $t0, $t0, 1\nj loop\nnop');
    expect(session.snapshot()).toMatchObject({ status: 'paused', reason: 'entry', instructions: 0 });
    session.command({ kind: 'set-breakpoints', addresses: [0x400000] });
    session.command({ kind: 'continue' }); session.advance();
    expect(session.snapshot()).toMatchObject({ reason: 'breakpoint', instructions: 0, pc: 0x400000 });
    session.command({ kind: 'continue' }); session.advance();
    expect(session.snapshot()).toMatchObject({ reason: 'breakpoint', instructions: 2, pc: 0x400000 });
    expect(session.snapshot().gpr[8]).toBe(1);
    step(session);
    expect(session.snapshot()).toMatchObject({ status: 'paused', reason: 'step', instructions: 3, pc: 0x400004 });
    expect(session.snapshot().gpr[8]).toBe(2);
  });
  it('steps branch and delay-slot independently and preserves pending branch state', () => {
    const session = ordinary('beq $zero, $zero, target\naddiu $t0, $zero, 7\naddiu $t0, $zero, 9\ntarget: nop', true);
    step(session);
    expect(session.snapshot()).toMatchObject({ pc: 0x400004, instructions: 1, pendingBranch: { originPc: 0x400000, targetPc: 0x40000c } });
    expect(session.snapshot().gpr[8]).toBe(0);
    step(session);
    expect(session.snapshot()).toMatchObject({ pc: 0x40000c, instructions: 2 });
    expect(session.snapshot().pendingBranch).toBeUndefined();
    expect(session.snapshot().gpr[8]).toBe(7);
  });
  it('suspends a single syscall step until host input commits exactly one instruction', () => {
    const session = ordinary('li $v0, 5\nsyscall\naddiu $t0, $zero, 9');
    step(session);
    session.command({ kind: 'step' });
    const request = session.advance()!;
    expect(request).toMatchObject({ kind: 'read-int' });
    expect(session.snapshot()).toMatchObject({ instructions: 1, pc: 0x400004 });
    expect(session.advance()).toEqual(request);
    session.resume({ id: request.id, text: '42' });
    expect(session.snapshot()).toMatchObject({ status: 'paused', reason: 'step', instructions: 2, pc: 0x400008 });
    expect(session.snapshot().gpr[2]).toBe(42);
    expect(session.snapshot().gpr[8]).toBe(0);
  });
  it('course P7 syscall preserves v0 and enters 0x4180 with ExcCode=8 and no IO', () => {
    const session = new DebugSession({ image: textImage([op('ori', { rt: 2, immediate: 5 }), op('syscall')], { kernelWords: [0] }), mode: { kind: 'course', profile: 'P7' } });
    step(session);
    session.command({ kind: 'step' });
    expect(session.advance()).toBeUndefined();
    expect(session.snapshot()).toMatchObject({ pc: 0x4180, instructions: 2, status: 'paused', cp0: { cause: 8 << 2, epc: 0x3004, status: 2 } });
    expect(session.snapshot().gpr[2]).toBe(5);
  });
  it('distinguishes zero memory from unavailable words and preserves inspection after exit', () => {
    const session = ordinary('.data\nx: .word 42\n.text\nnop');
    session.command({ kind: 'memory', address: 0x10010000, words: 2 });
    expect(session.snapshot().memory.words).toEqual([{ address: 0x10010000, value: 42 }, { address: 0x10010004, value: 0 }]);
    session.command({ kind: 'continue' }); session.advance();
    expect(session.snapshot().status).toBe('exited');
    session.command({ kind: 'memory', address: 0x20000000, words: 1 });
    expect(session.snapshot().memory.words[0]).toMatchObject({ unavailable: expect.any(String) });
    session.command({ kind: 'stop' });
    expect(session.snapshot().status).toBe('stopped');
  });
  it('bounded slices allow pausing an infinite program and the global budget stops it', () => {
    const session = new DebugSession({ image: textImage([op('ori', { rt: 8, immediate: 1 }), op('beq', { immediate: -2 }), 0]), mode: { kind: 'course', profile: 'P5' }, maxSteps: 5 });
    session.command({ kind: 'continue' }); session.advance(2);
    expect(session.snapshot()).toMatchObject({ status: 'running', instructions: 2 });
    session.command({ kind: 'pause' }); session.advance();
    expect(session.snapshot()).toMatchObject({ status: 'paused', instructions: 2 });
    session.command({ kind: 'continue' }); session.advance();
    expect(session.snapshot()).toMatchObject({ status: 'step-limit', instructions: 5 });
  });
  it('reports malformed commands and wrapped/unbounded inspection requests', () => {
    for (const command of [{ kind: 'step', extra: true }, { kind: 'memory', address: -4 }, { kind: 'memory', address: 0xfffffffc, words: 2 },
      { kind: 'memory', address: 0, words: 257 }, { kind: 'set-breakpoints', addresses: [0x3001] }]) expect(() => parseDebugCommand(command)).toThrow();
  });
});

describe('debug listing', () => {
  it('pages pseudo expansions with source origins and decodes real integer and COP1 operands', () => {
    const unit = { id: 'main', text: '.text\r\nli $t0, 0x12345678\r\nmtc1 $t0, $f2\r\nadd.s $f4, $f2, $f2\r\nbc1t next\r\nnext: nop' };
    const result = assembleMarsSource(unit);
    expect(result.diagnostics).toEqual([]);
    const listing = new DebugListing(result.image!, [unit], { kind: 'mars' });
    expect(listing.count).toBe(6);
    expect(listing.page(0, 2)).toMatchObject([{ instruction: 'lui $at, 4660', source: { line: 2, text: 'li $t0, 0x12345678' } },
      { instruction: 'ori $t0, $at, 22136', source: { line: 2 } }]);
    expect(listing.page(2).map(row => row.instruction)).toEqual(['mtc1 $t0, $f2', 'add.s $f4, $f2, $f2', 'bc1t 0, 0x00400014', 'nop']);
    expect(listing.indexOfAddress(0x400008)).toBe(2);
    expect(listing.indexOfAddress(0x400009)).toBe(-1);
    expect(() => listing.page(0, 257)).toThrow();
    expect(listing.page(listing.count)).toEqual([]);
  });
});
