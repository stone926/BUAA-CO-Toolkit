// @index verilog-simulation-runner — shared Icarus simulation entry and failure reporting
import type { AppServices, RunResult } from '../types';
import type { MutableVerilogModuleProvider } from '../language/verilog/moduleProvider';
import { runIverilog, type IverilogRunOptions, type IverilogRunOutput } from './iverilogRunner';
import {
  createVerilogSimulationFailure,
  missingVerilogSimulationOutputFailure,
  type VerilogSimulationFailure
} from './simulationDiagnostic';

export type VerilogSimulationRunOptions = IverilogRunOptions;
export type VerilogSimulationRunOutput = IverilogRunOutput;

let sharedModuleRegistry: MutableVerilogModuleProvider | undefined;

/** Keep command and headless course simulations on the incremental module registry. */
export function setVerilogSimulationModuleRegistry(
  moduleRegistry: MutableVerilogModuleProvider | undefined
): void {
  sharedModuleRegistry = moduleRegistry;
}

export function verilogSimulationTerminalResult(
  output: VerilogSimulationRunOutput | undefined
): RunResult | undefined {
  return output?.simResult ?? output?.compileResult;
}

export function verilogSimulationFailure(
  output: VerilogSimulationRunOutput | undefined,
  workspaceRoot?: string
): VerilogSimulationFailure {
  if (!output) {
    return createVerilogSimulationFailure('iverilog', 'prepare', undefined, workspaceRoot);
  }
  if (!output.compileResult.ok) {
    return createVerilogSimulationFailure('iverilog', 'compile', output.compileResult, workspaceRoot);
  }
  if (output.simResult && !output.simResult.ok) {
    return createVerilogSimulationFailure('iverilog', 'simulate', output.simResult, workspaceRoot);
  }
  return missingVerilogSimulationOutputFailure();
}

export async function runVerilogSimulation(
  services: AppServices,
  options: VerilogSimulationRunOptions = {}
): Promise<VerilogSimulationRunOutput | undefined> {
  const effectiveOptions = options.moduleRegistry || !sharedModuleRegistry
    ? options
    : { ...options, moduleRegistry: sharedModuleRegistry };
  return await runIverilog(services, effectiveOptions);
}
