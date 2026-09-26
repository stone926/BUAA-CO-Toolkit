// @index verilog-user-cpu-program — 用户 CPU testbench 的可选 ASM 选择、汇编与本次运行输入
import * as vscode from 'vscode';
import type { AppServices } from '../types';
import { getProfile } from '../config';
import { resolveAsmCaseInput } from '../asmCaseStore';
import { writeTextFile } from '../fsUtil';
import {
  courseInstructionImageWordCapacity,
  courseInstructionImageWordsWithOrdinaryHalt,
  wordsToHexText
} from '../mips/core/assembler/artifacts';
import { assembleWithPreflight, preflightFailureMessage } from '../mips/providers/providerResolver';
import { resolveCourseEnginePlan } from '../mips/providers/courseEnginePolicy';
import { verilogDocumentForUri } from './documentContext';
import { isUserTestbenchUri } from './userTestbench';
import { userCpuTestbenchProfile } from './userCpuTestbench';

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
    const choice = await vscode.window.showQuickPick([
      { label: '选择 ASM', description: '自动汇编并加载指令，无需修改 testbench', program: true },
      { label: '不选择 ASM', description: '使用全零空程序，保留手动激励', program: false }
    ], { title: 'CPU testbench 的程序输入', placeHolder: '选择 ASM，或使用空程序运行' });
    if (!choice || signal?.aborted) return { kind: 'stopped' };

    // A separate staging file keeps a failed/cancelled assembly out of code.txt.
    let words: readonly number[] = [];
    if (choice.program) {
      const asm = await resolveAsmCaseInput('选择 CPU testbench 使用的 ASM（取消则停止本次运行）');
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
      words = courseInstructionImageWordsWithOrdinaryHalt(result.image, profile);
      services.output.appendLine(`CPU testbench 已汇编 ${asm.fsPath}`);
    } else {
      services.output.appendLine('CPU testbench 使用空程序，不加载上次运行的机器码');
    }
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
