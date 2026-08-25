// @index mips-host — WorkerClient：host 侧消息往返、取消与崩溃恢复
import {
  isWorkerOutboundMessage,
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
  onProgress?: (batch: unknown[]) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  cancelTimer?: NodeJS.Timeout;
}

export interface WorkerClientOptions {
  /** Grace period between a cancel message and worker termination. */
  cancelGraceMs?: number;
}

export class WorkerClient {
  private worker: MipsWorkerPort | undefined;
  private readonly pending = new Map<string, WorkerClientRequest>();
  private readonly options: Required<WorkerClientOptions>;
  private requestCounter = 0;
  /** Called once when the worker dies with pending requests (tests observe this). */
  onWorkerCrash: ((reason: string) => void) | undefined;

  constructor(options: WorkerClientOptions = {}) {
    this.options = { cancelGraceMs: options.cancelGraceMs ?? 2000 };
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
    options: { signal?: AbortSignal; onProgress?: (batch: unknown[]) => void } = {}
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
    if (entry.cancelTimer) {
      return;
    }
    const message: WorkerCancelMessage = {
      protocolVersion: workerProtocolVersion,
      kind: 'cancel',
      requestId
    };
    try {
      this.worker.postMessage(message);
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
    if (raw.kind === 'progress') {
      const entry = this.pending.get(raw.requestId);
      if (!entry) {
        return;
      }
      try {
        entry.onProgress?.(raw.batch);
      } catch {
        // A UI/progress consumer must not corrupt the worker protocol lifecycle.
      }
      return;
    }
    const entry = this.pending.get(raw.requestId);
    if (!entry) {
      return;
    }
    this.settleEntry(entry, raw);
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
        entry.cancelTimer
          ? cancelledResult(entry.requestId, reason)
          : {
            protocolVersion: workerProtocolVersion,
            kind: 'result',
            requestId: entry.requestId,
            ok: false,
            error: reason
          }
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
