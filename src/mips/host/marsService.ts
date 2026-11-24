// @index mips-host — 内部 MARS 文件汇编/运行编排，与课程执行共用 Worker 和核心
import * as path from 'path';
import type { ProgramImage } from '../core/api';
import type { AssemblerServiceResult } from '../core/assembler/assemblyService';
import type { MarsMemoryConfiguration } from '../core/profiles/marsMemoryLayout';
import type { MarsIoRequest } from '../core/mars/api';
import type { DebugMode } from '../core/debug/api';
import type { CommitEvent } from '../core/events/commitEvent';
import { formatArchitecturalWrites, projectCommitEvents } from '../core/events/traceProjection';
import type { CourseProfile } from '../core/generated/isaCatalog';
import { maximumExecuteSteps, type ExecuteServiceResult } from '../core/machine/executeService';
import { resolveCourseProfile } from '../core/profiles/courseProfiles';
import { maximumReplayTraceBytes } from '../replay/boundedFile';
import { captureAssemblyInput } from './sourceInput';
import { MarsConsole, MarsHostIo } from './marsIo';
import type { WorkerJob, WorkerOutboundMessage } from './workerProtocol';
import type { RunResult } from '../../types';
import type { AssemblerDiagnostic } from '../core/assembler/diagnostics';
import type { ScriptInstructionBundle } from './scriptInstructionBundle';
import { courseModeForConsoleAssembly, customInstructionAssemblyHint, WorkspaceCustomInstructions } from './customInstructionService';
import { runCustomMarsConsole } from './customMarsConsole';
import { courseExecutionImagePayload, mipsAssemblyJob } from './mipsWorkerRequests';

export interface MarsRuntimeHost {
  readonly instructionMetadata?: readonly import('../core/custom/api').CustomInstructionMetadata[];
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
  scriptInstructions?: ScriptInstructionBundle | null;
  workspaceInstructions?: WorkspaceCustomInstructions;
  courseProfile?: CourseProfile;
}

