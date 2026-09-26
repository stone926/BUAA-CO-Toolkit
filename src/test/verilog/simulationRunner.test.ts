import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { AppServices } from '../../types';
import { runIverilog } from '../../verilog/iverilogRunner';
import {
  runVerilogSimulation,
  setVerilogSimulationModuleRegistry,
  verilogSimulationFailure,
  verilogSimulationTerminalResult
} from '../../verilog/simulationRunner';

vi.mock('../../verilog/iverilogRunner', () => ({ runIverilog: vi.fn() }));

const resource = URI.file('E:/work/src/mips.v');
const services = { output: { appendLine: vi.fn() }, extensionRoot: 'E:/extension' } as unknown as AppServices;

describe('Verilog simulation runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setVerilogSimulationModuleRegistry(undefined);
  });

  it('runs Icarus with the given duration and shared module registry', async () => {
    vi.mocked(runIverilog).mockResolvedValue({ backend: 'iverilog' } as never);
    const registry = { kind: 'shared' } as never;
    setVerilogSimulationModuleRegistry(registry);
    const options = { resource, simTime: '4195us' };

    await expect(runVerilogSimulation(services, options)).resolves.toMatchObject({ backend: 'iverilog' });
    expect(runIverilog).toHaveBeenCalledWith(services, { ...options, moduleRegistry: registry });
  });

  it('lets an operation use its own module registry', async () => {
    const shared = { kind: 'shared' } as never;
    const operation = { kind: 'operation' } as never;
    setVerilogSimulationModuleRegistry(shared);
    await runVerilogSimulation(services, { resource, moduleRegistry: operation });
    expect(runIverilog).toHaveBeenCalledWith(services, { resource, moduleRegistry: operation });
  });

  it('uses the simulation result when launched and compile result otherwise', () => {
    const compileResult = { ok: false, stopReason: 'aborted' };
    const simResult = { ok: false, stopReason: 'timeout' };
    expect(verilogSimulationTerminalResult({ compileResult } as never)).toBe(compileResult);
    expect(verilogSimulationTerminalResult({ compileResult, simResult } as never)).toBe(simResult);
  });

  it('classifies compile, simulation, missing-output, and setup failures', () => {
    const compile = verilogSimulationFailure({
      backend: 'iverilog',
      compileResult: {
        ok: false, exitCode: 26, stderr: 'E:/work/CPU.v:449: error: unable to bind',
        stdout: '', timedOut: false, stopped: false, commandLine: 'secret', cwd: 'E:/work/.co/iverilog'
      }
    } as never, 'E:/work');
    const simulation = verilogSimulationFailure({
      backend: 'iverilog', compileResult: { ok: true },
      simResult: {
        ok: false, exitCode: null, stderr: '', stdout: '', timedOut: true,
        stopped: true, stopReason: 'timeout', commandLine: 'secret', cwd: 'E:/work/.co/iverilog'
      }
    } as never, 'E:/work');

    expect(compile).toMatchObject({ phase: 'compile', reason: 'exit', diagnostic: { file: 'CPU.v', line: 449 } });
    expect(simulation).toEqual({ phase: 'simulate', reason: 'timeout' });
    expect(verilogSimulationFailure({ backend: 'iverilog', compileResult: { ok: true } } as never))
      .toEqual({ phase: 'output', reason: 'missing-output' });
    expect(verilogSimulationFailure(undefined)).toEqual({ phase: 'prepare', reason: 'unavailable' });
  });
});
