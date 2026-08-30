// @index verilog-simulation-runner — resource-scoped Icarus/ISim 两分派仿真入口
import * as vscode from 'vscode';
import { getIsePath } from '../config';
import type { AppServices, RunResult } from '../types';
import type { MutableVerilogModuleProvider } from '../language/verilog/moduleProvider';
import { runIsim, IsimRunOptions, IsimRunOutput } from './isimRunner';
import { runIverilog, IverilogRunOutput } from './iverilogRunner';
import { selectVerilogBackend } from './verilogBackend';

export interface VerilogSimulationRunOptions extends IsimRunOptions {
  /** Extension installation root used only by the bundled Icarus branch. */
  extensionRoot?: string;
  /** Optional direct Icarus watchdog budget; TCL `run` remains the default source. */
  watchdogLimitPs?: number;
}

export type IsimSimulationRunOutput = IsimRunOutput & { backend: 'isim' };
export type VerilogSimulationRunOutput = IsimSimulationRunOutput | IverilogRunOutput;

let sharedModuleRegistry: MutableVerilogModuleProvider | undefined;

/** Keep command and headless-safe course-test simulations on the incremental module registry. */
export function setVerilogSimulationModuleRegistry(
  moduleRegistry: MutableVerilogModuleProvider | undefined
): void {
  sharedModuleRegistry = moduleRegistry;
}

/**
 * Return the process result that decided this simulation's terminal state.
 * Icarus compile failures have no simResult, while all launched simulations
 * use simResult (including VVP cancellation/timeout/failure).
 */
export function verilogSimulationTerminalResult(
  output: VerilogSimulationRunOutput | undefined
): RunResult | undefined {
  return output?.simResult
    ?? (output?.backend === 'iverilog' ? output.compileResult : undefined);
}

/**
 * Select exactly once from the resource-scoped ISE path and never fall back
 * during an operation. An invalid non-empty ISE path therefore stays an ISim
 * configuration failure instead of silently starting bundled Icarus.
 */
export async function runVerilogSimulation(
  services: AppServices,
  options: VerilogSimulationRunOptions = {}
): Promise<VerilogSimulationRunOutput | undefined> {
  const effectiveOptions = options.moduleRegistry || !sharedModuleRegistry
    ? options
    : { ...options, moduleRegistry: sharedModuleRegistry };
  const resource = effectiveOptions.resource ?? vscode.window.activeTextEditor?.document.uri;
  const isePath = getIsePath(resource);
  if (selectVerilogBackend(isePath) === 'isim') {
    services.output.appendLine('Verilog backend: ISim (configured ISE)');
    const output = await runIsim(services, { ...effectiveOptions, isePath });
    return output ? { ...output, backend: 'isim' } : undefined;
  }
  return await runIverilog(services, effectiveOptions);
}
