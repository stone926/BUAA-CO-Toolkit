import { beforeEach, describe, expect, it, vi } from 'vitest';

const { postMessage, parentPort } = vi.hoisted(() => {
  const postMessage = vi.fn();
  return { postMessage, parentPort: { on: vi.fn(), postMessage } };
});

vi.mock('worker_threads', () => ({ parentPort }));

import {
  handleWorkerInboundMessageForTest,
  setWorkerJobHandlerForTest
} from '../../mips/host/workerMain';
import {
  isWorkerInboundMessage,
  isWorkerOutboundMessage
} from '../../mips/host/workerProtocol';

function resultMessage(requestId: string) {
  return postMessage.mock.calls.map((call) => call[0]).find(
    (message) => message?.kind === 'result' && message.requestId === requestId
  );
}

describe('worker protocol handler', () => {
  beforeEach(() => {
    postMessage.mockClear();
    setWorkerJobHandlerForTest('wait-for-cancel', undefined);
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

  it('validates every required protocol field and terminal result shape', () => {
    expect(isWorkerInboundMessage({ protocolVersion: 1, kind: 'request', requestId: 'r', jobId: 'j', job: { kind: 'ping' } })).toBe(true);
    expect(isWorkerInboundMessage({ protocolVersion: 1, kind: 'request', requestId: 'r', jobId: 'j' })).toBe(false);
    expect(isWorkerInboundMessage({ protocolVersion: 1, kind: 'request', requestId: '', jobId: 'j', job: { kind: 'ping' } })).toBe(false);
    expect(isWorkerInboundMessage({ protocolVersion: 1, kind: 'cancel', requestId: 'r', extra: true })).toBe(false);
    expect(isWorkerOutboundMessage({ protocolVersion: 1, kind: 'progress', requestId: 'r', batch: [] })).toBe(true);
    expect(isWorkerOutboundMessage({ protocolVersion: 1, kind: 'progress', requestId: 'r', batch: {} })).toBe(false);
    expect(isWorkerOutboundMessage({ protocolVersion: 1, kind: 'result', requestId: 'r', ok: false })).toBe(false);
    expect(isWorkerOutboundMessage({ protocolVersion: 1, kind: 'result', requestId: 'r', ok: false, error: 'cancelled', cancelled: true })).toBe(true);
    expect(isWorkerOutboundMessage({ protocolVersion: 1, kind: 'result', requestId: 'r', ok: true, cancelled: true })).toBe(false);
  });

  it('responds exactly once when a production handler is cancelled', async () => {
    setWorkerJobHandlerForTest('wait-for-cancel', (_request, signal) => new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    handleWorkerInboundMessageForTest({
      protocolVersion: 1,
      kind: 'request',
      requestId: 'cancel-me',
      jobId: 'cancel-job',
      job: { kind: 'wait-for-cancel' }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    handleWorkerInboundMessageForTest({ protocolVersion: 1, kind: 'cancel', requestId: 'cancel-me' });
    handleWorkerInboundMessageForTest({ protocolVersion: 1, kind: 'cancel', requestId: 'cancel-me' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const results = postMessage.mock.calls.map((call) => call[0]).filter(
      (message) => message?.kind === 'result' && message.requestId === 'cancel-me'
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, error: 'cancelled', cancelled: true });
  });
});
