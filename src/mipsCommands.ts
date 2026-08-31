// @index mips-commands — ASM 导出命令分派：P3–P7 使用 builtin，P2 保留 MARS provider

import * as path from 'path';
import * as vscode from 'vscode';

import {
  ensureConcreteProfile,
  getMachineCode,
  shouldRevealOutput
} from './config';
import { Commands } from './constants';
import { ensureDirectory, writeTextFile } from './fsUtil';
import {
  courseInstructionImageWordsWithOrdinaryHalt,
  imageSegmentWords,
  wordsToHexText
} from './mips/core/assembler/artifacts';
import { BUILTIN_TS_ENGINE_ID, resolveCourseEnginePlan } from './mips/providers/courseEnginePolicy';
import {
  assembleWithPreflight,
  preflightFailureMessage
} from './mips/providers/providerResolver';
import type { CourseProfile } from './mips/core/generated/isaCatalog';
import type { AppServices } from './types';

type AssemblyDumpTarget = 'userText' | 'kernelText';

export function registerMipsAssemblyCommands(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.Mips.DumpText, () => dumpCurrentMipsFile(services, 'userText')),
    vscode.commands.registerCommand(Commands.Mips.DumpKernelText, () => dumpCurrentMipsFile(services, 'kernelText'))
  );
}

async function resolveCurrentMipsDocument(): Promise<vscode.TextDocument | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'mipsasm') {
    vscode.window.showErrorMessage('请先打开一个 MIPS 汇编文件');
    return undefined;
  }
  const document = editor.document;
  if (document.isUntitled) {
    vscode.window.showErrorMessage('使用 ASM 工具前请先保存文件');
    return undefined;
  }
  if (document.isDirty) {
    await document.save();
  }
  return document;
}

async function dumpCurrentMipsFile(
  services: AppServices,
  target: AssemblyDumpTarget
): Promise<void> {
  const document = await resolveCurrentMipsDocument();
  if (!document) return;
  await dumpMipsFile(services, document.uri, target);
}

/**
 * Export one ASM section using the builtin assembler whenever its P3-P7 course
 * contract applies. P2 deliberately remains on MARS because the builtin
 * assembler contract starts at P3 and does not model P2's syscall workflow.
 */
export async function dumpMipsFile(
  services: AppServices,
  sourceUri: vscode.Uri,
  target: AssemblyDumpTarget
): Promise<boolean> {
  const profile = await ensureConcreteProfile(sourceUri, '汇编 ASM 需要先确定项目 Profile');
  if (!profile) return false;
  if (target === 'kernelText' && profile !== 'P7') {
    vscode.window.showErrorMessage('内核文本段导出仅适用于 P7 Profile');
    return false;
  }
  if (!['P2', 'P3', 'P4', 'P5', 'P6', 'P7'].includes(profile)) {
    vscode.window.showErrorMessage('ASM 导出仅支持 P2–P7 Profile');
    return false;
  }

  const outputFile = assemblyDumpOutput(sourceUri, target);
  const plan = resolveCourseEnginePlan(profile === 'P2' ? 'mars' : 'builtin', profile);
  try {
    const invocation = await assembleWithPreflight(services, {
      sourceUri,
      target: { kind: target, outputFile },
      revealOutput: shouldRevealOutput(sourceUri),
      requirements: {
        profile,
        instructionLayers: ['required', 'commonExtensions', 'marsCompatibility'],
        pseudoInstructions: true
      }
    }, undefined, plan);
    const result = invocation.result;
    if (!result?.ok || !result.outputFile) {
      const detail = result?.status.stderr.trim() || preflightFailureMessage(invocation.preflight);
      if (detail) services.output.appendLine(detail);
      vscode.window.showErrorMessage(`${target === 'kernelText' ? '内核文本段' : '文本段'}导出失败，请查看插件输出面板`);
      return false;
    }

    if (result.descriptor.id === BUILTIN_TS_ENGINE_ID) {
      if (!result.image) {
        throw new Error('内置汇编器未返回可验证的 ProgramImage');
      }
      const words = target === 'kernelText'
        ? imageSegmentWords(result.image, 'ktext')
        : courseInstructionImageWordsWithOrdinaryHalt(result.image, profile as CourseProfile);
      await ensureDirectory(vscode.Uri.file(path.dirname(outputFile.fsPath)));
      await writeTextFile(outputFile, wordsToHexText(words));
    }

    const assembler = result.descriptor.id === BUILTIN_TS_ENGINE_ID ? '内置汇编器' : 'MARS';
    vscode.window.showInformationMessage(`${assembler} 已导出 ${outputFile.fsPath}`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    services.output.appendLine(`ASM 导出失败：${detail}`);
    vscode.window.showErrorMessage('ASM 导出失败，请查看插件输出面板');
    return false;
  }
}

function assemblyDumpOutput(sourceUri: vscode.Uri, target: AssemblyDumpTarget): vscode.Uri {
  if (target === 'kernelText') {
    return vscode.Uri.file(path.join(
      path.dirname(sourceUri.fsPath),
      `${path.basename(sourceUri.fsPath, path.extname(sourceUri.fsPath))}.kernel.txt`
    ));
  }
  const configured = getMachineCode(sourceUri);
  return vscode.Uri.file(path.isAbsolute(configured)
    ? configured
    : path.join(path.dirname(sourceUri.fsPath), configured));
}
