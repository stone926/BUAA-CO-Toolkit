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
    expect(dispose).toHaveBeenCalled();
    client.dispose();
  });

  it('keeps the protocol version stable', () => {
    expect(workerProtocolVersion).toBe(1);
  });
});
