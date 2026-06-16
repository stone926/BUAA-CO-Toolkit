import * as vscode from 'vscode';
import { AsmCase } from './asmCaseStore';
import { AsmCaseSource } from './asmCaseStoreCore';
import {
  CourseTraceBatchSource,
  CourseTraceCaseResult,
  CourseTraceStage
} from './courseTestReport';

export interface CourseTraceCaseInput {
  asm: vscode.Uri;
  stdin?: vscode.Uri;
  asmCase?: AsmCase;
}

export function failedCase(
  item: CourseTraceCaseInput,
  stage: CourseTraceStage,
  message: string,
  machineCode?: vscode.Uri,
  marsOut?: vscode.Uri,
  asmCase?: AsmCase
): CourseTraceCaseResult {
  return {
    asm: item.asm.fsPath,
    stdin: item.stdin?.fsPath,
    ...(asmCase ? caseResultFields(asmCase) : {}),
    status: 'error',
    stage,
    message,
    machineCode: machineCode?.fsPath,
    marsOut: marsOut?.fsPath
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

export function caseResultFields(asmCase: AsmCase): Pick<CourseTraceCaseResult, 'caseId' | 'caseManifest' | 'asmSnapshot'> {
  return {
    caseId: asmCase.id,
    caseManifest: asmCase.manifestUri.fsPath,
    asmSnapshot: asmCase.asm.fsPath
  };
}
