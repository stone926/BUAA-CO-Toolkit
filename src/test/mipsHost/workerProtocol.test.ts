import { beforeEach, describe, expect, it, vi } from 'vitest';

const { postMessage, parentPort } = vi.hoisted(() => {
  const postMessage = vi.fn();
  return { postMessage, parentPort: { on: vi.fn(), postMessage } };
});

vi.mock('worker_threads', () => ({ parentPort }));

import { handleWorkerInboundMessageForTest } from '../../mips/host/workerMain';

function resultMessage(requestId: string) {
  return postMessage.mock.calls.map((call) => call[0]).find(
    (message) => message?.kind === 'result' && message.requestId === requestId
  );
}

describe('worker protocol handler', () => {
  beforeEach(() => {
    postMessage.mockClear();
  });

  it('answers ping requests with a result message', async () => {
    handleWorkerInboundMessageForTest({
      protocolVersion: 1,
      kind: 'request',
      requestId: 'r1',
      jobId: 'j1',
      job: { kind: 'ping', payload: 'hello' }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = resultMessage('r1');
    expect(result).toMatchObject({
      protocolVersion: 1,
      kind: 'result',
      requestId: 'r1',
      ok: true,
      payload: { token: 'hello' }
    });
  });

  it('answers unknown job kinds with a structured error', async () => {
    handleWorkerInboundMessageForTest({
      protocolVersion: 1,
      kind: 'request',
      requestId: 'r2',
      jobId: 'j2',
      job: { kind: 'not-a-job' }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = resultMessage('r2');
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('unknown job kind');
  });

  it('drops protocol violations silently', async () => {
    handleWorkerInboundMessageForTest({ protocolVersion: 99, kind: 'request', requestId: 'r3', jobId: 'j3', job: { kind: 'ping' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resultMessage('r3')).toBeUndefined();
  });
});
