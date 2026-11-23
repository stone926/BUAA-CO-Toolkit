// @index verilog-dm-store-diagnostic — 将私有课程 TB 明确报告的 DM 接口违例绑定到实际编译源
import * as path from 'path';
import { samePath } from '../pathUtils';
import { automaticRuntimeTestbenchName, generatedTestbenchMarker, p7AutoRuntimeTestbenchName } from '../verilogSimulationFiles';
import { parseIverilogDiagnosticRecord } from './iverilogDiagnostics';
import type { IverilogRunOutput } from './iverilogRunner';
import { normalizeVerilogSimulationFailure, type VerilogSimulationFailure } from './simulationDiagnostic';

const contractFatal = /^\s*\$fatal\(1, "CO_DM_CONTRACT (invalid_address|invalid_pc|non_store_instruction|byte_enable|unknown_enabled_lane) /;

/** VVP reports the compiled source location and the executing module scope for each $fatal. */
export function privateDmStoreContractFailure(
  output: Pick<IverilogRunOutput, 'compileResult' | 'simResult' | 'testbench'> | undefined,
  workspaceRoot?: string
): VerilogSimulationFailure | undefined {
  const sim = output?.simResult;
  const tb = output?.testbench;
  if (!output?.compileResult.ok || !sim || sim.ok || sim.exitCode !== 1 || sim.timedOut || sim.stopped || sim.stopReason
    || !tb?.generatedText?.startsWith(generatedTestbenchMarker + '\n') || tb.generatedUri?.scheme !== 'file') return;
  const privateTb = (tb.kind === 'generated' && tb.moduleName === automaticRuntimeTestbenchName)
    || (tb.kind === 'p7-auto' && tb.moduleName === p7AutoRuntimeTestbenchName);
  if (!privateTb) return;

  const sourceLines = tb.generatedText.split('\n');
  for (const stream of [sim.stdout, sim.stderr]) {
    for (const match of stream.matchAll(/^(FATAL:[^\r\n]*)\r?\n[ \t]*Time:[ \t]*\d+[ \t]+Scope:[ \t]*(\S+)[ \t]*\r?$/gm)) {
      if (match[2] !== tb.moduleName) continue;
      const record = parseIverilogDiagnosticRecord(match[1]);
      if (!record) continue;
      // VVP retains compile-time paths. With shared compilation its own working directory
      // can point at a different slot. Never use a basename or the sanitized report path here.
      const file = path.isAbsolute(record.file) || path.win32.isAbsolute(record.file)
        ? record.file : path.join(output.compileResult.cwd, record.file);
      if (!samePath(file, tb.generatedUri.fsPath)) continue;
      const sourceLine = sourceLines[record.line - 1] ?? '';
      const tag = contractFatal.exec(sourceLine)?.[1];
      if (!tag || !record.message.startsWith(`CO_DM_CONTRACT ${tag} `)) continue;
      return normalizeVerilogSimulationFailure({
        phase: 'simulate', reason: 'dm-store-contract', exitCode: 1,
        diagnostic: { file, line: record.line, message: record.message }
      }, workspaceRoot);
    }
  }
}
