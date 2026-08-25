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
  abortController: AbortController;
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
    worker.onMessage((message) => this.handleMessage(message));
  }

  /** Start a job. Resolves exactly once; rejections come only from worker death. */
  async start(
    job: WorkerJob,
    options: { signal?: AbortSignal; onProgress?: (batch: unknown[]) => void } = {}
  ): Promise<WorkerOutboundMessage> {
    if (!this.worker) {
      throw new Error('WorkerClient has no worker. attach() first.');
    }
    const requestId = `req-${this.requestCounter++}`;
    const jobId = `job-${requestId}`;
    let settle!: (message: WorkerOutboundMessage) => void;
    const promise = new Promise<WorkerOutboundMessage>((resolve) => {
      settle = resolve;
    });
    const entry: WorkerClientRequest = {
      requestId,
      jobId,
      promise,
      settle,
      abortController: new AbortController()
    };
    this.pending.set(requestId, entry);

    const message: WorkerRequestMessage = {
      protocolVersion: workerProtocolVersion,
      kind: 'request',
      requestId,
      jobId,
      job
    };
    this.worker.postMessage(message);

    if (options.signal) {
      if (options.signal.aborted) {
        this.cancel(requestId);
      } else {
        options.signal.addEventListener('abort', () => this.cancel(requestId), { once: true });
      }
    }

    return await promise;
  }

  private cancel(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry || !this.worker) {
      return;
    }
    const message: WorkerCancelMessage = {
      protocolVersion: workerProtocolVersion,
      kind: 'cancel',
      requestId
    };
    this.worker.postMessage(message);
    // After the grace period, force-terminate the worker so a wedged job can
    // never hold the session; the next job recreates a fresh worker.
    const timer = setTimeout(() => {
      if (this.pending.has(requestId)) {
        this.disposeWorker(`cancelled job ${requestId} did not settle within the grace period`);
      }
    }, this.options.cancelGraceMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  private handleMessage(raw: unknown): void {
    if (!isWorkerOutboundMessage(raw)) {
      // Protocol violations are dropped; a stuck request times out or is cancelled.
      return;
    }
    if (raw.kind === 'progress') {
      // Progress batches are folded into the final result for phase 1; the
      // streaming consumer shape lands with real jobs.
      return;
    }
    const entry = this.pending.get(raw.requestId);
    if (!entry) {
      return;
    }
    this.pending.delete(raw.requestId);
    entry.settle(raw);
  }

  /** Force-stop the worker; every pending request settles with an error result. */
  dispose(): void {
    this.disposeWorker('worker disposed');
  }

  private disposeWorker(reason: string): void {
    const worker = this.worker;
    this.worker = undefined;
    const crashedWithPending = this.pending.size > 0;
    for (const [requestId, entry] of this.pending) {
      this.pending.delete(requestId);
      entry.abortController.abort();
      entry.settle({
        protocolVersion: workerProtocolVersion,
        kind: 'result',
        requestId,
        ok: false,
        error: reason
      });
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
}
