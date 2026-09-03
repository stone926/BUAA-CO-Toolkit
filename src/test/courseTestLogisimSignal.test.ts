import { describe, expect, it, vi } from 'vitest';
import { createTestServices } from './helpers/appServices';

const processState = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('vscode', () => ({
  window: { showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
  workspace: {}
}));

vi.mock('../config', () => ({
  getJava: vi.fn(() => 'java'),
  getLogisimJar: vi.fn(() => 'E:/tools/logisim.jar'),
  getLogisimTraceColumns: vi.fn(),
  getLogisimTraceMainCircuit: vi.fn(),
  getMarsJar: vi.fn(() => 'E:/tools/Mars.jar'),
  getMemoryConfiguration: vi.fn(() => 'FixedCompactLargeText'),
  getMipsEngine: vi.fn(() => 'mars'),
  getProfile: vi.fn(),
  getRunTimeout: vi.fn(() => 10_000),
  showCommandBeforeRun: vi.fn(() => false)
}));

vi.mock('../processCore', () => ({ runProcessCore: processState.run }));
vi.mock('../toolchain', () => ({ checkToolchain: vi.fn(async () => []) }));

import { resolveP3LogisimTraceSetup, runLogisimTraceCli } from '../courseTestLogisim';
import { showCommandBeforeRun } from '../config';
import { checkToolchain } from '../toolchain';

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
    const services = createTestServices();

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

  it('keeps an automatic Logisim run non-interactive and hides command paths', async () => {
    vi.mocked(showCommandBeforeRun).mockClear();
    vi.mocked(showCommandBeforeRun).mockReturnValue(true);
    processState.run.mockResolvedValue({
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'failed',
      timedOut: false,
      commandLine: 'java -jar logisim.jar',
      cwd: 'E:/work'
    });
    const services = createTestServices();

    await runLogisimTraceCli(
      services,
      { traceSpec: {} } as never,
      { fsPath: 'E:/work/cpu.circ' } as never,
      '00003000',
      { fsPath: 'E:/work/program.asm' } as never,
      false,
      undefined,
      true
    );

    expect(showCommandBeforeRun).not.toHaveBeenCalled();
    expect(services.output.append).not.toHaveBeenCalled();
    expect(services.output.appendLine).not.toHaveBeenCalledWith(expect.stringContaining('E:/work'));
    expect(services.output.appendLine).not.toHaveBeenCalledWith(expect.stringContaining('$ java'));
    expect(processState.run.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({
      onError: undefined,
      onTimeout: undefined,
      timeoutMs: 300_000
    }));
  });

  it('pins the automatic P3 preflight to builtin even when the workspace selects mars', async () => {
    const services = createTestServices();
    const resource = { fsPath: 'E:/private/program.asm' } as never;

    await resolveP3LogisimTraceSetup(services, resource, { nonInteractive: true });

    expect(checkToolchain).toHaveBeenCalledWith(
      services.output,
      resource,
      { nonInteractive: true, engineMode: 'builtin' }
    );
    expect(services.output.show).not.toHaveBeenCalled();
  });
});
