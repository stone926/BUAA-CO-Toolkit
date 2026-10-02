// @index waveform-simulation — “仿真并查看波形”命令：bundled Icarus 附加 dump 顶层模块运行，GRF 等小存储器逐字记录，编译器拒绝时去掉出错的存储器重试，最后打开 VCD

import * as path from 'path';
import * as vscode from 'vscode';
import { CO_WAVE_DIR } from '../../constants';
import { workspaceFolderFor } from '../../fsUtil';
import type { MutableVerilogModuleProvider } from '../../language/verilog/moduleProvider';
import { pathExists } from '../../nodeFs';
import { samePath } from '../../pathUtils';
import type { AppServices } from '../../types';
import { IverilogRunOutput, runIverilog } from '../../verilog/iverilogRunner';
import type { UserCpuProgramSession } from '../../verilog/userCpuProgram';
import type { MemoryDump } from '../design/designHierarchy';
import type { DumperRejection } from '../design/waveformDumper';
import { WaveformDumpSetup, describeDumpMemories as describeMemories, locateDumpFile } from './waveformDumpSetup';
export { locateDumpFile } from './waveformDumpSetup';

export interface WaveformSimulationDependencies {
  readonly services: AppServices;
  readonly moduleRegistry?: MutableVerilogModuleProvider;
  /** Show (and reload, if already open) the produced dump. */
  readonly showWaveform: (dump: vscode.Uri) => Promise<void>;
}

export async function simulateAndShowWaveform(dependencies: WaveformSimulationDependencies): Promise<void> {
  const resource = vscode.window.activeTextEditor?.document.uri;
  const folder = workspaceFolderFor(resource);
  if (!folder) {
    vscode.window.showErrorMessage('查看波形前请先打开一个工作区文件夹');
    return;
  }
  const waveDirectory = vscode.Uri.joinPath(folder.uri, ...CO_WAVE_DIR.split('/'));
  const userCpuProgramSession: UserCpuProgramSession = {};
  let attempt = await runWithDumper(dependencies, resource, waveDirectory, undefined, userCpuProgramSession);
  const dropped: MemoryDump[] = [];
  // Drop the memories the compiler blamed and retry; once nothing is dumped no rejection can occur.
  while (attempt.rejection) {
    const rejected = attempt.rejection.unattributed
      ? attempt.memories
      : attempt.memories.filter((memory) => attempt.rejection?.memories.includes(memory));
    dropped.push(...rejected);
    dependencies.services.output.appendLine(`存储器逐字 dump 被编译器拒绝（层次路径或大小与静态推算不一致），去掉 ${describeMemories(rejected)} 后重试`);
    attempt = await runWithDumper(dependencies, resource, waveDirectory, attempt.memories.filter((memory) => !rejected.includes(memory)), userCpuProgramSession);
  }
  if (dropped.length && attempt.run?.simResult) {
    vscode.window.showWarningMessage(attempt.memories.length
      ? `未能确定 ${describeMemories(dropped)} 的层次路径或大小，这些存储器没有逐字记录`
      : '未能确定寄存器堆等存储器的层次路径或大小，本次波形只包含普通信号');
  }
  const run = attempt.run;
  if (!run?.compileResult.ok || !run.simResult) {
    return;
  }
  const dump = locateDumpFile(run.simResult.stdout, run.generated.outDir.fsPath);
  if (!dump || !await pathExists(dump.fsPath)) {
    if (run.simResult.ok) {
      vscode.window.showErrorMessage('仿真结束但没有生成 VCD 波形，请查看输出面板');
    }
    return;
  }
  const expected = path.join(waveDirectory.fsPath, `${run.testbench.moduleName}.vcd`);
  if (!samePath(dump.fsPath, expected)) {
    vscode.window.showInformationMessage(`testbench 自带 $dumpfile，波形写入了 ${path.basename(dump.fsPath)}`);
  }
  await dependencies.showWaveform(dump);
}

interface DumperAttempt {
  readonly run: IverilogRunOutput | undefined;
  /** Memories this attempt dumped word by word. */
  readonly memories: readonly MemoryDump[];
  /** Set when the compiler rejected part of the memory dump; the run then stopped before simulating. */
  readonly rejection: DumperRejection | undefined;
}

/** One compile + simulate run; `requestedMemories` undefined discovers them from the design. */
async function runWithDumper(
  dependencies: WaveformSimulationDependencies,
  resource: vscode.Uri | undefined,
  waveDirectory: vscode.Uri,
  requestedMemories: readonly MemoryDump[] | undefined,
  userCpuProgramSession: UserCpuProgramSession
): Promise<DumperAttempt> {
  const setup = new WaveformDumpSetup(
    (testbenchName) => vscode.Uri.file(path.join(waveDirectory.fsPath, `${testbenchName}.vcd`)),
    requestedMemories,
    dependencies.moduleRegistry
  );
  const run = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: '正在仿真并生成波形…',
    cancellable: true
  }, async (_progress, token) => {
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      return await runIverilog(dependencies.services, {
        resource,
        userCpuProgramSession,
        moduleRegistry: dependencies.moduleRegistry,
        signal: controller.signal,
        revealOutput: false,
        announceSuccess: false,
        simOutputDirectory: waveDirectory,
        ...setup.hooks()
      });
    } finally {
      cancellation.dispose();
    }
  });
  return { run, memories: setup.memories, rejection: setup.rejection };
}