/** Console dispatch. Retry assembly in the project course mode only for a declared course-only mnemonic. */
export async function runInternalMars(options: MarsOperationOptions, execute: boolean): Promise<{
  result: RunResult; image?: ProgramImage; assemblyDiagnostics?: readonly AssemblerDiagnostic[]; engine?: 'custom-mars' | 'builtin-ts';
}> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  const output: string[] = [];
  let runtime = options.runtime;
  let engine: 'custom-mars' | 'builtin-ts' = 'builtin-ts';
  let outputBytes = 0;
  const write = async (text: string): Promise<void> => {
    outputBytes += Buffer.byteLength(text, 'utf8');
    if (outputBytes > maximumReplayTraceBytes) throw new Error('MIPS 控制台输出超过 16 MiB 上限');
    output.push(text);
    await options.console?.write(text);
  };
  const io = new MarsHostIo({
    cwd: path.dirname(options.sourcePath), stdin: options.stdin, signal: controller.signal,
    console: {
      write,
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
  const job = async (request: WorkerJob, onProgress: (batch: unknown[]) => unknown | Promise<unknown> = progress): Promise<unknown> => {
    if (controller.signal.aborted) throw new Error('cancelled');
    if (!runtime) {
      const { executeProductionWorkerJob } = await import('./workerJobs');
      return executeProductionWorkerJob(request.kind, request.payload, { signal: controller.signal, emitProgress: onProgress });
    }
    const result = await runtime.runJob(request, { signal: controller.signal, onProgress });
    if (result.kind !== 'result' || !result.ok) {
      throw new Error(result.kind === 'result' ? result.error : 'Invalid MARS Worker result');
    }
    return result.payload;
  };
  try {
    if (controller.signal.aborted) throw new Error('cancelled');
    const signal = controller.signal;
    const workspace = options.workspaceInstructions ?? new WorkspaceCustomInstructions(options.allowedRoot);
    const selected = await workspace.select({ snapshot: options.scriptInstructions, runtime, signal });
    if (selected.kind === 'mars') {
      engine = 'custom-mars';
      const instructions = await selected.bind(signal);
      const external = await runCustomMarsConsole(instructions, options.sourcePath, workspace.root, execute, { ...options, signal });
      return { ...external, engine, result: timedOut ? {
        ...external.result, ok: false, stopped: true, timedOut: true, stopReason: 'timeout', stderr: `外部 Mars 运行超时（${options.timeoutMs} ms）`
      } : external.result };
    }
    if (selected.kind === 'script') runtime = selected.runtime;
    const input = await captureAssemblyInput(options.sourcePath, options.allowedRoot);
    let mode: DebugMode = { kind: 'mars', memoryConfiguration: options.memoryConfiguration, delayedBranching: options.delayedBranching };
    let assembly = await job(mipsAssemblyJob(mode, input)) as AssemblerServiceResult;
    const metadata = !assembly.ok && selected.kind === 'script'
      && assembly.diagnostics.some(item => item.code === 'asm.instruction.unknown') ? await selected.inspect(signal) : [];
    const profile = courseModeForConsoleAssembly(assembly.diagnostics, metadata, options.courseProfile);
    if (profile) {
      mode = { kind: 'course', profile };
      assembly = await job(mipsAssemblyJob(mode, input)) as AssemblerServiceResult;
    }
    if (!assembly.ok || !assembly.image) {
      const hint = customInstructionAssemblyHint(assembly.diagnostics, profile ?? 'mars', selected.kind, metadata);
      const details = assembly.diagnostics.map(item => `[${item.code}] ${item.message}`);
      if (hint) details.push(hint);
      return { assemblyDiagnostics: assembly.diagnostics, result: { ...base, stderr: details.join('\n') } };
    }
    const image = assembly.image;
    if (!execute) return { result: { ...base, ok: true, exitCode: 0 }, image };
    if (mode.kind === 'course') {
      const profile = resolveCourseProfile(mode.profile);
      const execution = await job({ kind: 'machine-execute', payload: {
        ...courseExecutionImagePayload(image), profile: mode.profile,
        enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
        maxSteps: Math.min(options.maxSteps ?? 65_536, maximumExecuteSteps)
      } }, async batch => {
        const trace = formatArchitecturalWrites(projectCommitEvents(batch as CommitEvent[], profile));
        if (trace) await write(trace + '\n');
      }) as ExecuteServiceResult;
      const ok = execution.status === 'halted' && execution.haltReason === 'course-halt-loop';
      const diagnostic = execution.diagnostic;
      return { image, result: {
        ...base, commandLine: `internal-mips ${mode.profile} run`, ok, stdout: output.join(''), exitCode: ok ? 0 : null,
        stderr: diagnostic ? `[${diagnostic.code}] ${diagnostic.pc ?? ''} ${diagnostic.message}` : ok ? '' : '课程程序未到达停机自环',
        stopReason: ok ? 'halt-loop' : execution.status
      } };
    }
    const execution = await job({ kind: 'mars-execute', payload: {
      image: assembly.image, memoryConfiguration: options.memoryConfiguration,
      delayedBranching: options.delayedBranching, maxSteps: options.maxSteps ?? 10_000_000
    } }) as { status: string; exitCode?: number; diagnostic?: string };
    await io.finishOutput();
    const ok = execution.status === 'exited';
    return { image, result: {
      ...base, ok, stdout: output.join(''), exitCode: execution.exitCode ?? (ok ? 0 : null),
      stderr: execution.diagnostic ?? '', stopReason: execution.status
    } };
  } catch (error) {
    await io.finishOutput().catch(() => undefined);
    return { engine, result: { ...base, stdout: output.join(''), timedOut,
      stopped: controller.signal.aborted, stopReason: timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'engine-error',
      stderr: timedOut ? `内部 MARS 运行超时（${options.timeoutMs} ms）` : error instanceof Error ? error.message : String(error)
    } };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
    await io.dispose();
  }
}
