// @index verilog-user-cpu-program — 用户 CPU testbench 的 ASM 选择、汇编与本次运行输入
import * as vscode from 'vscode';
import type { AppServices } from '../types';
import { getProfile } from '../config';
import { pickOneFile } from '../workflowInputs';
import { workspaceFolderFor, writeTextFile } from '../fsUtil';
import {
  courseInstructionImageWordCapacity,
  courseInstructionImageWordsWithOrdinaryHalt,
  wordsToHexText
} from '../mips/core/assembler/artifacts';
import { assembleWithPreflight, preflightFailureMessage } from '../mips/providers/providerResolver';
import { resolveCourseEnginePlan } from '../mips/providers/courseEnginePolicy';
import { verilogDocumentForUri } from './documentContext';
import { isUserTestbenchUri } from './userTestbench';
import { userCpuTestbenchProfile, type UserCpuTestbenchProfile } from './userCpuTestbench';

export type UserCpuProgramPreparation =
  | { kind: 'unmanaged' }
  | { kind: 'ready'; machineCodeSource: vscode.Uri }
  | { kind: 'stopped' };

/** Owned by one UI action so waveform compile retries keep the same input bytes. */
export interface UserCpuProgramSession {
  program?: { testbench: string; profile: string; hexText: string };
}

/** Called under the workspace simulation lock; never edits the user-owned TB or ASM. */
export async function prepareUserCpuProgram(
  services: AppServices,
  testbench: vscode.Uri | undefined,
  outDir: vscode.Uri,
  signal?: AbortSignal,
  session?: UserCpuProgramSession
): Promise<UserCpuProgramPreparation> {
  if (!testbench || !isUserTestbenchUri(testbench)) return { kind: 'unmanaged' };
  const document = await verilogDocumentForUri(testbench);
  const profile = document && userCpuTestbenchProfile(document.getText());
  if (!profile) return { kind: 'unmanaged' };
  return prepareUserCpuProgramForTestbench(services, testbench, profile, outDir, signal, session);
}

/** Also prepares input before a missing CPU testbench is created. */
export async function prepareUserCpuProgramForTestbench(
  services: AppServices,
  testbench: vscode.Uri,
  profile: UserCpuTestbenchProfile,
  outDir: vscode.Uri,
  signal?: AbortSignal,
  session?: UserCpuProgramSession
): Promise<UserCpuProgramPreparation> {
  if (signal?.aborted) return { kind: 'stopped' };
  try {
    if (getProfile(testbench) !== profile) {
      throw new Error(`CPU testbench 属于 ${profile}，请使用对应的项目 Profile`);
    }
    const machineCodeSource = vscode.Uri.joinPath(outDir, 'co_user_program.txt');
    if (session?.program?.testbench === testbench.toString() && session.program.profile === profile) {
      await writeTextFile(machineCodeSource, session.program.hexText);
      return { kind: 'ready', machineCodeSource };
    }
    // A separate staging file keeps a failed/cancelled assembly out of code.txt.
    // Always ask, even when only one ASM exists or an ASM editor is active.
    const asm = await pickOneFile(
      '选择 CPU testbench 使用的 ASM（取消则停止本次运行）',
      { ASM: ['asm', 's', 'mips'] },
      workspaceFolderFor(testbench)?.uri
    );
    if (!asm || signal?.aborted) return { kind: 'stopped' };
    const invocation = await assembleWithPreflight(services, {
      sourceUri: asm,
      target: { kind: 'userText', outputFile: machineCodeSource },
      revealOutput: false,
      requirements: {
        profile,
        instructionLayers: ['required', 'commonExtensions', 'marsCompatibility'],
        pseudoInstructions: true
      }
    }, { signal }, resolveCourseEnginePlan('builtin', profile));
    if (signal?.aborted) return { kind: 'stopped' };
    const result = invocation.result;
    if (!result?.ok || !result.image) {
      throw new Error(result?.status.stderr.trim() || preflightFailureMessage(invocation.preflight)
        || '内置汇编器未返回可加载的程序');
    }
    const words = courseInstructionImageWordsWithOrdinaryHalt(result.image, profile);
    services.output.appendLine(`CPU testbench 已汇编 ${asm.fsPath}`);
    if (signal?.aborted) return { kind: 'stopped' };
    // Fully initialize IM, including the P7 kernel gap and words after the halt tail.
    const initialized = Array.from({ length: courseInstructionImageWordCapacity }, (_, index) => words[index] ?? 0);
    const hexText = wordsToHexText(initialized);
    await writeTextFile(machineCodeSource, hexText);
    if (session) session.program = { testbench: testbench.toString(), profile, hexText };
    return { kind: 'ready', machineCodeSource };
  } catch (error) {
    if (!signal?.aborted) {
      const detail = error instanceof Error ? error.message : String(error);
      services.output.appendLine(`CPU 程序准备失败：${detail}`);
      vscode.window.showErrorMessage('CPU 程序准备失败，请查看插件输出面板');
    }
    return { kind: 'stopped' };
  }
}
