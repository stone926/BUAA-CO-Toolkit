// @index course-trace-batch-runner — 批量课程 Trace case 调度与报告写入
import * as path from 'path';
import * as vscode from 'vscode';
import { CO_OUT_DIR } from '../constants';
import { ensureDirectory, workspaceFolderForOrFirst, writeTextFile } from '../fsUtil';
import { revealOutputChannel } from '../process';
import { AppServices } from '../types';
import { CourseTraceCaseInput } from '../courseTestCases';
import {
  batchSummary,
  createCourseTraceBatchReport,
  neutralCourseTraceCaseResult,
  showBatchTraceReport
} from '../courseTestReport';
import type {
  CourseTraceBatchSource,
  CourseTraceCaseResult
} from '../courseTestReport';
import {
  CourseTraceRunOptions,
  runCourseTraceCase
} from './traceRunner';

export type ResolveCourseTraceRunOptions = (
  services: AppServices,
  resource: vscode.Uri,
  base?: CourseTraceRunOptions
) => Promise<CourseTraceRunOptions | undefined>;

interface ActiveCourseTraceBatch {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly startedAt: number;
}

let activeCourseTraceBatch: ActiveCourseTraceBatch | undefined;

/** True while a batch owns the shared cancellation session. */
export function isCourseTraceBatchRunning(): boolean {
  return activeCourseTraceBatch !== undefined;
}

/** Abort every assembler/oracle/DUT process in the current batch; idempotent. */
export function stopCourseTraceBatch(): boolean {
  if (!activeCourseTraceBatch) return false;
  activeCourseTraceBatch.controller.abort();
  return true;
}

export async function runCourseTraceBatch(
  services: AppServices,
  cases: CourseTraceCaseInput[],
  source: CourseTraceBatchSource,
  resolveRunOptions: ResolveCourseTraceRunOptions,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  if (activeCourseTraceBatch) {
    vscode.window.showWarningMessage('已有一个批量课程 Trace 测试会话正在运行');
    return;
  }
  revealOutputChannel(services.output);
  services.output.appendLine('');
  const sourceLabel = source.kind === 'generator' ? '生成的课程 Trace 测试' : '批量课程 Trace 测试';
  services.output.appendLine(`${sourceLabel}: ${cases.length} 个用例`);

  const controller = new AbortController();
  const signal = controller.signal;
  const propagateExternalAbort = (): void => controller.abort();
  if (options.signal) {
    options.signal.addEventListener('abort', propagateExternalAbort, { once: true });
    if (options.signal.aborted) controller.abort();
  }
  activeCourseTraceBatch = { controller, signal, startedAt: Date.now() };
  const previousStatus = services.statusBar.text;
  services.statusBar.text = 'CO: Batch Trace';
  try {
    // One logical batch session owns one AbortController. Every assembler/oracle/
    // ISim/Logisim process in this loop receives the same signal.
    const runOptions = await resolveRunOptions(services, cases[0].asm, { source, signal });
    if (!runOptions) {
      return;
    }
    runOptions.signal = signal;

    const results: CourseTraceCaseResult[] = [];
    for (let i = 0; i < cases.length; i++) {
      if (signal.aborted) {
        services.output.appendLine('批量课程 Trace 测试已停止');
        break;
      }
      const item = cases[i];
      const asm = item.asm;
      services.output.appendLine('');
      services.output.appendLine(`[${i + 1}/${cases.length}] ${asm.fsPath}`);
      if (item.stdin) {
        services.output.appendLine(`stdin: ${item.stdin.fsPath}`);
      }
      try {
        results.push(neutralCourseTraceCaseResult(await runCourseTraceCase(services, item, runOptions)));
      } catch (error) {
        if (signal.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          asm: asm.fsPath,
          stdin: item.stdin?.fsPath,
          status: 'error',
          stage: 'compare',
          message
        });
      }
    }

    const report = await writeBatchTraceReport(cases[0].asm, results, source);
    showBatchTraceReport(results, report, undefined, source);

    const summary = batchSummary(results);
    const passed = summary.passed;
    const failed = summary.failed;
    const errors = summary.errors;
    const message = signal.aborted
      ? `批量 Trace 测试已停止: ${results.length} 个用例已执行，${passed} 通过, ${failed} 失败, ${errors} 错误`
      : `批量 Trace 测试完成: ${passed} 通过, ${failed} 失败, ${errors} 错误`;
    if (failed || errors) {
      vscode.window.showWarningMessage(message);
    } else {
      vscode.window.showInformationMessage(message);
    }
  } finally {
    options.signal?.removeEventListener('abort', propagateExternalAbort);
    activeCourseTraceBatch = undefined;
    services.statusBar.text = previousStatus;
  }
}

async function writeBatchTraceReport(
  firstAsm: vscode.Uri,
  results: CourseTraceCaseResult[],
  source: CourseTraceBatchSource
): Promise<vscode.Uri> {
  const folder = workspaceFolderForOrFirst(firstAsm);
  const baseDir = folder?.uri.fsPath ?? path.dirname(firstAsm.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, CO_OUT_DIR));
  await ensureDirectory(outDir);
  const report = vscode.Uri.file(path.join(outDir.fsPath, 'trace-batch-report.json'));
  await writeTextFile(report, JSON.stringify(
    createCourseTraceBatchReport(results, source),
    null,
    2
  ) + '\n');
  return report;
}
