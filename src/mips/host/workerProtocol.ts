// @index mips-host — Worker 版本化消息协议（纯类型；worker 与 host 两侧共享）
/**
 * Versioned worker protocol (plan section 5.6). Phase 1 ships the message
 * shape, cooperative cancel, and bounded real ISA encode/decode jobs. Full
 * assemble/execute jobs land with the corresponding builtin providers. This
 * module must stay free of host-side imports so
 * workerMain can load it inside a worker thread.
 */

export const workerProtocolVersion = 2;

/** Job kinds the phase-1 worker can execute. */
export type WorkerJobKind = 'ping' | 'isa-decode-batch' | 'isa-encode-batch';

export type WorkerJob =
  | { kind: 'ping'; payload?: unknown }
  | { kind: 'isa-decode-batch'; payload: unknown }
  | { kind: 'isa-encode-batch'; payload: unknown };

/** Wire-level envelope; unknown string kinds are structurally valid and get a structured worker error. */
export interface WorkerJobEnvelope {
  kind: string;
  payload?: unknown;
}

export interface WorkerRequestMessage {
  protocolVersion: typeof workerProtocolVersion;
  kind: 'request';
  requestId: string;
  jobId: string;
  job: WorkerJobEnvelope;
}

export interface WorkerCancelMessage {
  protocolVersion: typeof workerProtocolVersion;
  kind: 'cancel';
  requestId: string;
}

export interface WorkerAckMessage {
  protocolVersion: typeof workerProtocolVersion;
  kind: 'ack';
  requestId: string;
  sequence: number;
}

export interface WorkerProgressMessage {
  protocolVersion: typeof workerProtocolVersion;
  kind: 'progress';
  requestId: string;
  /** Monotonic batch sequence; the Worker waits for the matching ACK. */
  sequence: number;
  batch: unknown[];
}

export interface WorkerResultMessage {
  protocolVersion: typeof workerProtocolVersion;
  kind: 'result';
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
  /** True only for the single terminal result produced by an accepted cancel. */
  cancelled?: true;
}

export type WorkerInboundMessage = WorkerRequestMessage | WorkerCancelMessage | WorkerAckMessage;

export type WorkerOutboundMessage = WorkerProgressMessage | WorkerResultMessage;

export function isWorkerInboundMessage(value: unknown): value is WorkerInboundMessage {
  if (!isRecord(value)
    || !hasOwn(value, 'protocolVersion')
    || !hasOwn(value, 'kind')
    || !hasOwn(value, 'requestId')
    || value.protocolVersion !== workerProtocolVersion
    || !isNonEmptyString(value.requestId)) {
    return false;
  }
  if (value.kind === 'cancel') {
    return hasOnlyKeys(value, ['protocolVersion', 'kind', 'requestId']);
  }
  if (value.kind === 'ack') {
    return hasOnlyKeys(value, ['protocolVersion', 'kind', 'requestId', 'sequence'])
      && hasOwn(value, 'sequence')
      && Number.isSafeInteger(value.sequence)
      && (value.sequence as number) >= 0;
  }
  if (value.kind !== 'request'
    || !hasOnlyKeys(value, ['protocolVersion', 'kind', 'requestId', 'jobId', 'job'])
    || !hasOwn(value, 'jobId')
    || !hasOwn(value, 'job')
    || !isNonEmptyString(value.jobId)
    || !isRecord(value.job)
    || !hasOnlyKeys(value.job, ['kind', 'payload'])
    || !hasOwn(value.job, 'kind')
    || !isNonEmptyString(value.job.kind)) {
    return false;
  }
  return true;
}

export function isWorkerOutboundMessage(value: unknown): value is WorkerOutboundMessage {
  if (!isRecord(value)
    || !hasOwn(value, 'protocolVersion')
    || !hasOwn(value, 'kind')
    || !hasOwn(value, 'requestId')
    || value.protocolVersion !== workerProtocolVersion
    || !isNonEmptyString(value.requestId)) {
    return false;
  }
  if (value.kind === 'progress') {
    return hasOnlyKeys(value, ['protocolVersion', 'kind', 'requestId', 'sequence', 'batch'])
      && hasOwn(value, 'sequence')
      && Number.isSafeInteger(value.sequence)
      && (value.sequence as number) >= 0
      && hasOwn(value, 'batch')
      && Array.isArray(value.batch);
  }
  if (value.kind !== 'result'
    || !hasOnlyKeys(value, ['protocolVersion', 'kind', 'requestId', 'ok', 'payload', 'error', 'cancelled'])
    || !hasOwn(value, 'ok')
    || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok) {
    return value.error === undefined && value.cancelled === undefined;
  }
  return isNonEmptyString(value.error)
    && (value.cancelled === undefined || value.cancelled === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
