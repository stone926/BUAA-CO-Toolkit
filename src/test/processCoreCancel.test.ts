import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runProcessCore } from '../processCore';

const nodeExecutable = process.execPath;
const foreverScript = 'setInterval(() => {}, 1000)';

describe('cancellable process supervisor', () => {
  it('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let processError: Error | undefined;
    const result = await runProcessCore('definitely-not-a-real-executable', [], {
      cwd: os.tmpdir(),
      signal: controller.signal,
      successPredicate: () => true,
      onError: (error) => { processError = error; }
    });
    expect(result).toMatchObject({ ok: false, stopped: true, stopReason: 'aborted' });
    expect(processError).toBeUndefined();
  });

  it('aborts a running child and settles exactly once', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const promise = runProcessCore(nodeExecutable, ['-e', foreverScript], {
      cwd: os.tmpdir(),
      signal: controller.signal,
      cancelGraceMs: 500
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    controller.abort(); // repeated aborts must be harmless
    const result = await promise;
    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe('aborted');
    expect(result.timedOut).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('terminates a stubborn grandchild after its parent exits first', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-tree-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    // Parent exits on the graceful phase; the grandchild ignores POSIX SIGTERM.
    const parentScript = path.join(__dirname, 'fixtures', 'processTree', 'grandchildParent.js');
    const controller = new AbortController();
    let grandchildPid: number | undefined;
    const promise = runProcessCore(nodeExecutable, [parentScript, pidFile], {
      cwd: os.tmpdir(),
      signal: controller.signal,
      cancelGraceMs: 250
    });
    try {
      // Wait for the grandchild pid to appear.
      for (let attempt = 0; attempt < 100 && grandchildPid === undefined; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
        } catch {
          // not written yet
        }
      }
      expect(grandchildPid).toBeDefined();

      controller.abort();
      const result = await promise;
      expect(result.stopped).toBe(true);
      expect(result.ok).toBe(false);

      // The promise must not settle merely because the parent closed.
      expect(await waitForProcessExit(grandchildPid!, 2000)).toBe(true);
    } finally {
      controller.abort();
      await promise.catch(() => undefined);
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the timeout path with force termination and idempotent stop', async () => {
    let stopCalls = 0;
    const promise = runProcessCore(nodeExecutable, ['-e', foreverScript], {
      cwd: os.tmpdir(),
      timeoutMs: 300,
      cancelGraceMs: 300,
      onTimeout: () => {
        stopCalls++;
      }
    });
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.stopped).toBe(true);
    expect(stopCalls).toBe(1);
  });

  it('writes stdin to a quick child without EPIPE failures', async () => {
    const result = await runProcessCore(nodeExecutable, ['-e', 'process.stdin.resume()'], {
      cwd: os.tmpdir(),
      stdin: 'x'.repeat(64 * 1024)
    });
    expect(result.exitCode).toBe(0);
  });

  it('does not report an intentionally stopped process as successful by default', async () => {
    const result = await runProcessCore(nodeExecutable, ['-e', `
      if (process.platform !== 'win32') process.on('SIGTERM', () => process.exit(0));
      console.log('ready');
      setInterval(() => {}, 1000);
    `], {
      cwd: os.tmpdir(),
      cancelGraceMs: 250,
      onStdoutLine: (line, control) => {
        if (line === 'ready') {
          control.stop('test-stop');
        }
      }
    });
    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe('test-stop');
    expect(result.ok).toBe(false);
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}
