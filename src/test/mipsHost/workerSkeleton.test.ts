import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { MipsRuntimeManager } from '../../mips/host/runtimeManager';
import { WorkerClient, MipsWorkerPort } from '../../mips/host/workerClient';
import { workerProtocolVersion } from '../../mips/host/workerProtocol';

// JS fixture worker implementing the phase-1 protocol, so the host-side
// integration tests do not depend on the compiled out/ tree.
const fixtureWorkerPath = path.join(__dirname, '..', 'fixtures', 'mipsHost', 'protocolWorker.js');

const activeManagers: MipsRuntimeManager[] = [];

afterEach(() => {
  for (const manager of activeManagers.splice(0)) {
    manager.dispose();
  }
});

function manager(): MipsRuntimeManager {
  const created = new MipsRuntimeManager({ workerPath: fixtureWorkerPath, cancelGraceMs: 300 });
  activeManagers.push(created);
  return created;
}

describe('worker host skeleton', () => {
  it('does not start a worker until the first job', () => {
    const runtime = manager();
    expect(runtime.started).toBe(false);
  });

  it('does not dispatch or start a worker for a pre-aborted job', async () => {
    const runtime = manager();
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.runJob({ kind: 'ping', payload: 'must-not-run' }, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(runtime.started).toBe(false);
  });

  it('round-trips a ping job through a real worker thread', async () => {
    const runtime = manager();
    const result = await runtime.runJob({ kind: 'ping', payload: 'hello-worker' });
    expect(runtime.started).toBe(true);
    expect(result.kind).toBe('result');
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ token: 'hello-worker' });
  });

  it('rebuilds the worker after a crash and settles the pending request', async () => {
    const runtime = manager();
    await runtime.runJob({ kind: 'ping' }); // ensure a live worker
    const pending = runtime.runJob({ kind: 'crash' } as never);
    const crashed = await pending;
    expect(crashed.ok).toBe(false);
    const second = await runtime.runJob({ kind: 'ping' });
    expect(second.ok).toBe(true);
  });

  it('force-settles a wedged request after the cancel grace period', async () => {
    const client = new WorkerClient({ cancelGraceMs: 50 });
    const dispose = vi.fn();
    const port: MipsWorkerPort = {
      postMessage: vi.fn(),
      onMessage: vi.fn(),
      dispose
    };
    client.attach(port);
    const controller = new AbortController();
    const promise = client.start({ kind: 'ping' }, { signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ cancelled: true });
    expect(dispose).toHaveBeenCalled();
    client.dispose();
  });

  it('fails closed on malformed worker output and ignores stale-port messages', async () => {
    const client = new WorkerClient();
    let oldReceive: ((value: unknown) => void) | undefined;
    const oldDispose = vi.fn();
    client.attach({
      postMessage: vi.fn(),
      onMessage: (listener) => { oldReceive = listener; },
      dispose: oldDispose
    });
    const malformedPending = client.start({ kind: 'ping' });
    oldReceive?.({ protocolVersion: 2, kind: 'result', requestId: 'req-0', ok: false });
    await expect(malformedPending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('protocol violation')
    });
    expect(oldDispose).toHaveBeenCalledOnce();

    let currentReceive: ((value: unknown) => void) | undefined;
    const currentDispose = vi.fn();
    const currentPost = vi.fn();
    client.attach({
      postMessage: currentPost,
      onMessage: (listener) => { currentReceive = listener; },
      dispose: currentDispose
    });
    const currentPending = client.start({ kind: 'ping' });
    oldReceive?.({ nonsense: true });
    expect(currentDispose).not.toHaveBeenCalled();
    const request = currentPost.mock.calls[0][0];
    currentReceive?.({
      protocolVersion: 2,
      kind: 'result',
      requestId: request.requestId,
      ok: true,
      payload: 'fresh'
    });
    await expect(currentPending).resolves.toMatchObject({ ok: true, payload: 'fresh' });
    client.dispose();
  });

  it('closes the abort race after dispatching the request', async () => {
    const client = new WorkerClient({ cancelGraceMs: 100 });
    const posted: unknown[] = [];
    let receive: ((value: unknown) => void) | undefined;
    client.attach({
      postMessage: (message) => posted.push(message),
      onMessage: (listener) => { receive = listener; },
      dispose: vi.fn()
    });
    let abortChecks = 0;
    const racedSignal = {
      get aborted() { return abortChecks++ > 0; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as AbortSignal;
    const pending = client.start({ kind: 'ping' }, { signal: racedSignal });
    expect((posted[0] as { kind: string }).kind).toBe('request');
    expect((posted[1] as { kind: string }).kind).toBe('cancel');
    const requestId = (posted[0] as { requestId: string }).requestId;
    receive?.({
      protocolVersion: 2,
      kind: 'result',
      requestId,
      ok: false,
      error: 'cancelled',
      cancelled: true
    });
    await expect(pending).resolves.toMatchObject({ ok: false, cancelled: true });
    client.dispose();
  });

  it('rebuilds immediately after forced cancellation and ignores the old worker exit', async () => {
    const runtime = manager();
    const controller = new AbortController();
    const pending = runtime.runJob({ kind: 'wedge' } as never, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ ok: false, cancelled: true });

    const immediate = await runtime.runJob({ kind: 'ping', payload: 'new-generation' });
    expect(immediate).toMatchObject({ ok: true, payload: { token: 'new-generation' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterOldExit = await runtime.runJob({ kind: 'ping', payload: 'still-alive' });
    expect(afterOldExit).toMatchObject({ ok: true, payload: { token: 'still-alive' } });
  });

  it('delivers progress and removes abort/timer hooks after a terminal result', async () => {
    const client = new WorkerClient({ cancelGraceMs: 25 });
    const postMessage = vi.fn();
    const dispose = vi.fn();
    let receive: ((value: unknown) => void) | undefined;
    const port: MipsWorkerPort = {
      postMessage,
      onMessage: (listener) => {
        receive = listener;
      },
      dispose
    };
    client.attach(port);
    const controller = new AbortController();
    const progress = vi.fn();
    const pending = client.start({ kind: 'ping' }, { signal: controller.signal, onProgress: progress });
    const request = postMessage.mock.calls[0][0];
    receive?.({
      protocolVersion: 2,
      kind: 'progress',
      requestId: request.requestId,
      sequence: 0,
      batch: ['a', 'b']
    });
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'ack', requestId: request.requestId, sequence: 0
      }));
    });
    receive?.({
      protocolVersion: 2,
      kind: 'result',
      requestId: request.requestId,
      ok: true,
      payload: 'done'
    });
    await expect(pending).resolves.toMatchObject({ ok: true, payload: 'done' });
    expect(progress).toHaveBeenCalledWith(['a', 'b']);

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(dispose).not.toHaveBeenCalled();

    const cancelledController = new AbortController();
    const cancelledPending = client.start({ kind: 'ping' }, { signal: cancelledController.signal });
    const cancelledRequest = postMessage.mock.calls.find((call, index) =>
      index > 0 && call[0]?.kind === 'request')![0];
    cancelledController.abort();
    receive?.({
      protocolVersion: 2,
      kind: 'result',
      requestId: cancelledRequest.requestId,
      ok: false,
      error: 'cancelled',
      cancelled: true
    });
    await expect(cancelledPending).resolves.toMatchObject({ ok: false, cancelled: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispose).not.toHaveBeenCalled();
    client.dispose();
  });

  it('fails and cancels without ACK when the progress consumer rejects', async () => {
    const client = new WorkerClient({ cancelGraceMs: 100 });
    const postMessage = vi.fn();
    const dispose = vi.fn();
    let receive: ((value: unknown) => void) | undefined;
    client.attach({
      postMessage,
      onMessage: (listener) => { receive = listener; },
      dispose
    });
    const pending = client.start({ kind: 'ping' }, {
      onProgress: async () => { throw new Error('sink failed'); }
    });
    const request = postMessage.mock.calls[0][0];

    receive?.({
      protocolVersion: 2,
      kind: 'progress',
      requestId: request.requestId,
      sequence: 0,
      batch: ['must-not-be-acked']
    });
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'cancel', requestId: request.requestId
      }));
    });
    expect(postMessage.mock.calls.map((call) => call[0])).not.toContainEqual(expect.objectContaining({
      kind: 'ack', requestId: request.requestId
    }));

    receive?.({
      protocolVersion: 2,
      kind: 'result',
      requestId: request.requestId,
      ok: false,
      error: 'cancelled',
      cancelled: true
    });
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: 'progress consumer failed: sink failed'
    });
    expect(dispose).not.toHaveBeenCalled();
    client.dispose();
  });

  it('rejects a nonzero first progress sequence and disposes the bad generation', async () => {
    const client = new WorkerClient();
    const postMessage = vi.fn();
    const dispose = vi.fn();
    let receive: ((value: unknown) => void) | undefined;
    client.attach({
      postMessage,
      onMessage: (listener) => { receive = listener; },
      dispose
    });
    const pending = client.start({ kind: 'ping' });
    const request = postMessage.mock.calls[0][0];

    receive?.({
      protocolVersion: 2,
      kind: 'progress',
      requestId: request.requestId,
      sequence: 1,
      batch: ['out-of-order']
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('expected progress sequence 0, received 1')
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects repeated and skipped progress sequences after an acknowledged batch', async () => {
    for (const badSequence of [0, 2]) {
      const client = new WorkerClient();
      const postMessage = vi.fn();
      const dispose = vi.fn();
      let receive: ((value: unknown) => void) | undefined;
      client.attach({
        postMessage,
        onMessage: (listener) => { receive = listener; },
        dispose
      });
      const pending = client.start({ kind: 'ping' });
      const request = postMessage.mock.calls[0][0];
      receive?.({
        protocolVersion: 2,
        kind: 'progress',
        requestId: request.requestId,
        sequence: 0,
        batch: ['accepted']
      });
      await vi.waitFor(() => {
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'ack', requestId: request.requestId, sequence: 0
        }));
      });

      receive?.({
        protocolVersion: 2,
        kind: 'progress',
        requestId: request.requestId,
        sequence: badSequence,
        batch: ['invalid']
      });
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining(`expected progress sequence 1, received ${badSequence}`)
      });
      expect(dispose).toHaveBeenCalledOnce();
    }
  });

  it('keeps the protocol version stable', () => {
    expect(workerProtocolVersion).toBe(2);
  });
});
