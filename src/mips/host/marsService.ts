// @index mips-host — 内部 MARS 文件汇编/运行编排，与课程执行共用 Worker 和核心
import * as path from 'path';
import type { ProgramImage } from '../core/api';
import type { AssemblerServiceResult } from '../core/assembler/assemblyService';
import type { MarsMemoryConfiguration } from '../core/profiles/marsMemoryLayout';
import type { MarsIoRequest } from '../core/mars/api';
import { captureAssemblyInput } from './sourceInput';
import { MarsConsole, MarsHostIo } from './marsIo';
import type { WorkerJob, WorkerOutboundMessage } from './workerProtocol';
import type { RunResult } from '../../types';

export interface MarsRuntimeHost {
  runJob(job: WorkerJob, options?: {
    signal?: AbortSignal; onProgress?: (batch: unknown[]) => unknown | Promise<unknown>;
  }): Promise<WorkerOutboundMessage>;
}

export interface MarsOperationOptions {
  sourcePath: string;
  allowedRoot: string;
  memoryConfiguration: MarsMemoryConfiguration;
  delayedBranching: boolean;
  timeoutMs: number;
  maxSteps?: number;
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
  console?: MarsConsole;
  runtime?: MarsRuntimeHost;
}

/** This mode is ordinary MARS console execution, never the P7 CPU exception oracle. */
export async function runInternalMars(options: MarsOperationOptions, execute: boolean): Promise<{
  result: RunResult; image?: ProgramImage;
}> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  const output: string[] = [];
  const io = new MarsHostIo({
    cwd: path.dirname(options.sourcePath), stdin: options.stdin, signal: controller.signal,
    console: {
      write: async (text) => { output.push(text); await options.console?.write(text); },
      readLine: options.console?.readLine
    }
  });
  const base: RunResult = {
    ok: false, exitCode: null, commandLine: `internal-mars ${execute ? 'run' : 'assemble'}`,
    cwd: path.dirname(options.sourcePath), stdout: '', stderr: '', timedOut: false
  };
  const progress = async (batch: unknown[]): Promise<unknown> => {
    if (batch.length !== 1 || typeof batch[0] !== 'object' || batch[0] === null) throw new Error('Invalid MARS I/O batch');
    const item = batch[0] as { kind?: string; request?: MarsIoRequest };
    if (item.kind !== 'mars-io' || !item.request) throw new Error('Invalid MARS I/O request');
    return await io.respond(item.request);
  };
  const job = async (request: WorkerJob): Promise<unknown> => {
    if (controller.signal.aborted) throw new Error('cancelled');
    if (!options.runtime) {
      const { executeProductionWorkerJob } = await import('./workerJobs');
      return executeProductionWorkerJob(request.kind, request.payload, { signal: controller.signal, emitProgress: progress });
    }
    const result = await options.runtime.runJob(request, { signal: controller.signal, onProgress: progress });
    if (result.kind !== 'result' || !result.ok) {
      throw new Error(result.kind === 'result' ? result.error : 'Invalid MARS Worker result');
    }
    return result.payload;
  };
  try {
    if (controller.signal.aborted) throw new Error('cancelled');
    const input = await captureAssemblyInput(options.sourcePath, options.allowedRoot);
    const assembly = await job({ kind: 'mars-assemble', payload: {
      ...input, memoryConfiguration: options.memoryConfiguration, delayedBranching: options.delayedBranching
    } }) as AssemblerServiceResult;
    if (!assembly.ok || !assembly.image) {
      return { result: { ...base, stderr: assembly.diagnostics.map((item) => `[${item.code}] ${item.message}`).join('\n') } };
    }
    if (!execute) return { result: { ...base, ok: true, exitCode: 0 }, image: assembly.image };
    const execution = await job({ kind: 'mars-execute', payload: {
      image: assembly.image, memoryConfiguration: options.memoryConfiguration,
      delayedBranching: options.delayedBranching, maxSteps: options.maxSteps ?? 10_000_000
    } }) as { status: string; exitCode?: number; diagnostic?: string };
    await io.finishOutput();
    const ok = execution.status === 'exited';
    return { image: assembly.image, result: {
      ...base, ok, stdout: output.join(''), exitCode: execution.exitCode ?? (ok ? 0 : null),
      stderr: execution.diagnostic ?? '', stopReason: execution.status
    } };
  } catch (error) {
    await io.finishOutput().catch(() => undefined);
    return { result: { ...base, stdout: output.join(''), timedOut,
      stopped: controller.signal.aborted, stopReason: timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'engine-error',
      stderr: timedOut ? `内部 MARS 运行超时（${options.timeoutMs} ms）` : error instanceof Error ? error.message : String(error)
    } };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
    await io.dispose();
  }
}
