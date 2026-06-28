import { describe, expect, it } from 'vitest';
import { runProcessCore } from '../processCore';

describe('process core', () => {
  it('captures stdout and stderr for successful commands', async () => {
    const result = await runProcessCore(process.execPath, [
      '-e',
      "process.stdout.write('out'); process.stderr.write('err');"
    ], {
      cwd: process.cwd(),
      timeoutMs: 5000
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.timedOut).toBe(false);
  });

  it('allows stdout line handlers to stop a process successfully', async () => {
    let seen = 0;
    const result = await runProcessCore(process.execPath, [
      '-e',
      "console.log('ready'); setInterval(() => console.log('tick'), 100);"
    ], {
      cwd: process.cwd(),
      timeoutMs: 5000,
      onStdoutLine: (line, control) => {
        seen++;
        if (line === 'ready') {
          control.stop('ready');
        }
      },
      successPredicate: (run) => run.stopped && run.stopReason === 'ready'
    });

    expect(result.ok).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe('ready');
    expect(seen).toBeGreaterThanOrEqual(1);
  });

  it('marks commands that exceed the timeout', async () => {
    const result = await runProcessCore(process.execPath, [
      '-e',
      'setTimeout(() => undefined, 5000);'
    ], {
      cwd: process.cwd(),
      timeoutMs: 50
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});
