// @index waveform-simulation — “仿真并查看波形”命令：bundled Icarus 附加 dump 顶层模块运行，GRF 等小存储器逐字记录，失败时去掉存储器重试，最后打开 VCD

import * as path from 'path';
import * as vscode from 'vscode';
import { CO_WAVE_DIR } from '../../constants';
import { ensureDirectory, workspaceFolderFor } from '../../fsUtil';
import type { MutableVerilogModuleProvider } from '../../language/verilog/moduleProvider';
import { pathExists } from '../../nodeFs';
import type { AppServices, RunResult } from '../../types';
import { IverilogRunOutput, runIverilog } from '../../verilog/iverilogRunner';
import type { TestbenchResolution } from '../../verilog/testbenchResolver';
import { findDumpableMemories, MemoryDump } from '../design/designHierarchy';
import {
  buildWaveformDumper,
  dumpFileArgument,
  waveformDumperFileName,
  waveformDumperModuleName
} from '../design/waveformDumper';
import { createDesignModuleLookup } from './designModules';

const dumpfileOpenedPattern = /^VCD info: dumpfile (.+) opened for output\.?\s*$/m;

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
  let output = await runWithDumper(dependencies, resource, waveDirectory, true);
  if (output.run && !output.run.compileResult.ok && output.memories.length && mentionsDumper(output.run.compileResult)) {
    dependencies.services.output.appendLine('存储器逐字 dump 无法编译（层次路径可能位于 generate 块内），改为只记录普通信号后重试');
    output = await runWithDumper(dependencies, resource, waveDirectory, false);
    if (output.run?.compileResult.ok) {
      vscode.window.showWarningMessage('寄存器堆等存储器的层次路径无法解析，本次波形只包含普通信号');
    }
  }
  const run = output.run;
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
  if (path.resolve(dump.fsPath) !== path.resolve(expected)) {
    vscode.window.showInformationMessage(`testbench 自带 $dumpfile，波形写入了 ${path.basename(dump.fsPath)}`);
  }
  await dependencies.showWaveform(dump);
}

async function runWithDumper(
  dependencies: WaveformSimulationDependencies,
  resource: vscode.Uri | undefined,
  waveDirectory: vscode.Uri,
  includeMemories: boolean
): Promise<{ run: IverilogRunOutput | undefined; memories: readonly MemoryDump[] }> {
  let memories: readonly MemoryDump[] = [];
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
        moduleRegistry: dependencies.moduleRegistry,
        signal: controller.signal,
        revealOutput: false,
        announceSuccess: false,
        simOutputDirectory: waveDirectory,
        shouldReportCompileFailure: (result) => !(includeMemories && memories.length && mentionsDumper(result)),
        generatedTopModules: async ({ folder, outDir, testbench }) => {
          await ensureDirectory(waveDirectory);
          memories = includeMemories ? await discoverMemories(testbench, dependencies.moduleRegistry) : [];
          const dumpPath = path.join(waveDirectory.fsPath, `${testbench.moduleName}.vcd`);
          const moduleName = waveformDumperModuleName(folder.uri.fsPath);
          return [{
            moduleName,
            fileName: waveformDumperFileName,
            text: buildWaveformDumper({
              moduleName,
              testbench: testbench.moduleName,
              dumpFile: dumpFileArgument(outDir.fsPath, dumpPath),
              memories
            })
          }];
        }
      });
    } finally {
      cancellation.dispose();
    }
  });
  return { run, memories };
}

async function discoverMemories(
  testbench: TestbenchResolution,
  registry: MutableVerilogModuleProvider | undefined
): Promise<MemoryDump[]> {
  const sources = [testbench.generatedUri, testbench.sourceUri]
    .filter((uri): uri is vscode.Uri => uri?.scheme === 'file')
    .map((uri) => uri.fsPath);
  const lookup = await createDesignModuleLookup(registry, sources);
  const root = lookup(testbench.moduleName);
  return root ? findDumpableMemories(root, lookup) : [];
}

function mentionsDumper(result: RunResult): boolean {
  return `${result.stderr}\n${result.stdout}`.includes(waveformDumperFileName);
}

/** The dump the simulator actually opened (a testbench's own `$dumpfile` may win the race). */
export function locateDumpFile(stdout: string, workingDirectory: string): vscode.Uri | undefined {
  const match = dumpfileOpenedPattern.exec(stdout);
  return match ? vscode.Uri.file(path.resolve(workingDirectory, match[1].trim())) : undefined;
}
