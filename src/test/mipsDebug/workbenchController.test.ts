import { describe, expect, it, vi } from 'vitest';
import { MarsWorkbenchController } from '../../mips/debug/controller';
import type { WorkbenchState } from '../../mips/debug/protocol';
import type { MarsRuntimeHost } from '../../mips/host/marsService';
import { executeProductionWorkerJob } from '../../mips/host/workerJobs';
import type { WorkerJob } from '../../mips/host/workerProtocol';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Controller state did not settle');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
function fixture(text: string) {
  const jobs: { kind: WorkerJob['kind']; signal?: AbortSignal; finished: boolean }[] = [];
  const states: WorkbenchState[] = [];
  const capture = vi.fn(async () => ({ sources: [{ id: 'main', text }], includes: [] }));
  const runtime: MarsRuntimeHost = {
    async runJob(job, options = {}) {
      const tracked = { kind: job.kind, signal: options.signal, finished: false };
      jobs.push(tracked);
      try {
        const payload = await executeProductionWorkerJob(job.kind, job.payload, {
          signal: options.signal ?? new AbortController().signal,
          async emitProgress(batch) {
            if (options.signal?.aborted) return undefined;
            let abort: () => void = () => undefined;
            try {
              return await Promise.race([Promise.resolve(options.onProgress?.(batch)), new Promise<undefined>(resolve => {
                abort = () => resolve(undefined); options.signal?.addEventListener('abort', abort, { once: true });
                if (options.signal?.aborted) abort();
              })]);
            } finally { options.signal?.removeEventListener('abort', abort); }
          }
        });
        return { protocolVersion: 2, kind: 'result', requestId: `test-${jobs.length}`, ok: true, payload };
      } catch (error) {
        return { protocolVersion: 2, kind: 'result', requestId: `test-${jobs.length}`, ok: false,
          error: error instanceof Error ? error.message : String(error), ...(options.signal?.aborted ? { cancelled: true as const } : {}) };
      } finally { tracked.finished = true; }
    }
  };
  const controller = new MarsWorkbenchController({ sourcePath: 'E:\\课程 目录\\程序.asm', mode: { kind: 'mars' }, ordinaryMode: { kind: 'mars' },
    runtime, capture, changed: state => states.push(state), diagnostics: () => undefined });
  return { controller, jobs, states, capture };
}
function gpr(state: WorkbenchState, index: number): number | undefined { return state.registers.find(item => item.detail === `$${index}`)?.value; }

