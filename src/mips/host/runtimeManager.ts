// @index mips-host — MipsRuntimeManager：懒启动 Worker 骨架与生命周期
import * as path from 'path';
import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import { WorkerClient, MipsWorkerPort } from './workerClient';
import { WorkerJob, WorkerOutboundMessage, workerProtocolVersion } from './workerProtocol';

/**
 * Lazy worker host (plan section 5.6). Activation only constructs this manager;
 * the first assemble/execute request starts out/mips/host/workerMain.js.
 * Phase 1 has no builtin engine yet, so production never starts a worker; the
 * skeleton is exercised by unit tests only.
 */
export class MipsRuntimeManager implements vscode.Disposable {
  private readonly client: WorkerClient;
  private worker: Worker | undefined;
  private disposed = false;

  constructor(options: { workerPath?: string; cancelGraceMs?: number } = {}) {
    this.client = new WorkerClient({ cancelGraceMs: options.cancelGraceMs });
    this.workerPath = options.workerPath ?? path.join(__dirname, 'workerMain.js');
  }

  /** Resolved worker entry file; overridable for tests. */
  private readonly workerPath: string;

  /** True only after the worker has actually been started. */
  get started(): boolean {
    return this.client.started;
  }

  /** Start the worker on first use and keep it until dispose. */
  ensureWorker(): Worker {
    if (this.disposed) {
      throw new Error('MipsRuntimeManager is disposed.');
    }
    // A forced client-side cancellation detaches immediately while
    // Worker.terminate() finishes asynchronously. Do not keep that stale
    // Worker object as the current generation.
    if (this.worker && !this.client.started) {
      this.worker = undefined;
    }
    if (!this.worker) {
      const worker = new Worker(this.workerPath);
      this.worker = worker;
      const port: MipsWorkerPort = {
        postMessage: (value) => worker.postMessage(value),
        onMessage: (listener) => worker.on('message', listener),
        dispose: () => worker.terminate().catch(() => undefined)
      };
      this.client.attach(port);
      worker.on('error', (error) => {
        if (this.worker !== worker) {
          return;
        }
        this.worker = undefined;
        // Settles pending requests with an error result; the next request
        // rebuilds a fresh worker.
        this.client.handlePortFailure(port, `worker error: ${error.message}`);
      });
      worker.on('exit', (code) => {
        if (this.worker !== worker) {
          return;
        }
        this.worker = undefined;
        this.client.handlePortFailure(port, `worker exited with code ${code}`);
      });
    }
    return this.worker;
  }

  /**
   * Run one bounded ISA worker job. The default execution provider remains
   * legacy MARS, while catalog encode/decode jobs use this lazy worker path.
   */
  async runJob(
    job: WorkerJob,
    options: { signal?: AbortSignal; onProgress?: (batch: unknown[]) => void | Promise<void> } = {}
  ): Promise<WorkerOutboundMessage> {
    if (this.disposed) {
      throw new Error('MipsRuntimeManager is disposed.');
    }
    if (options.signal?.aborted) {
      // WorkerClient creates the protocol-shaped cancelled result without
      // requiring an attached port, so a pre-cancelled job stays fully lazy.
      return await this.client.start(job, options);
    }
    this.ensureWorker();
    return await this.client.start(job, options);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.client.dispose();
    this.worker = undefined;
  }

  /** Stable protocol revision for diagnostics. */
  static readonly protocolVersion = workerProtocolVersion;
}
