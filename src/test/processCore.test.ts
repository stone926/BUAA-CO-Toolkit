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

  it('decodes UTF-8 deterministically when a code point crosses chunk boundaries', async () => {
    const result = await runProcessCore(process.execPath, [
      '-e',
      "const b=Buffer.from('中文'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),10);"
    ], {
      cwd: process.cwd(),
      timeoutMs: 5000
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('中文');
  });

  it('terminates the process tree at the trusted raw stdout byte ceiling', async () => {
    const result = await runProcessCore(process.execPath, [
      '-e',
      "process.stdout.write('x'.repeat(65536)); setInterval(()=>process.stdout.write('x'.repeat(65536)),10);"
    ], {
      cwd: process.cwd(),
      timeoutMs: 5000,
      cancelGraceMs: 20,
      maxStdoutBytes: 1024
    });

    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('stdout-limit');
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1024);
  });
});
