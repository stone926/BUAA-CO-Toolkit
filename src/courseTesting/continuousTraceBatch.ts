// @index continuous-trace-batch — 持续测试批次的并发执行、结果保存和活动状态
import type * as vscode from 'vscode';
import type { AppServices } from '../types';
import { recordAsmCaseTestOutcome } from '../asmCaseStore';
import {
  neutralCourseTraceCaseResult, neutralCourseTraceStage, publicAutomaticDiagnosticMessage,
  type ContinuousTraceIteration, type CourseTraceCaseResult
} from '../courseTestReport';
import { normalizePathKey } from '../pathUtils';
import { addContinuousResult } from './continuous';
import { runConcurrentCases } from './concurrentCases';
import { markContinuousAsmCaseCancelled } from './continuousCaseRetention';
import { serializeFailureEvidence } from './failureEvidence';
import { manifestP7Of, type AsmCaseManifestUnion } from './manifestCodec';
import { probeScopeFromCase } from './p7ProbeScope';

export interface ContinuousTraceCaseLike {
  asm: vscode.Uri;
  stdin?: vscode.Uri;
  asmCase?: {
    id: string;
    manifestUri: vscode.Uri;
    asm: vscode.Uri;
    manifest?: AsmCaseManifestUnion;
  };
}

export interface ContinuousOwnedCase {
  manifestPath: string;
  state: 'generated' | 'cancelled' | 'passed' | 'failed' | 'error';
}

export async function runContinuousTraceBatch<T extends ContinuousTraceCaseLike>(options: {
  cases: readonly T[];
  services: AppServices;
  iteration: ContinuousTraceIteration;
  ownedCases: Map<string, ContinuousOwnedCase>;
  sessionId: string;
  concurrency: number;
  stopOnFailure: boolean;
  signal: AbortSignal;
  run: (item: T, slot: number, signal: AbortSignal) => Promise<CourseTraceCaseResult>;
  updateMonitor: (force: boolean) => Promise<void>;
}): Promise<void> {
  const { iteration, services } = options;
  const scopeOf = (item: T) => item.asmCase?.manifest
    ? probeScopeFromCase(manifestP7Of(item.asmCase.manifest)?.probe,
      'metadata' in item.asmCase.manifest ? item.asmCase.manifest.metadata : undefined)
    : undefined;
  const active = new Map<number, NonNullable<ContinuousTraceIteration['activeCase']>>();
  const publishActive = (): void => {
    if (active.size) {
      iteration.activeCases = [...active.values()].sort((a, b) => a.index - b.index);
      iteration.activeCase = iteration.activeCases[0];
    } else {
      delete iteration.activeCase;
      delete iteration.activeCases;
    }
  };
  try {
    await runConcurrentCases(options.cases, {
      concurrency: options.concurrency,
      signal: options.signal,
      phase: item => {
        const manifest = item.asmCase?.manifest;
        if (manifest && 'metadata' in manifest && manifest.metadata?.['source.coverage'] === 'gpr') return 0;
        return scopeOf(item) === 'special-timer-exl' ? 2 : 1;
      },
      key: item => normalizePathKey(item.asmCase?.manifestUri.fsPath ?? item.asm.fsPath),
      run: async (item, index, slot, signal) => {
        const probeScope = scopeOf(item);
        active.set(index, { index, caseId: item.asmCase?.id, probeScope });
        publishActive();
        let result: CourseTraceCaseResult;
        try {
          await options.updateMonitor(probeScope === 'special-timer-exl');
          if (signal.aborted) {
            result = { asm: item.asm.fsPath, status: 'error', stage: 'internal', message: '测试已取消', cancelled: true };
          } else {
            services.output.appendLine(`[第 ${iteration.index} 轮，测试点 ${index + 1}/${options.cases.length}] 正在验证`);
            try {
              result = await options.run(item, slot, signal);
            } catch (error) {
              result = {
                asm: item.asm.fsPath, stdin: item.stdin?.fsPath,
                ...(item.asmCase ? { asmSnapshot: item.asmCase.asm.fsPath } : {}),
                status: 'error', stage: 'internal',
                message: error instanceof Error ? error.message : String(error),
                ...(signal.aborted ? { cancelled: true as const } : {})
              };
            }
          }
        } finally {
          active.delete(index);
          publishActive();
        }
        return {
          ...neutralCourseTraceCaseResult(result),
          caseIndex: index,
          caseId: result.caseId ?? item.asmCase?.id,
          caseManifest: result.caseManifest ?? item.asmCase?.manifestUri.fsPath,
          ...(probeScope ? { probeScope } : {})
        };
      },
      shouldStop: result => options.stopOnFailure && !result.cancelled && result.status !== 'passed',
      completed: async result => {
        const ownedCase = result.caseManifest
          ? options.ownedCases.get(normalizePathKey(result.caseManifest)) : undefined;
        if (result.cancelled) {
          if (ownedCase && ownedCase.state === 'generated') {
            ownedCase.state = 'cancelled';
            try {
              await markContinuousAsmCaseCancelled(ownedCase.manifestPath, options.sessionId);
            } catch { services.output.appendLine('取消测试点状态保存失败'); }
          }
          return;
        }
        // Keep an earlier failure safe even if another stdin variant shares this manifest.
        if (ownedCase && ownedCase.state !== 'failed' && ownedCase.state !== 'error') ownedCase.state = result.status;
        try {
          await recordAsmCaseTestOutcome(result.caseManifest, {
            status: result.status,
            stage: neutralCourseTraceStage(result.stage),
            diagnostic: publicAutomaticDiagnosticMessage(result),
            evidence: serializeFailureEvidence(result),
            ...(ownedCase ? { continuous: { sessionId: options.sessionId, state: result.status } } : {})
          });
        } catch { services.output.appendLine('测试历史结果保存失败'); }
        iteration.results.push(result);
        addContinuousResult(iteration.summary, result);
        await options.updateMonitor(result.probeScope === 'special-timer-exl');
      }
    });
  } finally {
    active.clear();
    publishActive();
  }
}
