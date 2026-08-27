// @index mips-host — WorkerClient：host 侧消息往返、取消与崩溃恢复
import {
  isWorkerOutboundMessage,
  WorkerAckMessage,
  WorkerCancelMessage,
  WorkerJob,
  WorkerOutboundMessage,
  WorkerRequestMessage,
  workerProtocolVersion
} from './workerProtocol';

/**
 * Minimal worker port so the client works with both node worker_threads
 * (extension host, LSP process, tests) and vscode.Worker.
 */
export interface MipsWorkerPort {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): void;
  dispose(): void;
}

/**
 * One request travelling through the worker protocol. The client settles the
 * promise exactly once: on the result message, on cancellation (worker sends a
 * cancelled result after honoring cancel, or the client terminates the worker
 * after the grace period), or when the worker crashes.
 */
export interface WorkerClientRequest {
  requestId: string;
  jobId: string;
  promise: Promise<WorkerOutboundMessage>;
  settle: (message: WorkerOutboundMessage) => void;
  onProgress?: (batch: unknown[]) => void | Promise<void>;
  /** Next progress sequence accepted from this worker generation. */
  expectedProgressSequence: number;
  /** True while the consumer is still applying the current progress batch. */
  progressInFlight: boolean;
  /** Set before posting cancel so even a synchronous terminal response observes it. */
  cancelRequested: boolean;
  /** Consumer failures override the worker's subsequent cancelled terminal result. */
  terminalFailure?: WorkerOutboundMessage;
  signal?: AbortSignal;
  abortListener?: () => void;
  cancelTimer?: NodeJS.Timeout;
}

export interface WorkerClientOptions {
  /** Grace period between a cancel message and worker termination. */
  cancelGraceMs?: number;
  /** Test/evidence hook; observes protocol metadata but never job payload contents. */
  observeProtocol?: (observation: WorkerProtocolObservation) => void;
}

export interface WorkerProtocolObservation {
  direction: 'in' | 'out';
  kind: 'request' | 'cancel' | 'ack' | 'progress' | 'result';
  requestId: string;
  sequence?: number;
}

export class WorkerClient {
  private worker: MipsWorkerPort | undefined;
  private readonly pending = new Map<string, WorkerClientRequest>();
  private readonly options: {
    cancelGraceMs: number;
    observeProtocol?: (observation: WorkerProtocolObservation) => void;
  };
  private requestCounter = 0;
  /** Called once when the worker dies with pending requests (tests observe this). */
  onWorkerCrash: ((reason: string) => void) | undefined;

  constructor(options: WorkerClientOptions = {}) {
    this.options = {
      cancelGraceMs: options.cancelGraceMs ?? 2000,
      observeProtocol: options.observeProtocol
    };
  }

  /** True while a worker instance is attached. */
  get started(): boolean {
    return this.worker !== undefined;
  }

  /** Attach a worker implementation; idempotent only for one worker at a time. */
  attach(worker: MipsWorkerPort): void {
    if (this.worker) {
      throw new Error('WorkerClient already has a worker; dispose it first.');
    }
    this.worker = worker;
    worker.onMessage((message) => {
      if (this.worker === worker) {
        this.handleMessage(message);
      }
    });
  }

  /** Start a job. Resolves exactly once; rejections come only from worker death. */
  async start(
    job: WorkerJob,
    options: { signal?: AbortSignal; onProgress?: (batch: unknown[]) => void | Promise<void> } = {}
  ): Promise<WorkerOutboundMessage> {
    const requestId = `req-${this.requestCounter++}`;
    const jobId = `job-${requestId}`;
    if (options.signal?.aborted) {
      return cancelledResult(requestId, 'job was cancelled before dispatch');
    }
    const worker = this.worker;
    if (!worker) {
      throw new Error('WorkerClient has no worker. attach() first.');
    }
    let settle!: (message: WorkerOutboundMessage) => void;
    const promise = new Promise<WorkerOutboundMessage>((resolve) => {
      settle = resolve;
    });
    const entry: WorkerClientRequest = {
      requestId,
      jobId,
      promise,
      settle,
      onProgress: options.onProgress,
      expectedProgressSequence: 0,
      progressInFlight: false,
      cancelRequested: false,
      signal: options.signal
    };
    this.pending.set(requestId, entry);

    const message: WorkerRequestMessage = {
      protocolVersion: workerProtocolVersion,
      kind: 'request',
      requestId,
      jobId,
      job
    };
    try {
      worker.postMessage(message);
      this.observe({ direction: 'out', kind: 'request', requestId });
    } catch (error) {
      this.disposeWorker(error instanceof Error ? error.message : String(error));
    }
    // Register after dispatch so an abort can never put `cancel` ahead of its
    // request. The post-registration check closes the already-aborted race.
    if (options.signal && this.pending.has(requestId)) {
      entry.abortListener = () => this.cancel(requestId);
      options.signal.addEventListener('abort', entry.abortListener, { once: true });
      if (options.signal.aborted) {
        this.cancel(requestId);
      }
    }

    return await promise;
  }

  private cancel(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry || !this.worker) {
      return;
    }
    if (entry.cancelRequested) {
      return;
    }
    entry.cancelRequested = true;
    const message: WorkerCancelMessage = {
      protocolVersion: workerProtocolVersion,
      kind: 'cancel',
      requestId
    };
    try {
      this.worker.postMessage(message);
      this.observe({ direction: 'out', kind: 'cancel', requestId });
    } catch (error) {
      this.disposeWorker(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!this.pending.has(requestId)) {
      return;
    }
    // After the grace period, force-terminate the worker so a wedged job can
    // never hold the session; the next job recreates a fresh worker.
    entry.cancelTimer = setTimeout(() => {
      if (this.pending.has(requestId)) {
        this.disposeWorker(`cancelled job ${requestId} did not settle within the grace period`);
      }
    }, this.options.cancelGraceMs);
    if (typeof entry.cancelTimer.unref === 'function') {
      entry.cancelTimer.unref();
    }
  }

