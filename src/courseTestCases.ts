import * as vscode from 'vscode';
import { AsmCase } from './asmCaseStore';
import { AsmCaseSource } from './asmCaseStoreCore';
import type { AssembleResult } from './mips/providers/contracts';
import { engineRunWasCancelled, engineStageFailureMessage } from './courseTestMessages';
import {
  CourseTraceBatchSource,
  NeutralCourseTraceCaseResult,
  NeutralCourseTraceStage
} from './courseTestReport';

export interface CourseTraceCaseInput {
  asm: vscode.Uri;
  stdin?: vscode.Uri;
  asmCase?: AsmCase;
}

export function failedCase(
  item: CourseTraceCaseInput,
  stage: NeutralCourseTraceStage,
  message: string,
  machineCode?: vscode.Uri,
  oracleOut?: vscode.Uri,
  asmCase?: AsmCase,
  cancelled = false
): NeutralCourseTraceCaseResult {
  return {
    asm: item.asm.fsPath,
    stdin: item.stdin?.fsPath,
    ...(asmCase ? caseResultFields(asmCase) : {}),
    status: 'error',
    ...(cancelled ? { cancelled: true as const } : {}),
    stage,
    message,
    machineCode: machineCode?.fsPath,
    oracleOut: oracleOut?.fsPath
  };
}

export function failedAssemblyCase(
  item: CourseTraceCaseInput, asmCase: AsmCase, dump: AssembleResult | undefined, signal?: AbortSignal
): NeutralCourseTraceCaseResult {
  return {
    ...failedCase(item, 'assemble', engineStageFailureMessage('测试中止：汇编器导出机器码失败', dump?.status),
      undefined, undefined, asmCase, engineRunWasCancelled(dump?.status, signal)),
    referenceEngine: dump?.enginePlan?.primaryEngineId
  };
}

export function asmCaseSourceFromBatchSource(source: CourseTraceBatchSource): AsmCaseSource {
  if (source.kind === 'generator') {
    return {
      kind: source.generator === 'builtin:random-asm' ? 'builtin' : 'generator',
      generator: source.generator,
      commandLine: source.commandLine,
      cwd: source.cwd
    };
  }
  return { kind: 'selected' };
}

export function caseResultFields(asmCase: AsmCase): Pick<NeutralCourseTraceCaseResult, 'caseId' | 'caseManifest' | 'asmSnapshot' | 'referenceEngine' | 'referenceNote'> {
  return {
    caseId: asmCase.id,
    caseManifest: asmCase.manifestUri.fsPath,
    asmSnapshot: asmCase.asm.fsPath,
    ...(asmCase.manifest.version === 2 ? { referenceEngine: asmCase.manifest.program.assembler.id,
      ...(asmCase.manifest.metadata?.['reference.timing'] === 'p7-timer-observed'
        ? { referenceNote: '本次比较架构写回；Timer 时序由 P7 黑盒 probe 独立检查' } : {}) } : {})
  };
}
