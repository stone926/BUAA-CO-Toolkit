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

const active = new Map<string, AbortController>();

function respond(result: WorkerOutboundMessage): void {
  parentPort?.postMessage(result);
}

function handleMessage(raw: unknown): void {
  if (!isWorkerInboundMessage(raw)) {
    return;
  }
  if (raw.kind === 'cancel') {
    active.get(raw.requestId)?.abort();
    active.delete(raw.requestId);
    return;
  }
  const request = raw as WorkerRequestMessage;
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
  active.set(request.requestId, controller);
  Promise.resolve()
    .then(() => handler(request, controller.signal))
    .then(
      (payload) => {
        if (!active.delete(request.requestId)) {
          return; // cancelled while running; a cancelled result was already sent
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
        if (!active.delete(request.requestId)) {
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

if (parentPort) {
  parentPort.on('message', handleMessage);
}

/** Test seam: process one inbound message without a parent port. */
export function handleWorkerInboundMessageForTest(raw: unknown): void {
  handleMessage(raw);
}

export type { WorkerInboundMessage };
