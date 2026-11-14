// @index mips-host — MipsRuntimeManager：懒启动 Worker 骨架与生命周期
import * as path from 'path';
import { extensionRoot } from '../../resourcePaths';
import type * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import {
  WorkerClient,
  MipsWorkerPort,
  type WorkerProtocolObservation
} from './workerClient';
import { WorkerJob, WorkerOutboundMessage, workerProtocolVersion } from './workerProtocol';
import type { ScriptInstructionBundle } from './scriptInstructionBundle';

export interface ScriptJobOptions {
  signal?: AbortSignal;
  onProgress?: (batch: unknown[]) => unknown | Promise<unknown>;
  /** Maximum active interval between progress batches; host input waits are excluded. */
  timeoutMs?: number;
}

/**
 * Lazy worker host (plan section 5.6). Activation only constructs this manager;
 * the first assemble/execute request starts out/mips/host/workerMain.js.
 * Ordinary MARS and course jobs share this cancellable, isolated worker.
 */
export class MipsRuntimeManager implements vscode.Disposable {
  private readonly client: WorkerClient;
  private worker: Worker | undefined;
  private disposed = false;
  private readonly isolated = new Set<WorkerClient>();

  constructor(options: {
    workerPath?: string;
    scriptWorkerPath?: string;
    cancelGraceMs?: number;
    observeProtocol?: (observation: WorkerProtocolObservation) => void;
  } = {}) {
    this.client = new WorkerClient({
      cancelGraceMs: options.cancelGraceMs,
      observeProtocol: options.observeProtocol
    });
    this.workerPath = options.workerPath ?? path.join(extensionRoot, 'out', 'mips', 'host', 'workerMain.js');
    this.scriptWorkerPath = options.scriptWorkerPath ?? path.join(extensionRoot, 'out', 'scriptInstructionWorker.js');
  }

  /** Resolved worker entry file; overridable for tests. */
  private readonly workerPath: string;
  private readonly scriptWorkerPath: string;

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
   * Run one bounded assembly/execution/ISA job on the lazy worker.
   */
  async runJob(
    job: WorkerJob,
    options: { signal?: AbortSignal; onProgress?: (batch: unknown[]) => unknown | Promise<unknown> } = {}
  ): Promise<WorkerOutboundMessage> {
    if (this.disposed) {
      throw new Error('MipsRuntimeManager is disposed.');
    }
    if (options.signal?.aborted) {
      // WorkerClient creates the protocol-shaped cancelled result without
      // requiring an attached port, so a pre-cancelled job stays fully lazy.
      return await this.client.start(job, options);
    }
    if (job.kind === 'script-job' || job.kind === 'script-capture') return this.runIsolatedJob(job, options);
    this.ensureWorker();
    return await this.client.start(job, options);
  }

  async runScriptJob(bundle: ScriptInstructionBundle, job: WorkerJob, options: ScriptJobOptions = {}): Promise<WorkerOutboundMessage> {
    return this.runIsolatedJob({ kind: 'script-job', payload: { bundle, job } }, options);
  }

  /** User callbacks never share the ordinary MIPS worker or run on the extension host. */
  async runIsolatedJob(job: WorkerJob, options: ScriptJobOptions = {}): Promise<WorkerOutboundMessage> {
    if (this.disposed) throw new Error('MipsRuntimeManager is disposed.');
    const client = new WorkerClient({ cancelGraceMs: 20 });
    if (options.signal?.aborted) return client.start(job, options);
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('Script job timeout must be in 1..300000 milliseconds');
    const worker = new Worker(this.scriptWorkerPath, { execArgv: ['--experimental-vm-modules'], resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
    const port: MipsWorkerPort = {
      postMessage: value => worker.postMessage(value),
      onMessage: listener => worker.on('message', listener),
      dispose: () => { void worker.terminate(); }
    };
    client.attach(port);
    this.isolated.add(client);
    worker.on('error', error => client.handlePortFailure(port, `script worker error: ${error.message}`));
    worker.on('exit', code => client.handlePortFailure(port, `script worker exited with code ${code}`));
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const armTimeout = () => { timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); };
    armTimeout();
    try {
      const result = await client.start(job, { signal: controller.signal, onProgress: async batch => {
        clearTimeout(timer);
        try { return await options.onProgress?.(batch); }
        finally { if (!controller.signal.aborted) armTimeout(); }
      } });
      if (timedOut && result.kind === 'result') return { ...result, ok: false, cancelled: undefined, error: `Custom instruction job exceeded its ${timeoutMs} ms active-time limit (possible infinite loop)` };
      return result;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      this.isolated.delete(client);
      client.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.client.dispose();
    for (const client of this.isolated) client.dispose();
    this.isolated.clear();
    this.worker = undefined;
  }

  /** Stable protocol revision for diagnostics. */
  static readonly protocolVersion = workerProtocolVersion;
}
