// @index mips-runner — 内部 MARS 命令：运行、标准输入、交互终端与兼容导出
import * as path from 'path';
import * as vscode from 'vscode';
import { getMachineCode, getMemoryConfiguration, getRunTimeout, shouldRevealOutput, useDelayedBranching } from './config';
import { basenameNoExt, dirname, workspaceFolderFor } from './fsUtil';
import { revealOutputChannel } from './process';
import { AppServices, ProjectProfile, RunResult } from './types';
import { sanitizeFileStem } from './pathUtils';
import { Commands, CO_OUT_DIR } from './constants';
import { disableMipsPseudoWarnings } from './diagnosticSettings';
import { pickOneFile } from './workflowInputs';
import { runInternalMars } from './mips/host/marsService';
import { MarsTerminal } from './mips/host/marsTerminal';
import type { MarsConsole } from './mips/host/marsIo';
import type { MarsMemoryConfiguration } from './mips/core/profiles/marsMemoryLayout';
import { imageSegmentWords, wordsToHexText } from './mips/core/assembler/artifacts';
import { writeFileAtomicReplace } from './mips/replay/atomicFile';
import { readBoundedRegularFile } from './mips/replay/boundedFile';
import type { EngineArtifactIdentity, ResolvedEngineRun } from './mips/providers/contracts';

export { buildMarsArgs } from './language/mips/marsArgs';
export type MarsRunMode = 'run' | 'dumpText' | 'dumpKernel';
export interface MarsRunOptions {
  showMessages?: boolean; revealOutput?: boolean; nonInteractive?: boolean;
  stdin?: string | Uint8Array; stdinSource?: vscode.Uri; dumpOutputFile?: vscode.Uri; runOutputFile?: vscode.Uri;
  signal?: AbortSignal; maxSteps?: number; console?: MarsConsole;
  // Archive adapter fields: rejected rather than reinterpreted as console execution.
  courseTrace?: boolean; traceOutput?: boolean; traceLevel?: 1 | 2;
  interruptSchedule?: number[]; p7RiInstruction?: boolean; p7InstructionClassDir?: string; haltPc?: number;
  resolvedLaunch?: unknown;
}
export interface MarsRunOutput {
  result: RunResult; outputFile?: vscode.Uri; courseHaltPc?: number;
  engineArtifact?: EngineArtifactIdentity; resolvedRun?: ResolvedEngineRun;
}

export function registerMips(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.Mips.DisablePseudoWarnings, disableMipsPseudoWarnings),
    vscode.commands.registerCommand(Commands.Mips.RunCurrentFile, () => runCurrent(services, false)),
    vscode.commands.registerCommand(Commands.Mips.RunWithStdinFile, () => runCurrent(services, true)),
    vscode.commands.registerCommand(Commands.Mips.RunInTerminal, () => runTerminal(services))
  );
}

async function currentDocument(): Promise<vscode.TextDocument | undefined> {
  const document = vscode.window.activeTextEditor?.document;
  if (!document || document.languageId !== 'mipsasm') { vscode.window.showErrorMessage('请先打开一个 MIPS 汇编文件'); return; }
  if (document.isUntitled) { vscode.window.showErrorMessage('运行 MARS 前请先保存 ASM 文件'); return; }
  if (document.isDirty && !await document.save()) return;
  return document;
}

async function runCurrent(services: AppServices, withInput: boolean): Promise<void> {
  const document = await currentDocument();
  if (!document) return;
  const options: MarsRunOptions = {};
  if (withInput) {
    const input = await pickOneFile('选择 MARS 标准输入文本文件', { Text: ['txt', 'in', 'input', 'dat'], All: ['*'] });
    if (!input) return;
    try {
      options.stdin = await readBoundedRegularFile(input.fsPath, { maximumBytes: 8 * 1024 * 1024, label: 'MARS stdin' });
      options.stdinSource = input;
    } catch (error) { vscode.window.showErrorMessage(`读取标准输入失败：${String(error)}`); return; }
  }
  await runMarsFile(services, document.uri, 'run', options);
}

async function runTerminal(services: AppServices): Promise<void> {
  const document = await currentDocument();
  if (!document) return;
  const pty = new MarsTerminal(async (console, signal) => {
    const output = await runMarsFile(services, document.uri, 'run', { console, signal, showMessages: false, revealOutput: false });
    return output!.result;
  });
  const terminal = vscode.window.createTerminal({ name: `MARS: ${path.basename(document.uri.fsPath)}`, pty });
  terminal.show();
}

