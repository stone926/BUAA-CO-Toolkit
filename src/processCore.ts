import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
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
  /** Trusted raw-byte ceilings. Exceeding either one terminates the process tree. */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
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
  assertOutputLimit(options.maxStdoutBytes, 'maxStdoutBytes');
  assertOutputLimit(options.maxStderrBytes, 'maxStderrBytes');
  if (options.signal?.aborted) {
    return Promise.resolve(finalResult({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      stopped: true,
      stopReason: 'aborted'
    }, options));
  }
  return new Promise((resolve) => {
    const stdout = new TextChunkAccumulator();
    const stderr = new TextChunkAccumulator();
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutEnded = false;
    let stderrEnded = false;
    let settled = false;
    let timedOut = false;
    let stopped = false;
    let stopReason: string | undefined;
    let lastExitCode: number | null = null;
    let childClosed = false;
    let treeTerminationComplete = true;
    let timer: NodeJS.Timeout | undefined;

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
    const rootPid = child.pid;

    const appendStdout = (text: string): void => {
      if (!text) return;
      stdout.append(text);
      options.onStdout?.(text);
      stdoutLines?.append(text);
    };
    const appendStderr = (text: string): void => {
      if (!text) return;
      stderr.append(text);
      options.onStderr?.(text);
    };
    const finishDecoders = (): void => {
      if (!stdoutEnded) {
        stdoutEnded = true;
        appendStdout(stdoutDecoder.end());
      }
      if (!stderrEnded) {
        stderrEnded = true;
        appendStderr(stderrDecoder.end());
      }
    };

    const resolveOnce = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      finishDecoders();
      resolve(finalResult({
        exitCode: lastExitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        stopped,
        stopReason
      }, options));
    };

    const maybeResolve = (): void => {
      if (settled || !childClosed || (stopped && !treeTerminationComplete)) {
        return;
      }
      resolveOnce();
    };

    const gracefulStop = (reason?: string): void => {
      if (settled || stopped) {
        return;
      }
      stopped = true;
      stopReason = reason;
      treeTerminationComplete = false;
      if (rootPid === undefined) {
        treeTerminationComplete = true;
        maybeResolve();
        return;
      }
      // This lifecycle is intentionally independent from the root child's
      // `close` event. A parent may exit on the graceful signal while a
      // descendant ignores it; the force phase must still run for the group.
      void terminateProcessTree(
        rootPid,
        () => child.kill(),
        options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS
      ).catch(() => undefined).finally(() => {
        treeTerminationComplete = true;
        maybeResolve();
      });
    };

    const control: RunProcessCoreControl = {
      stop(reason?: string): void {
        gracefulStop(reason);
      }
    };
    const stdoutLines = options.onStdoutLine
      ? new LineChunkScanner((line) => options.onStdoutLine?.(line, control))
      : undefined;
    timer = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
        stdoutLines?.flush();
        if (!stopped) {
          timedOut = true;
          options.onTimeout?.();
          gracefulStop('timeout');
        }
      }, options.timeoutMs)
      : undefined;

    function onAbort(): void {
      gracefulStop('aborted');
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutEnded) return;
      const remaining = options.maxStdoutBytes === undefined
        ? chunk.byteLength
        : Math.max(0, options.maxStdoutBytes - stdoutBytes);
      const accepted = chunk.subarray(0, remaining);
      stdoutBytes += accepted.byteLength;
      appendStdout(stdoutDecoder.write(accepted));
      if (accepted.byteLength !== chunk.byteLength) {
        stdoutEnded = true;
        appendStdout(stdoutDecoder.end());
        gracefulStop('stdout-limit');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrEnded) return;
      const remaining = options.maxStderrBytes === undefined
        ? chunk.byteLength
        : Math.max(0, options.maxStderrBytes - stderrBytes);
      const accepted = chunk.subarray(0, remaining);
      stderrBytes += accepted.byteLength;
      appendStderr(stderrDecoder.write(accepted));
      if (accepted.byteLength !== chunk.byteLength) {
        stderrEnded = true;
        appendStderr(stderrDecoder.end());
        gracefulStop('stderr-limit');
      }
    });

    // The child may exit before stdin is consumed; swallow the resulting EPIPE.
    child.stdin.on('error', () => undefined);

    child.on('error', (error: Error) => {
      options.onError?.(error);
      appendStderr(error.message);
      childClosed = true;
      maybeResolve();
    });

    child.on('close', (code: number | null) => {
      lastExitCode = code;
      finishDecoders();
      stdoutLines?.flush();
      childClosed = true;
      maybeResolve();
    });

    if (options.signal) {
      if (options.signal.aborted) {
        gracefulStop('aborted');
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    if (!stopped && options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

function finalResult(
  base: RunProcessCoreBaseResult,
  options: RunProcessCoreOptions
): RunProcessCoreResult {
  const ok = base.timedOut || base.stopReason === 'aborted'
    ? false
    : options.successPredicate
      ? options.successPredicate(base)
      : base.exitCode === 0 && !base.stopped;
  return {
    ...base,
    ok,
    commandLine: options.commandLine ?? '',
    cwd: options.cwd
  };
}

function assertOutputLimit(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

async function terminateProcessTree(
  rootPid: number,
  fallbackKill: () => boolean,
  graceMs: number
): Promise<void> {
  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(rootPid, fallbackKill, graceMs);
    return;
  }
  signalPosixProcessGroup(rootPid, 'SIGTERM', fallbackKill);
  if (await waitForPosixProcessGroupExit(rootPid, graceMs)) {
    return;
  }
  signalPosixProcessGroup(rootPid, 'SIGKILL', fallbackKill);
  await waitForPosixProcessGroupExit(rootPid, Math.max(1000, Math.min(Math.max(graceMs, 0), 5000)));
}

async function terminateWindowsProcessTree(
  rootPid: number,
  fallbackKill: () => boolean,
  graceMs: number
): Promise<void> {
  // Start `/t` before touching the root so taskkill snapshots descendants while
  // their parent relationship still exists. Without this, a quickly exiting
  // parent can orphan a grandchild before the force phase discovers it.
  const graceful = await settleWithin(runTaskkill(rootPid, false), graceMs);
  if (graceful === true) {
    return;
  }
  const forced = await settleWithin(
    runTaskkill(rootPid, true),
    Math.max(1000, Math.min(Math.max(graceMs, 0), 5000))
  );
  if (forced !== true) {
    try {
      fallbackKill();
    } catch {
      // The root may already be gone; both taskkill attempts above still ran.
    }
  }
}

function runTaskkill(rootPid: number, force: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (ok: boolean): void => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(ok);
    };
    const args = ['/pid', String(rootPid), '/t', ...(force ? ['/f'] : [])];
    const killer = spawn('taskkill', args, {
      windowsHide: true,
      stdio: 'ignore'
    });
    killer.once('error', () => finish(false));
    killer.once('close', (code) => finish(code === 0));
  });
}

function signalPosixProcessGroup(
  rootPid: number,
  signal: NodeJS.Signals,
  fallbackKill: () => boolean
): void {
  try {
    process.kill(-rootPid, signal);
  } catch {
    try {
      fallbackKill();
    } catch {
      // The group may already have exited between the liveness check and kill.
    }
  }
}

async function waitForPosixProcessGroupExit(rootPid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (posixProcessGroupAlive(rootPid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await delay(Math.min(25, remaining));
  }
  return true;
}

function posixProcessGroupAlive(rootPid: number): boolean {
  try {
    process.kill(-rootPid, 0);
    return true;
  } catch (error) {
    return !isErrnoCode(error, 'ESRCH');
  }
}

async function settleWithin(promise: Promise<boolean>, timeoutMs: number): Promise<boolean | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs));
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}
