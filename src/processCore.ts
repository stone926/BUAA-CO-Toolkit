import { spawn } from 'child_process';
import { LineChunkScanner, TextChunkAccumulator } from './textChunks';
// @index orchestration — 无 VS Code 依赖的 spawn/stdout/stderr/timeout/AbortSignal 进程执行核心

export interface RunProcessCoreOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
  commandLine?: string;
  /**
   * External cancellation (plan section 1.6): on abort the child is first
   * stopped gracefully, then force-killed with its whole process tree after
   * cancelGraceMs. Idempotent; the promise settles exactly once.
   */
  signal?: AbortSignal;
  /** Grace period between the graceful stop and force termination (ms). */
  cancelGraceMs?: number;
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

const DEFAULT_CANCEL_GRACE_MS = 2000;

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
    let forceTimer: NodeJS.Timeout | undefined;
    let lastExitCode: number | null = null;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {})
      },
      shell: false,
      windowsHide: true,
      // On POSIX this puts the child into its own process group so the whole
      // tree can be signalled; Windows uses taskkill /t instead.
      detached: process.platform !== 'win32'
    });

    const resolveOnce = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(finalResult({
        exitCode: lastExitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        stopped,
        stopReason
      }, options));
    };

    const forceKillProcessTree = (): void => {
      if (settled || child.pid === undefined) {
        return;
      }
      if (process.platform === 'win32') {
        // taskkill /t /f terminates the child and every descendant; the close
        // event below settles the promise.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore'
        });
        killer.on('error', () => {
          // Last resort when taskkill itself is unavailable.
          child.kill();
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill();
        }
      }
    };

    const gracefulStop = (reason?: string): void => {
      if (settled || stopped) {
        return;
      }
      stopped = true;
      stopReason = reason;
      if (child.pid !== undefined) {
        if (process.platform === 'win32') {
          child.kill();
        } else {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill();
          }
        }
      }
      forceTimer = setTimeout(() => forceKillProcessTree(), options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
      forceTimer.unref?.();
    };

    const control: RunProcessCoreControl = {
      stop(reason?: string): void {
        gracefulStop(reason);
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
          gracefulStop('timeout');
        }
      }, options.timeoutMs)
      : undefined;

    const onAbort = (): void => {
      gracefulStop('aborted');
    };
    if (options.signal) {
      if (options.signal.aborted) {
        gracefulStop('aborted');
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

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

    // The child may exit before stdin is consumed; swallow the resulting EPIPE.
    child.stdin.on('error', () => undefined);

    child.on('error', (error: Error) => {
      options.onError?.(error);
      stderr.append(error.message);
      resolveOnce();
    });

    child.on('close', (code: number | null) => {
      lastExitCode = code;
      stdoutLines?.flush();
      resolveOnce();
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
