import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runProcessCore } from '../processCore';

const nodeExecutable = process.execPath;
const foreverScript = 'setInterval(() => {}, 1000)';

describe('cancellable process supervisor', () => {
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

  it('terminates a grandchild process tree on Windows cancellation', async () => {
    if (process.platform !== 'win32') {
      return; // POSIX tree signalling is covered by the process-group path.
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-tree-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    // Parent fixture spawns a grandchild that records its pid and loops forever.
    const parentScript = path.join(__dirname, 'fixtures', 'processTree', 'grandchildParent.js');
    const controller = new AbortController();
    const promise = runProcessCore(nodeExecutable, [parentScript, pidFile], {
      cwd: os.tmpdir(),
      signal: controller.signal,
      cancelGraceMs: 1000
    });
    // Wait for the grandchild pid to appear.
    let grandchildPid: number | undefined;
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

    // The whole tree must be gone after the grace period; process.kill with
    // signal 0 only checks existence.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt++) {
      try {
        process.kill(grandchildPid!, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
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
});
