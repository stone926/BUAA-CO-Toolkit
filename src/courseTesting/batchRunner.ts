// @index course-trace-batch-runner — 批量课程 Trace case 调度与报告写入
import * as path from 'path';
import * as vscode from 'vscode';
import { CO_OUT_DIR } from '../constants';
import { ensureDirectory, workspaceFolderForOrFirst, writeTextFile } from '../fsUtil';
import { revealOutputChannel } from '../process';
import { AppServices } from '../types';
import { recordAsmCaseTestOutcome } from '../asmCaseStore';
import { caseResultFields, CourseTraceCaseInput } from '../courseTestCases';
import {
  batchSummary,
  createCourseTraceBatchReport,
  neutralCourseTraceCaseResult,
  publicAutomaticDiagnosticMessage,
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
import { tryAcquireCourseTestSession } from './courseTestSession';

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
  const automatic = source.kind === 'generator';
  const sessionLease = tryAcquireCourseTestSession('batch');
  if (!sessionLease || activeCourseTraceBatch) {
    sessionLease?.release();
    vscode.window.showWarningMessage(automatic
      ? '已有一个测试任务正在运行'
      : '已有一个课程测试正在运行');
    return;
  }
  const controller = new AbortController();
  const signal = controller.signal;
  const propagateExternalAbort = (): void => controller.abort();
  activeCourseTraceBatch = { controller, signal, startedAt: Date.now() };
  const previousStatus = services.statusBar.text;
  try {
    if (options.signal) {
      options.signal.addEventListener('abort', propagateExternalAbort, { once: true });
      if (options.signal.aborted) controller.abort();
    }
    if (!automatic) {
      revealOutputChannel(services.output);
    }
    services.output.appendLine('');
    const sourceLabel = automatic ? '自动测试' : '批量课程测试';
    services.output.appendLine(`${sourceLabel}: ${cases.length} 个用例`);
    services.statusBar.text = automatic ? 'CO: 自动测试' : 'CO: 批量测试';

    // One logical batch session owns one AbortController. Every assembler/oracle/
    // ISim/Logisim process in this loop receives the same signal.
    const runOptions = await resolveRunOptions(services, cases[0].asm, {
      source,
      signal,
      ...(automatic ? { revealOutput: false } : {})
    });
    if (!runOptions) {
      return;
    }
    runOptions.signal = signal;

    const results: CourseTraceCaseResult[] = [];
    for (let i = 0; i < cases.length; i++) {
      if (signal.aborted) {
        services.output.appendLine(automatic ? '自动测试已停止' : '批量课程测试已停止');
        break;
      }
      const item = cases[i];
      const asm = item.asm;
      services.output.appendLine('');
      services.output.appendLine(automatic
        ? `[${i + 1}/${cases.length}] 正在验证测试点`
        : `[${i + 1}/${cases.length}] ${asm.fsPath}`);
      if (item.stdin && !automatic) {
        services.output.appendLine(`stdin: ${item.stdin.fsPath}`);
      }
      try {
        const result = neutralCourseTraceCaseResult(await runCourseTraceCase(services, item, runOptions));
        results.push(result);
        if (automatic) {
          try {
            await recordAsmCaseTestOutcome(result.caseManifest, {
              status: result.status,
              stage: result.stage,
              diagnostic: publicAutomaticDiagnosticMessage(result)
            });
          } catch {
            services.output.appendLine('测试历史结果保存失败');
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        const result: CourseTraceCaseResult = {
          asm: asm.fsPath,
          stdin: item.stdin?.fsPath,
          ...(item.asmCase ? caseResultFields(item.asmCase) : {}),
          status: 'error',
          stage: 'internal',
          message
        };
        results.push(result);
        if (automatic) {
          try {
            await recordAsmCaseTestOutcome(result.caseManifest, {
              status: result.status,
              stage: 'internal',
              diagnostic: publicAutomaticDiagnosticMessage(result)
            });
          } catch {
            services.output.appendLine('测试历史结果保存失败');
          }
        }
      }
    }

    const report = await writeBatchTraceReport(cases[0].asm, results, source);
    showBatchTraceReport(results, report, undefined, source);

    const summary = batchSummary(results);
    const passed = summary.passed;
    const failed = summary.failed;
    const errors = summary.errors;
    const completionLabel = automatic ? '自动测试' : '批量测试';
    const message = signal.aborted
      ? `${completionLabel}已停止: ${results.length} 个用例已执行，${passed} 通过, ${failed} 失败, ${errors} 错误`
      : `${completionLabel}完成: ${passed} 通过, ${failed} 失败, ${errors} 错误`;
    if (failed || errors) {
      vscode.window.showWarningMessage(message);
    } else {
      vscode.window.showInformationMessage(message);
    }
  } finally {
    options.signal?.removeEventListener('abort', propagateExternalAbort);
    activeCourseTraceBatch = undefined;
    sessionLease.release();
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
