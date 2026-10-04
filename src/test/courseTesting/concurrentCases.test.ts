import { describe, expect, it, vi } from 'vitest';
import { runConcurrentCases } from '../../courseTesting/concurrentCases';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('Condition did not settle');
}

describe('bounded case scheduling', () => {
  it('fills freed slots without waiting for an earlier slow case, retaining stable slot ownership', async () => {
    const gates = Array.from({ length: 4 }, () => deferred<boolean>());
    const starts: Array<[number, number]> = [];
    const completed: number[] = [];
    const work = runConcurrentCases([0, 1, 2, 3], {
      concurrency: 2, phase: () => 0, key: String,
      run: async (item, _index, slot) => { starts.push([item, slot]); return gates[item].promise; },
      shouldStop: () => false,
      completed: async (_result, item) => { completed.push(item); }
    });
    await until(() => starts.length === 2);
    expect(starts).toEqual([[0, 0], [1, 1]]);
    gates[1].resolve(true);
    await until(() => starts.length === 3);
    expect(starts[2]).toEqual([2, 1]);
    gates[2].resolve(true);
    await until(() => starts.length === 4);
    gates[3].resolve(true);
    gates[0].resolve(true);
    await work;
    expect(completed.slice(0, 2)).toEqual([1, 2]);
    expect(new Set(completed).size).toBe(4);
  });

  it('aborts peers before saving a failure and drains them before resolving', async () => {
    const failure = deferred<boolean>();
    const peer = deferred<boolean>();
    const saving = deferred<void>();
    const signals: AbortSignal[] = [];
    let done = false;
    const completed = vi.fn(async () => saving.promise);
    const work = runConcurrentCases([0, 1, 2], {
      concurrency: 2, phase: () => 0, key: String,
      run: async (item, _index, _slot, signal) => {
        signals.push(signal);
        return item === 0 ? failure.promise : peer.promise;
      },
      shouldStop: result => !result, completed
    }).then(() => { done = true; });
    await until(() => signals.length === 2);
    failure.resolve(false);
    await until(() => completed.mock.calls.length === 1);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(done).toBe(false);
    saving.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(done).toBe(false);
    peer.resolve(true);
    await work;
    expect(signals).toHaveLength(2);
    expect(completed).toHaveBeenCalledTimes(2);
  });

  it('enforces phase barriers and serializes variants sharing artifacts', async () => {
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const items = [
      { phase: 0, key: 'gpr' }, { phase: 1, key: 'shared' },
      { phase: 1, key: 'shared' }, { phase: 1, key: 'other' }, { phase: 2, key: 'special' }
    ];
    const starts: number[] = [];
    const work = runConcurrentCases(items, {
      concurrency: 4, phase: item => item.phase, key: item => item.key,
      run: async (_item, index) => { starts.push(index); return gates[index].promise; },
      shouldStop: () => false, completed: async () => {}
    });
    await until(() => starts.length === 1);
    expect(starts).toEqual([0]);
    gates[0].resolve();
    await until(() => starts.length === 3);
    expect(starts).toEqual([0, 1, 3]);
    gates[1].resolve();
    await until(() => starts.length === 4);
    expect(starts[3]).toBe(2);
    gates[2].resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(starts).toHaveLength(4);
    gates[3].resolve();
    await until(() => starts.length === 5);
    gates[4].resolve();
    await work;
  });

  it('drains peers after a completion callback throws', async () => {
    const peer = deferred<void>();
    const starts: number[] = [];
    let aborted = false;
    const work = runConcurrentCases([0, 1, 2], {
      concurrency: 2, phase: () => 0, key: String,
      run: async (item, _index, _slot, signal) => {
        starts.push(item);
        if (item === 1) {
          signal.addEventListener('abort', () => { aborted = true; });
          await peer.promise;
        }
      },
      shouldStop: () => false,
      completed: async (_result, item) => { if (item === 0) throw new Error('disk failure'); }
    });
    const rejected = expect(work).rejects.toThrow('disk failure');
    await until(() => aborted);
    expect(starts).toEqual([0, 1]);
    peer.resolve();
    await rejected;
  });

  it('starts no work for a pre-cancelled session', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => {});
    await runConcurrentCases([0], {
      concurrency: 2, signal: controller.signal, phase: () => 0, key: String,
      run, shouldStop: () => false, completed: async () => {}
    });
    expect(run).not.toHaveBeenCalled();
  });
});