  private handleMessage(raw: unknown): void {
    if (!isWorkerOutboundMessage(raw)) {
      // Fail closed. Silently dropping malformed terminal data would leave a
      // request pending forever because the phase-1 client has no job timeout.
      this.disposeWorker('worker protocol violation: malformed outbound message');
      return;
    }
    this.observe({
      direction: 'in',
      kind: raw.kind,
      requestId: raw.requestId,
      ...(raw.kind === 'progress' ? { sequence: raw.sequence } : {})
    });
    if (raw.kind === 'progress') {
      const entry = this.pending.get(raw.requestId);
      if (!entry) {
        return;
      }
      if (entry.progressInFlight || raw.sequence !== entry.expectedProgressSequence) {
        const detail = entry.progressInFlight
          ? `received progress sequence ${raw.sequence} before sequence ${entry.expectedProgressSequence} was acknowledged`
          : `expected progress sequence ${entry.expectedProgressSequence}, received ${raw.sequence}`;
        this.disposeWorker(`worker protocol violation: ${detail}`);
        return;
      }
      const worker = this.worker;
      entry.progressInFlight = true;
      void (async () => {
        try {
          await entry.onProgress?.(raw.batch);
        } catch (error) {
          this.failProgressConsumer(entry, error);
          return;
        }
        if (!worker
          || this.worker !== worker
          || this.pending.get(raw.requestId) !== entry
          || entry.cancelRequested
          || entry.terminalFailure) {
          return;
        }
        entry.progressInFlight = false;
        entry.expectedProgressSequence++;
        const ack: WorkerAckMessage = {
          protocolVersion: workerProtocolVersion,
          kind: 'ack',
          requestId: raw.requestId,
          sequence: raw.sequence
        };
        try {
          worker.postMessage(ack);
          this.observe({
            direction: 'out',
            kind: 'ack',
            requestId: raw.requestId,
            sequence: raw.sequence
          });
        } catch (error) {
          this.disposeWorker(error instanceof Error ? error.message : String(error));
        }
      })();
      return;
    }
    const entry = this.pending.get(raw.requestId);
    if (!entry) {
      return;
    }
    if (entry.progressInFlight
      && !entry.terminalFailure
      && !(entry.cancelRequested && !raw.ok && raw.cancelled === true)) {
      this.disposeWorker(
        `worker protocol violation: terminal result arrived before progress sequence ${entry.expectedProgressSequence} was acknowledged`
      );
      return;
    }
    this.settleEntry(entry, entry.terminalFailure ?? raw);
  }

  /** Force-stop the worker; every pending request settles with an error result. */
  dispose(): void {
    this.disposeWorker('worker disposed');
  }

  /** Ignore stale worker events; only the currently attached port may fail the client. */
  handlePortFailure(worker: MipsWorkerPort, reason: string): void {
    if (this.worker !== worker) {
      return;
    }
    this.disposeWorker(reason);
  }

  private disposeWorker(reason: string): void {
    const worker = this.worker;
    this.worker = undefined;
    const crashedWithPending = this.pending.size > 0;
    for (const entry of [...this.pending.values()]) {
      this.settleEntry(
        entry,
        entry.terminalFailure
          ?? (entry.cancelRequested
          ? cancelledResult(entry.requestId, reason)
          : {
            protocolVersion: workerProtocolVersion,
            kind: 'result',
            requestId: entry.requestId,
            ok: false,
            error: reason
          })
      );
    }
    try {
      worker?.dispose();
    } catch {
      // Best-effort disposal; the worker is already unreachable.
    }
    if (crashedWithPending) {
      this.onWorkerCrash?.(reason);
    }
  }

  private settleEntry(entry: WorkerClientRequest, message: WorkerOutboundMessage): void {
    if (!this.pending.delete(entry.requestId)) {
      return;
    }
    if (entry.cancelTimer) {
      clearTimeout(entry.cancelTimer);
      entry.cancelTimer = undefined;
    }
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener('abort', entry.abortListener);
      entry.abortListener = undefined;
    }
    entry.settle(message);
  }

  private failProgressConsumer(entry: WorkerClientRequest, error: unknown): void {
    if (this.pending.get(entry.requestId) !== entry || entry.terminalFailure) {
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    entry.terminalFailure = failedResult(entry.requestId, `progress consumer failed: ${detail}`);
    // Do not ACK a batch that was not consumed. Cancelling releases the worker's ACK wait;
    // its cancelled terminal result is then replaced with the consumer failure above.
    this.cancel(entry.requestId);
  }

  private observe(observation: WorkerProtocolObservation): void {
    try {
      this.options.observeProtocol?.(Object.freeze({ ...observation }));
    } catch {
      // Evidence instrumentation cannot affect protocol correctness or production execution.
    }
  }
}

function cancelledResult(requestId: string, error: string): WorkerOutboundMessage {
  return {
    protocolVersion: workerProtocolVersion,
    kind: 'result',
    requestId,
    ok: false,
    error,
    cancelled: true
  };
}

function failedResult(requestId: string, error: string): WorkerOutboundMessage {
  return {
    protocolVersion: workerProtocolVersion,
    kind: 'result',
    requestId,
    ok: false,
    error
  };
}
