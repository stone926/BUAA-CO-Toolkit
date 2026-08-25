// @index mips-host — Worker 版本化消息协议（纯类型；worker 与 host 两侧共享）
/**
 * Versioned worker protocol (plan section 5.6). Phase 1 ships the message
 * shape, ping round-trip and cancel; real assemble/execute jobs land with the
 * builtin providers. This module must stay free of host-side imports so
 * workerMain can load it inside a worker thread.
 */

export const workerProtocolVersion = 1;

/** Job kinds the worker can execute. Phase 1 supports ping only. */
export type WorkerJobKind = 'ping';

export interface WorkerJob {
  kind: WorkerJobKind;
  /** Structured per-kind payload; ping uses a string token for round-trip checks. */
  payload?: unknown;
}

export interface WorkerRequestMessage {
  protocolVersion: typeof workerProtocolVersion;
  kind: 'request';
  requestId: string;
  jobId: string;
  job: WorkerJob;
}

export interface WorkerCancelMessage {
  protocolVersion: typeof workerProtocolVersion;
  kind: 'cancel';
  requestId: string;
}

export interface WorkerProgressMessage {
  protocolVersion: typeof workerProtocolVersion;
  kind: 'progress';
  requestId: string;
  /** Event batch; consumers apply backpressure before sending the next batch. */
  batch: unknown[];
}

export interface WorkerResultMessage {
  protocolVersion: typeof workerProtocolVersion;
  kind: 'result';
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export type WorkerInboundMessage = WorkerRequestMessage | WorkerCancelMessage;

export type WorkerOutboundMessage = WorkerProgressMessage | WorkerResultMessage;

export function isWorkerInboundMessage(value: unknown): value is WorkerInboundMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as { protocolVersion?: unknown; kind?: unknown };
  return message.protocolVersion === workerProtocolVersion
    && (message.kind === 'request' || message.kind === 'cancel');
}

export function isWorkerOutboundMessage(value: unknown): value is WorkerOutboundMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as { protocolVersion?: unknown; kind?: unknown };
  return message.protocolVersion === workerProtocolVersion
    && (message.kind === 'result' || message.kind === 'progress');
}
