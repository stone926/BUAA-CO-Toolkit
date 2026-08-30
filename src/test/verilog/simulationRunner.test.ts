import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { AppServices } from '../../types';
import { getIsePath } from '../../config';
import { runIsim } from '../../verilog/isimRunner';
import { runIverilog } from '../../verilog/iverilogRunner';
import {
  runVerilogSimulation,
  verilogSimulationTerminalResult
} from '../../verilog/simulationRunner';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

vi.mock('../../config', () => ({ getIsePath: vi.fn() }));
vi.mock('../../verilog/isimRunner', () => ({ runIsim: vi.fn() }));
vi.mock('../../verilog/iverilogRunner', () => ({ runIverilog: vi.fn() }));

const resource = URI.file('E:/work/src/mips.v');
const services = {
  output: { appendLine: vi.fn() },
  statusBar: {},
  extensionRoot: 'E:/extension'
} as unknown as AppServices;

describe('Verilog simulation dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.state!.activeTextEditor = undefined;
  });

  it('uses Icarus for a blank ISE path and passes the operation options unchanged', async () => {
    vi.mocked(getIsePath).mockReturnValue('   ');
    vi.mocked(runIverilog).mockResolvedValue({ backend: 'iverilog' } as never);
    const options = { resource, tclText: 'run 4195us;\nexit\n' };

    await expect(runVerilogSimulation(services, options)).resolves.toMatchObject({ backend: 'iverilog' });

    expect(runIverilog).toHaveBeenCalledWith(services, options);
    expect(runIsim).not.toHaveBeenCalled();
  });

  it('uses ISim for every non-empty ISE path and adds the backend label', async () => {
    vi.mocked(getIsePath).mockReturnValue('D:/invalid-but-explicit-ISE');
    vi.mocked(runIsim).mockResolvedValue({ simResult: { ok: true } } as never);

    await expect(runVerilogSimulation(services, { resource })).resolves.toMatchObject({
      backend: 'isim',
      simResult: { ok: true }
    });

    expect(runIsim).toHaveBeenCalledOnce();
    expect(runIsim).toHaveBeenCalledWith(services, expect.objectContaining({
      resource,
      isePath: 'D:/invalid-but-explicit-ISE'
    }));
    expect(runIverilog).not.toHaveBeenCalled();
  });

  it('does not fall back when the explicitly selected ISim branch fails', async () => {
    vi.mocked(getIsePath).mockReturnValue('D:/invalid-ISE');
    vi.mocked(runIsim).mockResolvedValue(undefined);

    await expect(runVerilogSimulation(services, { resource })).resolves.toBeUndefined();

    expect(runIverilog).not.toHaveBeenCalled();
  });

  it('uses an Icarus compile failure as the terminal process result', () => {
    const compileResult = { ok: false, stopReason: 'aborted' };
    expect(verilogSimulationTerminalResult({
      backend: 'iverilog',
      compileResult
    } as never)).toBe(compileResult);

    const simResult = { ok: false, stopReason: 'timeout' };
    expect(verilogSimulationTerminalResult({
      backend: 'iverilog',
      compileResult: { ok: true },
      simResult
    } as never)).toBe(simResult);
  });
});
