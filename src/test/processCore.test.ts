import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { showInformationMessage: vi.fn() },
  workspace: { getConfiguration: vi.fn() }
}));

vi.mock('../config', () => ({
  getRunTimeout: vi.fn(() => 5000),
  shouldRevealOutput: vi.fn(() => false),
  showCommandBeforeRun: vi.fn(() => true)
}));

import { runProcessCore } from '../processCore';
import { runTool } from '../process';
import * as vscode from 'vscode';
import { showCommandBeforeRun } from '../config';

describe('process core', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(showCommandBeforeRun).mockReturnValue(true);
  });

  it('keeps non-interactive tool commands and raw streams out of the output channel', async () => {
    const output = { append: vi.fn(), appendLine: vi.fn() };
    const result = await runTool(process.execPath, [
      '-e',
      "process.stdout.write('out'); process.stderr.write('err');"
    ], {
      cwd: process.cwd(),
      output: output as never,
      timeoutMs: 5000,
      nonInteractive: true
    });

    expect(result).toMatchObject({ ok: true, stdout: 'out', stderr: 'err' });
    expect(output.append).not.toHaveBeenCalled();
    expect(output.appendLine).not.toHaveBeenCalled();
    expect(showCommandBeforeRun).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('preserves command confirmation and process chatter for an interactive manual run', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('运行' as never);
    const output = { append: vi.fn(), appendLine: vi.fn() };
    const result = await runTool(process.execPath, [
      '-e',
      "process.stdout.write('manual-out'); process.stderr.write('manual-err');"
    ], {
      cwd: process.cwd(),
      output: output as never,
      timeoutMs: 5000
    });

    expect(result.ok).toBe(true);
    expect(showCommandBeforeRun).toHaveBeenCalledOnce();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce();
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringMatching(/^\$ /));
    expect(output.appendLine).toHaveBeenCalledWith(`cwd: ${process.cwd()}`);
    expect(output.append).toHaveBeenCalledWith('manual-out');
    expect(output.append).toHaveBeenCalledWith('manual-err');
  });

  it('keeps non-interactive spawn errors out of the output channel', async () => {
    const output = { append: vi.fn(), appendLine: vi.fn() };
    const result = await runTool('__co_missing_external_tool__', [], {
      cwd: process.cwd(),
      output: output as never,
      timeoutMs: 5000,
      nonInteractive: true
    });

    expect(result.ok).toBe(false);
    expect(output.append).not.toHaveBeenCalled();
    expect(output.appendLine).not.toHaveBeenCalled();
  });

  it('keeps non-interactive timeout details out of the output channel', async () => {
    const output = { append: vi.fn(), appendLine: vi.fn() };
    const result = await runTool(process.execPath, [
      '-e',
      'setTimeout(() => undefined, 5000);'
    ], {
      cwd: process.cwd(),
      output: output as never,
      timeoutMs: 20,
      nonInteractive: true
    });

    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(output.append).not.toHaveBeenCalled();
    expect(output.appendLine).not.toHaveBeenCalled();
  });

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
