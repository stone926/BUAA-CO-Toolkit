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
): Promise<ProgramImage | undefined> {
  if (signal.aborted) return undefined;
  if (isAssemblyInput(source)) {
    // The provider captures includes from disk as one immutable graph. Respect cancelled saves.
    if (!await vscode.workspace.saveAll(false) || signal.aborted) return undefined;
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
    return invocation.result.image;
  }
  const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === source.toString());
  const text = document?.getText() ?? (await readBoundedRegularFile(source.fsPath, {
    maximumBytes: 1024 * 1024, label: '机器码文件（最大 1 MiB）'
  })).toString('utf8');
  if (signal.aborted) return undefined;
  return parseHazardMachineCode(text, profile);
}
