import { spawn } from 'child_process';
import { LineChunkScanner, TextChunkAccumulator } from './textChunks';
// @index orchestration — 无 VS Code 依赖的 spawn/stdout/stderr/timeout 进程执行核心

export interface RunProcessCoreOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
  commandLine?: string;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  onStdoutLine?: (line: string, control: RunProcessCoreControl) => void;
  onError?: (error: Error) => void;
  onTimeout?: () => void;
  successPredicate?: (result: RunProcessCoreBaseResult) => boolean;
}

export interface RunProcessCoreControl {
  stop(reason?: string): void;
}

export interface RunProcessCoreBaseResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stopped: boolean;
  stopReason?: string;
}

export interface RunProcessCoreResult extends RunProcessCoreBaseResult {
  ok: boolean;
  commandLine: string;
  cwd: string;
}

export function runProcessCore(
  command: string,
  args: readonly string[],
  options: RunProcessCoreOptions
): Promise<RunProcessCoreResult> {
  return new Promise((resolve) => {
    const stdout = new TextChunkAccumulator();
    const stderr = new TextChunkAccumulator();
    let settled = false;
    let timedOut = false;
    let stopped = false;
    let stopReason: string | undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {})
      },
      shell: false,
      windowsHide: true
    });
    const control: RunProcessCoreControl = {
      stop(reason?: string): void {
        if (settled || stopped) {
          return;
        }
        stopped = true;
        stopReason = reason;
        child.kill();
      }
    };
    const stdoutLines = options.onStdoutLine
      ? new LineChunkScanner((line) => options.onStdoutLine?.(line, control))
      : undefined;
    const timer = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
        stdoutLines?.flush();
        if (!stopped) {
          timedOut = true;
          options.onTimeout?.();
          child.kill();
        }
      }, options.timeoutMs)
      : undefined;

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout.append(text);
      options.onStdout?.(text);
      stdoutLines?.append(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr.append(text);
      options.onStderr?.(text);
    });

    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      stderr.append(error.message);
      options.onError?.(error);
      resolve(finalResult({
        exitCode: null,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        stopped,
        stopReason
      }, options));
    });

    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      stdoutLines?.flush();
      resolve(finalResult({
        exitCode: code,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        stopped,
        stopReason
      }, options));
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

function finalResult(
  base: RunProcessCoreBaseResult,
  options: RunProcessCoreOptions
): RunProcessCoreResult {
  const ok = options.successPredicate
    ? options.successPredicate(base)
    : base.exitCode === 0 && !base.timedOut;
  return {
    ...base,
    ok,
    commandLine: options.commandLine ?? '',
    cwd: options.cwd
  };
}
