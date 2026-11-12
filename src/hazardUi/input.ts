// @index hazard-input — 文件选择、内置汇编与有界机器码读取；保持完整 ProgramImage 的 data/sourceMap
import * as path from 'path';
import * as vscode from 'vscode';
import { CO_HAZARD_DIR } from '../constants';
import { pickOneFile } from '../workflowInputs';
import { assembleWithPreflight, preflightFailureMessage } from '../mips/providers/providerResolver';
import { resolveCourseEnginePlan } from '../mips/providers/courseEnginePolicy';
import { readBoundedRegularFile } from '../mips/replay/boundedFile';
import type { ProgramImage } from '../mips/core/api';
import type { AppServices } from '../types';
import { parseHazardMachineCode } from '../hazardAnalysis/machineCode';
import type { HazardProfile } from '../hazardAnalysis/reportTypes';
import type { ExternalInterruptRequest } from '../mips/core/devices/interruptController';
import { loadHazardCaseInput } from './caseInput';

export interface PreparedHazardInput {
  readonly image: ProgramImage;
  readonly executionSource: 'standalone' | 'case';
  readonly caseId?: string;
  readonly externalInterrupts: readonly ExternalInterruptRequest[];
}

const inputExtensions = new Set(['.asm', '.s', '.mips', '.txt', '.hex', '.coe']);

export function isHazardInput(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && inputExtensions.has(path.extname(uri.fsPath).toLowerCase());
}

export function isAssemblyInput(uri: vscode.Uri): boolean {
  return ['.asm', '.s', '.mips'].includes(path.extname(uri.fsPath).toLowerCase());
}

export async function selectHazardInput(folder?: vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
  return pickOneFile(
    '选择冲突分析使用的汇编或机器码（取消则停止本次分析）',
    { '汇编 / 机器码': ['asm', 's', 'mips', 'txt', 'hex', 'coe'] },
    folder?.uri
  );
}

export async function prepareHazardInput(
  services: AppServices,
  source: vscode.Uri,
  folder: vscode.WorkspaceFolder,
  profile: HazardProfile,
  signal: AbortSignal
): Promise<PreparedHazardInput | undefined> {
  if (signal.aborted) return undefined;
  if (isAssemblyInput(source) && (!await vscode.workspace.saveAll(false) || signal.aborted)) return undefined;
  const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === source.toString());
  const savedCase = await loadHazardCaseInput(source.fsPath, folder.uri.fsPath, profile);
  if (signal.aborted) return undefined;
  if (savedCase) {
    if (document?.isDirty) throw new Error('用例文件有未保存修改；请保存并重新生成用例后分析。');
    return { ...savedCase, executionSource: 'case' };
  }
  if (isAssemblyInput(source)) {
    // The provider captures includes from disk as one immutable graph. Respect cancelled saves.
    const invocation = await assembleWithPreflight(services, {
      sourceUri: source,
      target: { kind: 'userText', outputFile: vscode.Uri.joinPath(folder.uri, CO_HAZARD_DIR, 'assembled.txt') },
      revealOutput: false,
      requirements: { profile, instructionLayers: ['required', 'commonExtensions', 'marsCompatibility'], pseudoInstructions: true }
    }, { signal }, resolveCourseEnginePlan('builtin', profile));
    if (signal.aborted) return undefined;
    if (!invocation.result?.ok || !invocation.result.image) {
      throw new Error(invocation.result?.status.stderr.trim()
        || preflightFailureMessage(invocation.preflight) || '内置汇编器未返回程序，请检查汇编错误');
    }
    return { image: invocation.result.image, executionSource: 'standalone', externalInterrupts: [] };
  }
  const text = document?.getText() ?? (await readBoundedRegularFile(source.fsPath, {
    maximumBytes: 1024 * 1024, label: '机器码文件（最大 1 MiB）'
  })).toString('utf8');
  if (signal.aborted) return undefined;
  return { image: parseHazardMachineCode(text, profile), executionSource: 'standalone', externalInterrupts: [] };
}
