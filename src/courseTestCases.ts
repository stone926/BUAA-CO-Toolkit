import * as vscode from 'vscode';
import { AsmCase } from './asmCaseStore';
import { AsmCaseSource } from './asmCaseStoreCore';
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

export function caseResultFields(asmCase: AsmCase): Pick<NeutralCourseTraceCaseResult, 'caseId' | 'caseManifest' | 'asmSnapshot'> {
  return {
    caseId: asmCase.id,
    caseManifest: asmCase.manifestUri.fsPath,
    asmSnapshot: asmCase.asm.fsPath
  };
}
