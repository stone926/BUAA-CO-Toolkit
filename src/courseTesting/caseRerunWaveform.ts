// @index course-case-rerun-waveform — 为自动课程 DUT 仿真附加有界 VCD，复用共享 dump 与原 DUT 参数
import { lstat } from 'fs/promises';
import type * as vscode from 'vscode';
import { samePath } from '../pathUtils';
import type { AppServices } from '../types';
import { runVerilogSimulation, type VerilogSimulationRunOutput } from '../verilog/simulationRunner';
import { WaveformDumpSetup, describeDumpMemories, locateDumpFile } from '../waveform/host/waveformDumpSetup';
import type { MemoryDump } from '../waveform/design/designHierarchy';

/** Bound disk evidence; leave room for Icarus's final buffered dump block. */
export const maximumCourseRerunWaveformBytes = 64 * 1024 * 1024;
const waveformDumpLimit = maximumCourseRerunWaveformBytes - 1024 * 1024;

export interface CourseRerunWaveformCapture {
  runDut: typeof runVerilogSimulation;
  waveform?: vscode.Uri;
  issue?: string;
}

/** Decorate only DUT compilation: TB selection, oracle, IRQ/probe metadata and budget stay unchanged. */
export function courseRerunWaveformCapture(dump: vscode.Uri): CourseRerunWaveformCapture {
  const capture: CourseRerunWaveformCapture = {
    runDut: async (services, options = {}) => {
      let requestedMemories: readonly MemoryDump[] | undefined;
      let run: VerilogSimulationRunOutput | undefined;
      while (!options.signal?.aborted) {
        const setup = new WaveformDumpSetup(dump, requestedMemories, options.moduleRegistry, waveformDumpLimit);
        run = await runVerilogSimulation(services, { ...options, ...setup.hooks(), announceSuccess: false });
        if (run) setup.inspectCompile(run.compileResult);
        if (!setup.rejection || !run || options.signal?.aborted) break;
        const rejected = setup.rejection.unattributed
          ? setup.memories
          : setup.memories.filter((memory) => setup.rejection?.memories.includes(memory));
        if (!rejected.length) break;
        services.output.appendLine(`存储器逐字 dump 被编译器拒绝，去掉 ${describeDumpMemories(rejected)} 后重试；普通信号仍会记录`);
        requestedMemories = setup.memories.filter((memory) => !rejected.includes(memory));
      }
      if (run?.simResult && !options.signal?.aborted) {
        await validateCapturedWaveform(capture, dump, run, services);
      }
      return run;
    }
  };
  return capture;
}

async function validateCapturedWaveform(
  capture: CourseRerunWaveformCapture,
  expected: vscode.Uri,
  run: VerilogSimulationRunOutput,
  services: AppServices
): Promise<void> {
  const opened = locateDumpFile(run.simResult!.stdout, run.generated.outDir.fsPath);
  if (!opened || !samePath(opened.fsPath, expected.fsPath)) {
    capture.issue = '重跑仿真没有声明打开本次用例的 VCD 波形；请检查 CPU 源码中的 $dumpfile';
    return;
  }
  try {
    const info = await lstat(expected.fsPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
      capture.issue = '重跑仿真没有生成可读取的 VCD 波形文件';
    } else if (info.size > maximumCourseRerunWaveformBytes) {
      capture.issue = '重跑波形超过 64 MiB 的大小限制';
    } else {
      capture.waveform = expected;
      if (info.size >= waveformDumpLimit || /dump.*limit.*(?:reach|exceed)/i.test(run.simResult!.stdout)) {
        capture.issue = '重跑波形达到大小限制，后续波形未记录；CPU 测试仍使用完整写回记录';
        services.output.appendLine(capture.issue);
      }
    }
  } catch (error) {
    capture.issue = `无法读取重跑波形：${error instanceof Error ? error.message : String(error)}`;
  }
}
