// @index waveform-simulation — “仿真并查看波形”命令：bundled Icarus 附加 dump 顶层模块运行，GRF 等小存储器逐字记录，编译器拒绝时去掉出错的存储器重试，最后打开 VCD

import * as path from 'path';
import * as vscode from 'vscode';
import { CO_WAVE_DIR } from '../../constants';
import { ensureDirectory, workspaceFolderFor } from '../../fsUtil';
import type { MutableVerilogModuleProvider } from '../../language/verilog/moduleProvider';
import { pathExists } from '../../nodeFs';
import { samePath } from '../../pathUtils';
import type { AppServices, RunResult } from '../../types';
import { IverilogRunOutput, runIverilog } from '../../verilog/iverilogRunner';
import type { TestbenchResolution } from '../../verilog/testbenchResolver';
import { findDumpableMemories, MemoryDump } from '../design/designHierarchy';
import {
  buildWaveformDumper,
  dumperRejection,
  DumperRejection,
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
  let attempt = await runWithDumper(dependencies, resource, waveDirectory, undefined);
  const dropped: MemoryDump[] = [];
  // Drop the memories the compiler blamed and retry; once nothing is dumped no rejection can occur.
  while (attempt.rejection) {
    const rejected = attempt.rejection.unattributed
      ? attempt.memories
      : attempt.memories.filter((memory) => attempt.rejection?.memories.includes(memory));
    dropped.push(...rejected);
    dependencies.services.output.appendLine(`存储器逐字 dump 被编译器拒绝（层次路径或大小与静态推算不一致），去掉 ${describeMemories(rejected)} 后重试`);
    attempt = await runWithDumper(dependencies, resource, waveDirectory, attempt.memories.filter((memory) => !rejected.includes(memory)));
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
  requestedMemories: readonly MemoryDump[] | undefined
): Promise<DumperAttempt> {
  let memories: readonly MemoryDump[] = requestedMemories ?? [];
  let dumperText = '';
  let rejection: DumperRejection | undefined;
  const rejectsMemoryDump = (result: RunResult): boolean => {
    rejection = memories.length ? dumperRejection(`${result.stderr}\n${result.stdout}`, dumperText, memories) : undefined;
    return rejection !== undefined;
  };
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
        shouldReportCompileFailure: (result) => !rejectsMemoryDump(result),
        acceptCompileResult: (result) => !rejectsMemoryDump(result),
        generatedTopModules: async ({ folder, outDir, testbench }) => {
          await ensureDirectory(waveDirectory);
          memories = requestedMemories ?? await discoverMemories(testbench, dependencies.moduleRegistry);
          const dumpPath = path.join(waveDirectory.fsPath, `${testbench.moduleName}.vcd`);
          const moduleName = waveformDumperModuleName(folder.uri.fsPath);
          dumperText = buildWaveformDumper({
            moduleName,
            testbench: testbench.moduleName,
            dumpFile: dumpFileArgument(outDir.fsPath, dumpPath),
            memories
          });
          return [{ moduleName, fileName: waveformDumperFileName, text: dumperText }];
        }
      });
    } finally {
      cancellation.dispose();
    }
  });
  return { run, memories, rejection };
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

function describeMemories(memories: readonly MemoryDump[]): string {
  const names = memories.slice(0, 3).map((memory) => memory.path);
  return memories.length > names.length ? `${names.join('、')} 等 ${memories.length} 个存储器` : names.join('、');
}

/** The dump the simulator actually opened (a testbench's own `$dumpfile` may win the race). */
export function locateDumpFile(stdout: string, workingDirectory: string): vscode.Uri | undefined {
  const match = dumpfileOpenedPattern.exec(stdout);
  return match ? vscode.Uri.file(path.resolve(workingDirectory, match[1].trim())) : undefined;
}
