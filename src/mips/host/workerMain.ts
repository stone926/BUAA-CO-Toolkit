// @index mips-host — Worker 入口：版本化协议处理（阶段 1 仅 ping）
import { parentPort } from 'worker_threads';
import {
  isWorkerInboundMessage,
  WorkerInboundMessage,
  WorkerOutboundMessage,
  WorkerRequestMessage,
  workerProtocolVersion
} from './workerProtocol';

/**
 * Worker entry point (plan section 5.6). Phase 1 implements the protocol
 * skeleton and ping round-trip; real assemble/execute jobs are dispatched
 * here when the builtin providers land. Keep this file free of vscode imports:
 * it runs inside a worker thread.
 */

export interface WorkerJobHandler {
  (request: WorkerRequestMessage, signal: AbortSignal): unknown | Promise<unknown>;
}

const jobHandlers: Map<string, WorkerJobHandler> = new Map();

/** Phase-1 handler: round-trip a token to prove the protocol works. */
jobHandlers.set('ping', (request) => ({
  token: request.job.payload ?? null,
  receivedAt: 'phase-1-skeleton'
}));

interface ActiveWorkerRequest {
  controller: AbortController;
  cancelled: boolean;
}

const active = new Map<string, ActiveWorkerRequest>();

function respond(result: WorkerOutboundMessage): void {
  parentPort?.postMessage(result);
}

function handleMessage(raw: unknown): void {
  if (!isWorkerInboundMessage(raw)) {
    return;
  }
  if (raw.kind === 'cancel') {
    const entry = active.get(raw.requestId);
    if (!entry || entry.cancelled) {
      return;
    }
    entry.cancelled = true;
    try {
      entry.controller.abort();
    } catch {
      // The handler still observes signal.aborted; its terminal path emits the
      // single cancelled result, or the host grace timer force-stops the worker.
    }
    return;
  }
  const request = raw as WorkerRequestMessage;
  if (active.has(request.requestId)) {
    return;
  }
  const handler = jobHandlers.get(request.job.kind);
  if (!handler) {
    respond({
      protocolVersion: workerProtocolVersion,
      kind: 'result',
      requestId: request.requestId,
      ok: false,
      error: `unknown job kind: ${String(request.job.kind)}`
    });
    return;
  }
  const controller = new AbortController();
  active.set(request.requestId, { controller, cancelled: false });
  Promise.resolve()
    .then(() => handler(request, controller.signal))
    .then(
      (payload) => {
        const entry = active.get(request.requestId);
        if (!entry || !active.delete(request.requestId)) {
          return;
        }
        if (entry.cancelled) {
          respondCancelled(request.requestId);
          return;
        }
        respond({
          protocolVersion: workerProtocolVersion,
          kind: 'result',
          requestId: request.requestId,
          ok: true,
          payload
        });
      },
      (error: unknown) => {
        const entry = active.get(request.requestId);
        if (!entry || !active.delete(request.requestId)) {
          return;
        }
        if (entry.cancelled) {
          respondCancelled(request.requestId);
          return;
        }
        respond({
          protocolVersion: workerProtocolVersion,
          kind: 'result',
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    );
}

function respondCancelled(requestId: string): void {
  respond({
    protocolVersion: workerProtocolVersion,
    kind: 'result',
    requestId,
    ok: false,
    error: 'cancelled',
    cancelled: true
  });
}

if (parentPort) {
  parentPort.on('message', handleMessage);
}

/** Test seam: process one inbound message without a parent port. */
export function handleWorkerInboundMessageForTest(raw: unknown): void {
  handleMessage(raw);
}

/** Install/remove a bounded test handler without exposing production registration. */
export function setWorkerJobHandlerForTest(kind: string, handler: WorkerJobHandler | undefined): void {
  if (handler) {
    jobHandlers.set(kind, handler);
  } else {
    jobHandlers.delete(kind);
  }
}

export type { WorkerInboundMessage };