describe('workbench controller with the real production job executor', () => {
  it('keeps faulted machine memory inspectable but disables inspection after Stop or assembly failure', async () => {
    const { controller, jobs, capture } = fixture('.data\nx: .word 42\n.space 252\ny: .word 77\n.text\nlw $t0, 1($zero)');
    try {
      expect(controller.state.memoryAvailable).toBe(false);
      await controller.assemble(); await until(() => controller.state.status === 'paused');
      await controller.handle({ type: 'run' }); await until(() => controller.state.status === 'error');
      expect(controller.state.memoryAvailable).toBe(true);
      await controller.handle({ type: 'memory', address: 0x10010100 });
      await until(() => controller.state.memoryAddress === 0x10010100);
      expect(controller.state.memory[0]?.value).toBe(77);
      expect(controller.state.status).toBe('error');
      await controller.handle({ type: 'stop' });
      expect(controller.state.memoryAvailable).toBe(false);
      capture.mockResolvedValueOnce({ sources: [{ id: 'main', text: 'invalid_instruction' }], includes: [] });
      await controller.assemble();
      expect(controller.state.status).toBe('error');
      expect(controller.state.memoryAvailable).toBe(false);
    } finally { controller.dispose(); await until(() => jobs.every(job => job.finished)); }
  });
  it('shows the exact waiting syscall PC and registers after continuous execution', async () => {
    const { controller, jobs } = fixture('li $t0, 31\nli $v0, 5\nsyscall\n');
    try {
      await controller.assemble(); await until(() => controller.state.status === 'paused');
      await controller.handle({ type: 'run' }); await until(() => controller.state.status === 'input');
      expect(controller.state.pc).toBe(0x400008);
      expect(controller.state.steps).toBe(2);
      expect(gpr(controller.state, 8)).toBe(31);
      expect(gpr(controller.state, 2)).toBe(5);
    } finally { controller.dispose(); await until(() => jobs.every(job => job.finished)); }
  });
  it('single-steps input syscall and keeps terminal memory inspection live', async () => {
    const fixtureState = fixture('.data\nx: .word 42\n.text\nli $v0, 5\nsyscall\nli $v0, 10\nsyscall');
    const { controller, jobs } = fixtureState;
    try {
      await controller.assemble(); await until(() => controller.state.status === 'paused');
      await controller.handle({ type: 'step' }); await until(() => controller.state.steps === 1 && controller.state.status === 'paused');
      await controller.handle({ type: 'step' }); await until(() => controller.state.status === 'input');
      expect(controller.state.steps).toBe(1);
      await controller.handle({ type: 'input', text: '99' });
      await until(() => controller.state.steps === 2 && controller.state.status === 'paused');
      expect(gpr(controller.state, 2)).toBe(99);
      expect(controller.state.pc).toBe(0x400008);
      await controller.handle({ type: 'run' }); await until(() => controller.state.status === 'exited');
      expect(jobs.find(job => job.kind === 'mars-debug')?.finished).toBe(false);
      await controller.handle({ type: 'memory', address: 0x10010000 });
      await until(() => controller.state.memoryAddress === 0x10010000 && controller.state.memory[0]?.value === 42);
      expect(controller.state.status).toBe('exited');
    } finally { controller.dispose(); await until(() => jobs.every(job => job.finished)); }
  });
  it('EOF remains EOF on repeated stdin file reads until reset starts a fresh session', async () => {
    const { controller, jobs } = fixture('.data\nbuf: .space 4\n.text\nli $v0, 14\nli $a0, 0\nla $a1, buf\nli $a2, 1\nsyscall\nli $v0, 14\nsyscall\nli $v0, 10\nsyscall');
    try {
      await controller.assemble(); await until(() => controller.state.status === 'paused');
      await controller.handle({ type: 'run' }); await until(() => controller.state.status === 'input');
      await controller.handle({ type: 'eof' }); await until(() => controller.state.status === 'exited');
      await controller.handle({ type: 'reset' }); await until(() => controller.state.status === 'paused' && controller.state.steps === 0);
      await controller.handle({ type: 'run' }); await until(() => controller.state.status === 'input');
    } finally { controller.dispose(); await until(() => jobs.every(job => job.finished)); }
  });
  it('keeps input and prompt live while switching memory pages and regions before submitting once', async () => {
    const { controller, jobs, states } = fixture('.data\nx: .word 42\n.space 252\ny: .word 77\n.text\nli $v0, 5\nsyscall\naddiu $t0, $zero, 7\nli $v0, 10\nsyscall');
    try {
      await controller.assemble(); await until(() => controller.state.status === 'paused');
      await controller.handle({ type: 'run' }); await until(() => controller.state.status === 'input');
      const { pc, steps, inputPrompt } = controller.state;
      const start = states.length;
      for (const address of [0x10010100, 0x7fffeffc, 0x400000, 0x10010000]) {
        await controller.handle({ type: 'memory', address });
        await until(() => controller.state.memoryAddress === address);
        expect(controller.state).toMatchObject({ status: 'input', pc, steps, inputPrompt });
      }
      expect(controller.state.memory[0]?.value).toBe(42);
      await controller.handle({ type: 'breakpoint', address: 0x400008 });
      await controller.handle({ type: 'memory', address: 0x10010100 });
      await until(() => controller.state.memoryAddress === 0x10010100);
      expect(controller.state.memory[0]?.value).toBe(77);
      for (const state of states.slice(start)) expect(state).toMatchObject({ status: 'input', pc, steps, inputPrompt });
      await controller.handle({ type: 'input', text: '23' });
      await until(() => controller.state.status === 'paused' && controller.state.pc === 0x400008);
      expect(controller.state.steps).toBe(2);
      expect(gpr(controller.state, 2)).toBe(23);
      expect(gpr(controller.state, 8)).toBe(0);
      expect(controller.state.console).toBe('23\n');
      expect(controller.state.inputPrompt).toBeUndefined();
    } finally { controller.dispose(); await until(() => jobs.every(job => job.finished)); }
  });
  it('reset during input cancels the old generation and queued breakpoints apply before resuming', async () => {
    const { controller, jobs } = fixture('li $v0, 5\nsyscall\naddiu $t0, $zero, 7\nli $v0, 10\nsyscall');
    try {
      await controller.assemble(); await until(() => controller.state.status === 'paused');
      await controller.handle({ type: 'run' }); await until(() => controller.state.status === 'input');
      await controller.handle({ type: 'reset' }); await until(() => controller.state.status === 'paused' && controller.state.steps === 0);
      expect(jobs.filter(job => job.kind === 'mars-debug')).toHaveLength(2);
      expect(jobs.find(job => job.kind === 'mars-debug')!.signal!.aborted).toBe(true);
      await controller.handle({ type: 'run' }); await until(() => controller.state.status === 'input');
      await controller.handle({ type: 'breakpoint', address: 0x400008 });
      await controller.handle({ type: 'input', text: '12' });
      await until(() => controller.state.status === 'paused' && controller.state.pc === 0x400008);
      expect(controller.state.message).toContain('断点');
      expect(controller.state.steps).toBe(2);
      expect(gpr(controller.state, 8)).toBe(0);
      await controller.handle({ type: 'run' }); await until(() => controller.state.status === 'exited');
      expect(gpr(controller.state, 8)).toBe(7);
    } finally { controller.dispose(); await until(() => jobs.every(job => job.finished)); }
  });
  it('a new assemble supersedes an earlier capture without publishing old results', async () => {
    const { controller, capture, jobs } = fixture('addiu $t0, $zero, 2');
    const oldInput = gate<{ sources: { id: string; text: string }[]; includes: [] }>();
    capture.mockImplementationOnce(() => oldInput.promise);
    try {
      const first = controller.assemble();
      await controller.assemble(); await until(() => controller.state.status === 'paused');
      oldInput.resolve({ sources: [{ id: 'main', text: 'addiu $t0, $zero, 1' }], includes: [] }); await first;
      expect(controller.sources[0].text).toContain('2');
      expect(jobs.filter(job => job.kind === 'mars-assemble')).toHaveLength(1);
      await controller.handle({ type: 'step' }); await until(() => controller.state.steps === 1);
      expect(gpr(controller.state, 8)).toBe(2);
    } finally { controller.dispose(); await until(() => jobs.every(job => job.finished)); }
  });
  it('removing a just-hit breakpoint executes that instruction and stops at the next breakpoint', async () => {
    const { controller, jobs } = fixture('addiu $t0, $zero, 7\naddiu $t1, $zero, 9\nli $v0, 10\nsyscall');
    try {
      await controller.assemble(); await until(() => controller.state.status === 'paused');
      await controller.handle({ type: 'breakpoint', address: 0x400000 });
      await controller.handle({ type: 'breakpoint', address: 0x400004 });
      await until(() => controller.state.breakpoints.length === 2);
      await controller.handle({ type: 'run' }); await until(() => controller.state.message.includes('断点') && controller.state.pc === 0x400000);
      expect(controller.state.steps).toBe(0);
      await controller.handle({ type: 'breakpoint', address: 0x400000 });
      await controller.handle({ type: 'run' });
      await until(() => controller.state.status === 'paused' && controller.state.pc === 0x400004);
      expect(controller.state.steps).toBe(1);
      expect(gpr(controller.state, 8)).toBe(7);
      expect(gpr(controller.state, 9)).toBe(0);
      expect(controller.state.breakpoints).toEqual([0x400004]);
      await controller.handle({ type: 'breakpoint', address: 0x400004 });
      await controller.handle({ type: 'step' }); await until(() => controller.state.steps === 2);
      expect(gpr(controller.state, 9)).toBe(9);
      expect(controller.state.pc).toBe(0x400008);
      await controller.handle({ type: 'run' }); await until(() => controller.state.status === 'exited');
    } finally { controller.dispose(); await until(() => jobs.every(job => job.finished)); }
  });
  it('source edits during capture remain stale and block execution until reassembly', async () => {
    const { controller, capture, jobs } = fixture('nop');
    const input = gate<{ sources: { id: string; text: string }[]; includes: [] }>();
    capture.mockImplementationOnce(() => input.promise);
    try {
      const assembly = controller.assemble();
      controller.markSourceChanged();
      input.resolve({ sources: [{ id: 'main', text: 'nop' }], includes: [] }); await assembly;
      await until(() => controller.state.status === 'paused');
      expect(controller.state.sourceChanged).toBe(true);
      await controller.handle({ type: 'run' });
      expect(controller.state.steps).toBe(0);
      expect(controller.state.message).toContain('重新汇编');
    } finally { controller.dispose(); await until(() => jobs.every(job => job.finished)); }
  });
});
