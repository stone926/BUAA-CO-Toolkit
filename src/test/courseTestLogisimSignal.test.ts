import { describe, expect, it, vi } from 'vitest';

const processState = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('vscode', () => ({
  window: { showInformationMessage: vi.fn() },
  workspace: {}
}));

vi.mock('../config', () => ({
  getJava: vi.fn(() => 'java'),
  getLogisimJar: vi.fn(() => 'E:/tools/logisim.jar'),
  getLogisimTraceColumns: vi.fn(),
  getLogisimTraceMainCircuit: vi.fn(),
  getMemoryConfiguration: vi.fn(),
  getProfile: vi.fn(),
  getRunTimeout: vi.fn(() => 10_000),
  showCommandBeforeRun: vi.fn(() => false)
}));

vi.mock('../processCore', () => ({ runProcessCore: processState.run }));

import { runLogisimTraceCli } from '../courseTestLogisim';

describe('Logisim CLI cancellation boundary', () => {
  it('forwards the session AbortSignal to the shared process supervisor', async () => {
    processState.run.mockResolvedValue({
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      stopped: true,
      stopReason: 'aborted',
      commandLine: 'java -jar logisim.jar',
      cwd: 'E:/work'
    });
    const controller = new AbortController();
    const services = {
      output: { append: vi.fn(), appendLine: vi.fn() }
    } as never;

    await runLogisimTraceCli(
      services,
      { traceSpec: {} } as never,
      { fsPath: 'E:/work/cpu.circ' } as never,
      '00003000',
      { fsPath: 'E:/work/program.asm' } as never,
      false,
      controller.signal
    );

    expect(processState.run).toHaveBeenCalledOnce();
    expect(processState.run.mock.calls[0][2]).toEqual(expect.objectContaining({
      signal: controller.signal
    }));
  });
});
