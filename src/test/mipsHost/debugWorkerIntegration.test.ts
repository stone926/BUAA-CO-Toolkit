import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MipsRuntimeManager } from '../../mips/host/runtimeManager';
import { assembleMarsSource } from '../../mips/core/assembler/marsAssembler';
import type { DebugSnapshot } from '../../mips/core/debug/api';
import type { WorkerProtocolObservation } from '../../mips/host/workerClient';
import { MarsDebugClient } from '../../mips/host/debugClient';

let directory: string;
let workerPath: string;
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'co-debug-worker-'));
  workerPath = path.join(directory, 'worker.cjs');
  const bundle = await build({ entryPoints: [path.resolve('src/mips/host/workerMain.ts')], outfile: workerPath,
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  await fs.writeFile(workerPath, bundle.outputFiles![0].contents);
});
afterAll(async () => {
  if (directory && path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('co-debug-worker-')) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Worker debugger state did not settle');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe('interactive debugger through the real production Worker', () => {
  it('holds a paused ACK, remains responsive, and steps and resumes breakpoints', async () => {
    const observations: WorkerProtocolObservation[] = [];
    const manager = new MipsRuntimeManager({ workerPath, observeProtocol: event => observations.push(event) });
    const paused = gate<void>(), command = gate<unknown>();
    const snapshots: DebugSnapshot[] = [];
    const image = assembleMarsSource({ id: 'main', text: 'loop: addiu $t0, $t0, 1\nj loop\nnop' }).image!;
    const responses = [{ kind: 'set-breakpoints', addresses: [0x400000] }, { kind: 'continue' }, { kind: 'continue' },
      { kind: 'memory', address: 0x10010000, words: 1 }, { kind: 'stop' }];
    try {
      const result = manager.runJob({ kind: 'mars-debug', payload: { image, mode: { kind: 'mars' } } }, {
        async onProgress(batch) {
          const progress = batch[0] as { kind: string; snapshot: DebugSnapshot };
          expect(progress.kind).toBe('mars-debug'); snapshots.push(progress.snapshot);
          if (snapshots.length === 1) { paused.resolve(); return await command.promise; }
          return responses.shift();
        }
      });
      await paused.promise;
      expect(snapshots[0]).toMatchObject({ instructions: 0, status: 'paused' });
      expect(observations.filter(event => event.kind === 'ack')).toHaveLength(0);
      expect(await manager.runJob({ kind: 'ping', payload: 'responsive' })).toMatchObject({ ok: true, payload: { token: 'responsive' } });
      command.resolve({ kind: 'step' });
      expect(await result).toMatchObject({ ok: true, payload: { status: 'stopped', instructions: 4 } });
      expect(snapshots[1]).toMatchObject({ status: 'paused', reason: 'step', instructions: 1, pc: 0x400004 });
      expect(snapshots[3]).toMatchObject({ reason: 'breakpoint', instructions: 2, pc: 0x400000 });
      expect(snapshots[4]).toMatchObject({ reason: 'breakpoint', instructions: 4 });
      expect(snapshots[5].gpr[8]).toBe(2);
      expect(snapshots[5].memory.words[0]).toEqual({ address: 0x10010000, value: 0 });
      const debugId = observations.find(event => event.kind === 'request')!.requestId;
      const debugEvents = observations.filter(event => event.requestId === debugId);
      expect(debugEvents.filter(event => event.kind === 'progress').map(event => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(debugEvents.filter(event => event.kind === 'ack').map(event => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(debugEvents.filter(event => event.kind === 'result')).toHaveLength(1);
    } finally { command.resolve({ kind: 'stop' }); manager.dispose(); }
  });
  it('cancels an input wait once and leaves the shared Worker responsive', async () => {
    const manager = new MipsRuntimeManager({ workerPath, cancelGraceMs: 1000 });
    const input = gate<void>(), response = gate<unknown>(), abort = new AbortController();
    const image = assembleMarsSource({ id: 'main', text: 'li $v0, 5\nsyscall\nnop' }).image!;
    try {
      const result = manager.runJob({ kind: 'mars-debug', payload: { image, mode: { kind: 'mars' } } }, {
        signal: abort.signal,
        async onProgress(batch) {
          const progress = batch[0] as { kind: string; request: { id: number } };
          if (progress.kind === 'mars-io') { input.resolve(); return await response.promise; }
          return { kind: 'continue' };
        }
      });
      await input.promise;
      abort.abort();
      expect(await result).toMatchObject({ ok: false, cancelled: true });
      expect(await manager.runJob({ kind: 'ping', payload: 'after-cancel' })).toMatchObject({ ok: true, payload: { token: 'after-cancel' } });
    } finally { response.resolve({ id: 1, text: '0' }); manager.dispose(); }
  });
  it('inspects memory and queued breakpoints during one input request through the production client', async () => {
    const manager = new MipsRuntimeManager({ workerPath });
    const input = gate<string | undefined>();
    const snapshots: DebugSnapshot[] = [];
    let inputCalls = 0;
    const client = new MarsDebugClient(manager, path.join(directory, '程序.asm'), {
      snapshot: snapshot => snapshots.push(snapshot), output: () => undefined,
      input: () => { inputCalls++; return input.promise; }
    });
    const image = assembleMarsSource({ id: 'main', text: '.data\nx: .word 42\n.space 252\ny: .word 77\n.text\nli $v0, 5\nsyscall\naddiu $t0, $zero, 7\nli $v0, 10\nsyscall' }).image!;
    const running = client.run({ image, mode: { kind: 'mars' } });
    try {
      await until(() => snapshots.length === 1);
      client.command({ kind: 'continue' });
      await until(() => inputCalls === 1);
      const start = snapshots.length;
      for (const address of [0x10010100, 0x7fffeffc, 0x400000, 0x10010000]) {
        client.command({ kind: 'memory', address, words: 1 });
        await until(() => snapshots.at(-1)?.memory.address === address);
      }
      expect(snapshots.at(-1)?.memory.words[0].value).toBe(42);
      client.command({ kind: 'set-breakpoints', addresses: [0x400008] });
      client.command({ kind: 'memory', address: 0x10010100, words: 1 });
      await until(() => snapshots.at(-1)?.memory.address === 0x10010100 && snapshots.at(-1)?.breakpoints[0] === 0x400008);
      expect(snapshots.at(-1)?.memory.words[0].value).toBe(77);
      for (const snapshot of snapshots.slice(start)) expect(snapshot).toMatchObject({ pc: 0x400004, instructions: 1, status: 'running' });
      expect(inputCalls).toBe(1);
      input.resolve('23\n');
      client.command({ kind: 'memory', address: 0x10010200, words: 1 });
      await until(() => snapshots.at(-1)?.reason === 'breakpoint');
      expect(snapshots.at(-1)).toMatchObject({ pc: 0x400008, instructions: 2 });
      expect(snapshots.at(-1)?.memory.address).toBe(0x10010200);
      expect(snapshots.at(-1)?.gpr[2]).toBe(23);
      expect(snapshots.at(-1)?.gpr[8]).toBe(0);
      expect(inputCalls).toBe(1);
      client.command({ kind: 'stop' });
      await running;
    } finally { input.resolve(undefined); client.dispose(); await running; manager.dispose(); }
  });
  it('cancels the production client after suspended input inspection without another prompt', async () => {
    const manager = new MipsRuntimeManager({ workerPath, cancelGraceMs: 1000 });
    const input = gate<string | undefined>();
    const snapshots: DebugSnapshot[] = [];
    let inputCalls = 0;
    const client = new MarsDebugClient(manager, path.join(directory, 'input.asm'), {
      snapshot: snapshot => snapshots.push(snapshot), output: () => undefined,
      input: () => { inputCalls++; return input.promise; }
    });
    const image = assembleMarsSource({ id: 'main', text: 'li $v0, 5\nsyscall\nnop' }).image!;
    const running = client.run({ image, mode: { kind: 'mars' } });
    try {
      await until(() => snapshots.length === 1);
      client.command({ kind: 'continue' }); await until(() => inputCalls === 1);
      client.command({ kind: 'memory', address: 0x400000, words: 1 });
      await until(() => snapshots.at(-1)?.memory.address === 0x400000);
      client.dispose(); await running;
      expect(inputCalls).toBe(1);
      expect(snapshots.at(-1)).toMatchObject({ pc: 0x400004, instructions: 1 });
      expect(await manager.runJob({ kind: 'ping', payload: 'after-client-cancel' })).toMatchObject({ ok: true });
    } finally { input.resolve(undefined); client.dispose(); await running; manager.dispose(); }
  });
});