/** Compatibility command API backed solely by the internal MARS Worker. */
export async function runMarsFile(services: AppServices, asmUri: vscode.Uri, mode: MarsRunMode,
  options: MarsRunOptions = {}): Promise<MarsRunOutput | undefined> {
  const messages = options.showMessages !== false && !options.nonInteractive;
  const invalid = options.courseTrace || options.traceOutput || options.interruptSchedule?.length || options.p7RiInstruction
    || options.p7InstructionClassDir || options.resolvedLaunch;
  if (invalid) {
    const stderr = '普通 MARS 控制台不接受课程 CPU Trace/中断或外部启动参数；P7 syscall 异常必须使用内置课程执行器';
    if (messages) vscode.window.showErrorMessage(stderr);
    return { result: { ok: false, exitCode: null, commandLine: 'internal-mars', cwd: dirname(asmUri), stdout: '', stderr, timedOut: false } };
  }
  if (!options.nonInteractive && (options.revealOutput ?? shouldRevealOutput(asmUri))) revealOutputChannel(services.output, asmUri);
  const output = await runInternalMars({
    sourcePath: asmUri.fsPath, allowedRoot: workspaceFolderFor(asmUri)?.uri.fsPath ?? dirname(asmUri),
    memoryConfiguration: getMemoryConfiguration(asmUri) as MarsMemoryConfiguration,
    delayedBranching: useDelayedBranching(asmUri), timeoutMs: getRunTimeout(asmUri),
    maxSteps: options.maxSteps, stdin: options.stdin, signal: options.signal, runtime: services.mipsRuntime, console: options.console
  }, mode === 'run');
  let outputFile: vscode.Uri | undefined;
  try {
    if (mode === 'run') {
      outputFile = options.runOutputFile ?? vscode.Uri.file(path.join(marsRunOutputDirectory(asmUri).fsPath, marsOutputFileName(asmUri, options.stdinSource)));
      await writeFileAtomicReplace(outputFile.fsPath, Buffer.from(output.result.stdout, 'utf8'));
    } else if (output.result.ok && output.image) {
      outputFile = options.dumpOutputFile ?? vscode.Uri.file(path.resolve(dirname(asmUri), mode === 'dumpKernel'
        ? `${basenameNoExt(asmUri)}.kernel.txt` : getMachineCode(asmUri)));
      await writeFileAtomicReplace(outputFile.fsPath, Buffer.from(wordsToHexText(imageSegmentWords(output.image, mode === 'dumpKernel' ? 'ktext' : 'text'))));
    }
  } catch (error) { output.result.ok = false; output.result.stderr = `保存 MARS 产物失败：${String(error)}`; }
  if (!options.nonInteractive && !options.console) {
    if (output.result.stdout) services.output.appendLine(output.result.stdout);
    if (output.result.stderr) services.output.appendLine(output.result.stderr);
  }
  if (messages) {
    if (output.result.ok) vscode.window.showInformationMessage(mode === 'run' ? '内置 MARS 运行完成' : '内置 MARS 已导出机器码');
    else vscode.window.showErrorMessage(`内置 MARS ${mode === 'run' ? '运行' : '导出'}失败：${output.result.stderr}`);
  }
  return { result: output.result, outputFile };
}

export function marsRunOutputDirectory(asmUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.file(path.join(workspaceFolderFor(asmUri)?.uri.fsPath ?? dirname(asmUri), CO_OUT_DIR));
}
export function marsOutputFileName(asmUri: vscode.Uri, stdinSource?: vscode.Uri): string {
  const stem = basenameNoExt(asmUri);
  return stdinSource ? `${stem}.${sanitizeFileStem(basenameNoExt(stdinSource), { fallback: 'stdin', trimOuterUnderscores: false })}.mars.out` : `${stem}.mars.out`;
}
/** Historical archive range strings, never passed to an external process. */
export function p7KernelTextDumpRange(): string { return '0x00004180-0x00005000'; }
export function courseUserTextDumpRange(profile: ProjectProfile): string { return profile === 'P7' ? '0x00003000-0x00004180' : '0x00003000-0x00005000'; }
