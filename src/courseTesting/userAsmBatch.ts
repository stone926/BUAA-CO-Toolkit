// @index user-asm-batch — 用户 ASM 批次的 CPU 上下文、取消和已有测试结果保存编排
import type * as vscode from 'vscode';
import type { AppServices } from '../types';
import type { CourseTraceCaseInput } from '../courseTestCases';
import type { ContinuousTraceIteration, CourseTraceCaseResult } from '../courseTestReport';
import type { CourseTracePhase, CourseTraceRunOptions } from './traceRunner';
import { continuousStatusFromCounts, createContinuousCounts } from './continuous';
import { runContinuousTraceBatch } from './continuousTraceBatch';
import { asmCaseIndexDirectory } from '../asmCaseStore';
import { markCourseTraceArtifactsPruned } from '../courseTestReport';
import { normalizePathKey } from '../pathUtils';
import { continuousAutomaticTestPolicy } from './automaticTestPolicy';
import { WorkspaceCaseRetention } from './workspaceCaseRetention';

export interface UserAsmBatchReport {
  schemaVersion: 2;
  cpuResource: string;
  input: string;
  referenceMode: 'auto';
  totalCases: number;
  running: boolean;
  stopRequested: boolean;
  phase?: CourseTracePhase;
  iteration: ContinuousTraceIteration;
}

export function createUserAsmBatchReport(cpuResource: vscode.Uri, input: vscode.Uri, totalCases: number): UserAsmBatchReport {
  return {
    schemaVersion: 2, cpuResource: cpuResource.fsPath, input: input.fsPath, referenceMode: 'auto', totalCases,
    running: true, stopRequested: false,
    iteration: { index: 1, status: 'running', startedAt: new Date().toISOString(), summary: createContinuousCounts(), results: [] }
  };
}

export async function runUserAsmBatch(options: {
  services: AppServices;
  cases: readonly CourseTraceCaseInput[];
  cpuResource: vscode.Uri;
  report: UserAsmBatchReport;
  signal: AbortSignal;
  baseRunOptions?: CourseTraceRunOptions;
  run: (services: AppServices, item: CourseTraceCaseInput, options: CourseTraceRunOptions) => Promise<CourseTraceCaseResult>;
  updateMonitor: () => Promise<void>;
  updateView?: () => void;
}): Promise<void> {
  const { report, signal } = options;
  let retention: WorkspaceCaseRetention | undefined;
  report.iteration.source = { kind: 'selected', asmFiles: options.cases.map(item => item.asm.fsPath) };
  try {
    try {
      retention = new WorkspaceCaseRetention(asmCaseIndexDirectory(options.cpuResource), continuousAutomaticTestPolicy.retainedPassingCases);
      await retention.initialize();
    } catch {
      retention = undefined;
      options.services.output.appendLine('历史测试点读取失败，已保留原始用例并跳过本次留存清理');
    }
    await runContinuousTraceBatch({
      services: options.services, cases: options.cases, iteration: report.iteration,
      ownedCases: new Map(), sessionId: '', concurrency: 1, stopOnFailure: true, signal,
      run: async (item, _slot, caseSignal) => {
        try {
          return await options.run(options.services, item, {
            ...options.baseRunOptions,
            cpuResource: options.cpuResource,
            source: report.iteration.source,
            revealOutput: false,
            artifactOutputMode: 'case',
            signal: caseSignal,
            onPhase: phase => {
              if (caseSignal.aborted) return;
              report.phase = phase;
              options.updateView?.();
            }
          });
        } finally { delete report.phase; }
      },
      updateMonitor: options.updateMonitor
    });
    report.iteration.status = continuousStatusFromCounts(report.iteration.summary, false, signal.aborted);
  } catch (error) {
    report.iteration.status = signal.aborted ? 'stopped' : 'error';
    if (!signal.aborted) report.iteration.message = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report.running = false;
    report.stopRequested = signal.aborted;
    report.iteration.finishedAt = new Date().toISOString();
    if (retention) {
      try {
        await retention.observe(report.iteration.results.flatMap(result => result.caseManifest ? [result.caseManifest] : []));
        const { removed, refused } = await retention.prune();
        const removedPaths = new Set(removed.map(normalizePathKey));
        for (const result of report.iteration.results) {
          if (result.status === 'passed' && result.caseManifest && removedPaths.has(normalizePathKey(result.caseManifest))) markCourseTraceArtifactsPruned(result);
        }
        if (refused) options.services.output.appendLine('部分历史通过测试点未能安全清理，已保留原始用例');
      } catch { options.services.output.appendLine('历史通过测试点清理失败，已保留原始用例'); }
    }
    await options.updateMonitor();
  }
}
