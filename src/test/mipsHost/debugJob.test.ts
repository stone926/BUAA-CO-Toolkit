import { describe, expect, it } from 'vitest';
import { executeProductionWorkerJob } from '../../mips/host/workerJobs';
import { assembleMarsSource } from '../../mips/core/assembler/marsAssembler';
import type { DebugSnapshot } from '../../mips/core/debug/api';
import { parseDebugRequest } from '../../mips/host/debugJob';

function image(text = 'nop') { return assembleMarsSource({ id: 'main', text }).image!; }
describe('debug worker job', () => {
  it('exchanges pause, breakpoint, step and terminal memory commands with backpressure', async () => {
    const snapshots: DebugSnapshot[] = [];
    const commands = [{ kind: 'set-breakpoints', addresses: [0x400000] }, { kind: 'continue' }, { kind: 'step' }, { kind: 'continue' },
      { kind: 'memory', address: 0x10010000, words: 1 }, { kind: 'stop' }];
    const result = await executeProductionWorkerJob('mars-debug', { image: image('.data\nx: .word 42\n.text\nnop'), mode: { kind: 'mars' } }, {
      signal: new AbortController().signal,
      emitProgress(batch) { const progress = batch[0] as { kind: string; snapshot: DebugSnapshot }; expect(progress.kind).toBe('mars-debug'); snapshots.push(progress.snapshot); return commands.shift(); },
      yieldControl: async () => undefined
    });
    expect(snapshots.map(snapshot => snapshot.status)).toEqual(['paused', 'paused', 'paused', 'paused', 'exited', 'exited']);
    expect(snapshots[2]).toMatchObject({ reason: 'breakpoint', instructions: 0 });
    expect(snapshots[3]).toMatchObject({ reason: 'step', instructions: 1 });
    expect(snapshots[5].memory.words[0].value).toBe(42);
    expect(result).toMatchObject({ status: 'stopped', instructions: 1 });
  });
  it('reuses mars-io progress and input resumes the pending single step', async () => {
    let steps = 0;
    let ioRequests = 0;
    const result = await executeProductionWorkerJob('mars-debug', { image: image('li $v0, 5\nsyscall\naddiu $t0, $zero, 3'), mode: { kind: 'mars' } }, {
      signal: new AbortController().signal,
      emitProgress(batch) {
        const progress = batch[0] as { kind: string; request: { id: number }; snapshot: DebugSnapshot };
        if (progress.kind === 'mars-io') { ioRequests++; return { id: progress.request.id, text: '42' }; }
        if (steps++ < 2) return { kind: 'step' };
        expect(progress.snapshot).toMatchObject({ instructions: 2, status: 'paused', reason: 'step', pc: 0x400008 });
        expect(progress.snapshot.gpr[2]).toBe(42);
        expect(progress.snapshot.gpr[8]).toBe(0);
        return { kind: 'stop' };
      }, yieldControl: async () => undefined
    });
    expect(result).toMatchObject({ status: 'stopped' });
    expect(ioRequests).toBe(1);
  });
  it('cancel during a paused progress waiter produces no further machine execution', async () => {
    const abort = new AbortController();
    await expect(executeProductionWorkerJob('mars-debug', { image: image(), mode: { kind: 'mars' } }, {
      signal: abort.signal,
      emitProgress() { abort.abort(); return undefined; }
    })).rejects.toThrow('cancelled');
  });
  it('requires explicit known mode and bounded commands and image bytes', () => {
    for (const payload of [{ image: image() }, { image: image(), mode: { kind: 'course', profile: 'P2' } },
      { image: image(), mode: { kind: 'mars' }, maxSteps: 0 }, { image: image(), mode: { kind: 'mars', delayedBranching: 1 } },
      { image: image(), mode: { kind: 'mars' }, memory: { address: 0, words: 1000 } }]) expect(() => parseDebugRequest(payload)).toThrow();
  });
});
