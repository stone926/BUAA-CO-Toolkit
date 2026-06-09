import * as path from 'path';
import * as vscode from 'vscode';
import {
  getJava,
  getMachineCode,
  getMarsJar,
  getMemoryConfiguration,
  getMipsExtraArgs,
  getProfile,
  useDelayedBranching
} from './config';
import { basenameNoExt, cleanupCoTmp, coTmpDir, dirname, ensureDirectory, readTextFile, workspaceFolderFor, writeTextFile } from './fsUtil';
import { commandLine, revealOutputChannel, runTool } from './process';
import { AppServices, RunResult } from './types';
import { pickOneFile } from './workflowInputs';

export type MarsRunMode = 'run' | 'dumpText' | 'dumpKernel';

export interface MarsRunOptions {
  showMessages?: boolean;
  revealOutput?: boolean;
  stdin?: string;
  stdinSource?: vscode.Uri;
  courseTrace?: boolean;
  traceOutput?: boolean;
  dumpOutputFile?: vscode.Uri;
  interruptSchedule?: number[];
}

export interface MarsRunOutput {
  result: RunResult;
  outputFile?: vscode.Uri;
}

export function registerMips(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.mips.disablePseudoWarnings', async () => {
      await vscode.workspace.getConfiguration('co').update('mips.warnPseudoInstruction', false, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage('已在当前工作区中禁用 MIPS 伪指令警告');
    }),
    vscode.commands.registerCommand('co.mips.runCurrentFile', () => runMarsCurrentFile(services, 'run')),
    vscode.commands.registerCommand('co.mips.runAndCapture', () => runMarsCurrentFile(services, 'run')),
    vscode.commands.registerCommand('co.mips.runWithStdinFile', () => runMarsCurrentFileWithStdinFile(services)),
    vscode.commands.registerCommand('co.mips.runInTerminal', () => runMarsCurrentFileInTerminal()),
    vscode.commands.registerCommand('co.mips.dumpText', () => runMarsCurrentFile(services, 'dumpText')),
    vscode.commands.registerCommand('co.mips.dumpKernelText', () => runMarsCurrentFile(services, 'dumpKernel'))
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
    vscode.window.showErrorMessage('运行 MARS 前请先保存 ASM 文件');
    return undefined;
  }
  if (document.isDirty) {
    await document.save();
  }
  return document;
}

async function runMarsCurrentFile(services: AppServices, mode: MarsRunMode): Promise<void> {
  const document = await resolveCurrentMipsDocument();
  if (!document) { return; }

  await runMarsFile(services, document.uri, mode);
}

async function runMarsCurrentFileWithStdinFile(services: AppServices): Promise<void> {
  const document = await resolveCurrentMipsDocument();
  if (!document) { return; }

  const stdinSource = await pickOneFile('选择 MARS 标准输入文本文件', {
    Text: ['txt', 'in', 'input', 'dat'],
    All: ['*']
  });
  if (!stdinSource) {
    return;
  }
  const bytes = await vscode.workspace.fs.readFile(stdinSource);
  await runMarsFile(services, document.uri, 'run', {
    stdin: Buffer.from(bytes).toString('utf8'),
    stdinSource
  });
}

async function runMarsCurrentFileInTerminal(): Promise<void> {
  const document = await resolveCurrentMipsDocument();
  if (!document) { return; }

  const mars = getMarsJar(document.uri);
  if (!mars) {
    vscode.window.showErrorMessage('MARS jar 未配置。请设置 co.toolchain.mars 或 co.toolchain.marsP7');
    return;
  }

  const java = getJava(document.uri);
  const cwd = dirname(document.uri);
  const args = buildMarsArgs(document.uri, mars, 'run');
  const terminal = vscode.window.createTerminal({
    name: `MARS: ${path.basename(document.uri.fsPath)}`,
    cwd
  });
  terminal.show();
  terminal.sendText(commandLine(java, args), true);
}

export async function runMarsFile(
  services: AppServices,
  asmUri: vscode.Uri,
  mode: MarsRunMode,
  options: MarsRunOptions = {}
): Promise<MarsRunOutput | undefined> {
  const showMessages = options.showMessages !== false;
  const mars = getMarsJar(asmUri);
  if (!mars) {
    vscode.window.showErrorMessage('MARS jar 未配置。请设置 co.toolchain.mars 或 co.toolchain.marsP7');
    return undefined;
  }

  if (options.revealOutput !== false) {
    revealOutputChannel(services.output, asmUri);
  }
  const java = getJava(asmUri);
  const cwd = dirname(asmUri);
  const memoryConfiguration = getMemoryConfiguration(asmUri);
  const args = buildMarsArgs(asmUri, mars, mode, options, memoryConfiguration);

  let outputFile: vscode.Uri | undefined;
  if (mode === 'dumpText') {
    outputFile = options.dumpOutputFile ?? vscode.Uri.file(path.join(cwd, getMachineCode(asmUri)));
    await ensureDirectory(vscode.Uri.file(path.dirname(outputFile.fsPath)));
    args.push('a', 'dump', '.text', 'HexText', outputFile.fsPath, asmUri.fsPath);
  } else if (mode === 'dumpKernel') {
    outputFile = options.dumpOutputFile ?? vscode.Uri.file(path.join(cwd, `${basenameNoExt(asmUri)}.kernel.txt`));
    await ensureDirectory(vscode.Uri.file(path.dirname(outputFile.fsPath)));
    args.push('a', 'dump', '0x00004180-0x00004ffc', 'HexText', outputFile.fsPath, asmUri.fsPath);
  }

  const setupError = marsRunSetupError(asmUri, mode, options, memoryConfiguration);
  if (setupError) {
    services.output.appendLine(setupError);
    const result = localMarsRunFailure(java, args, cwd, setupError);
    if (showMessages) {
      vscode.window.showErrorMessage(setupError);
    }
    return { result, outputFile };
  }

  let result = await runTool(java, args, {
    cwd,
    output: services.output,
    resource: asmUri,
    stdin: options.stdin
  });
  result = withMarsCompatibilityDiagnostics(result, services, mode, options, memoryConfiguration);

  if (mode === 'dumpText' && result.ok && outputFile && getProfile(asmUri) === 'P7') {
    result = await mergeP7KernelTextDump(services, asmUri, java, mars, cwd, outputFile, result);
  }

  if (mode === 'run') {
    const outDir = marsRunOutputDirectory(asmUri);
    await ensureDirectory(outDir);
    outputFile = vscode.Uri.file(path.join(outDir.fsPath, marsOutputFileName(asmUri, options.stdinSource)));
    await writeTextFile(outputFile, result.stdout);
  }

  if (!showMessages) {
    return { result, outputFile };
  }

  if (result.ok) {
    if (mode === 'dumpText') {
      vscode.window.showInformationMessage(`MARS 已导出 ${getMachineCode(asmUri)}`);
    } else if (mode === 'dumpKernel') {
      vscode.window.showInformationMessage('MARS 已导出内核文本段');
    } else {
      const input = options.stdinSource ? `，使用标准输入 ${path.basename(options.stdinSource.fsPath)}` : '';
      vscode.window.showInformationMessage(`MARS 运行完成${input}`);
    }
  } else {
    vscode.window.showErrorMessage(`MARS 运行失败${result.exitCode === null ? '' : `，退出码 ${result.exitCode}`}`);
  }

  return { result, outputFile };
}

function localMarsRunFailure(command: string, args: readonly string[], cwd: string, message: string): RunResult {
  return {
    ok: false,
    exitCode: null,
    commandLine: commandLine(command, args),
    cwd,
    stdout: '',
    stderr: message,
    timedOut: false
  };
}

function marsRunSetupError(
  asmUri: vscode.Uri,
  mode: MarsRunMode,
  options: MarsRunOptions,
  memoryConfiguration: string
): string | undefined {
  const profile = getProfile(asmUri);
  if (profile === 'P7') {
    if ((mode === 'dumpText' || mode === 'dumpKernel' || isCourseTraceMarsRun(mode, options)) && memoryConfiguration !== p7CourseMemoryConfiguration) {
      return `P7 机器码 dump 必须使用 MARS 内存配置 ${p7CourseMemoryConfiguration}。${memoryConfiguration} 会改变异常入口或让程序顺序落入 0x4180 处理程序，不适配课程 CPU。`;
    }
    return undefined;
  }
  if (!isCourseTraceMarsRun(mode, options)) {
    return undefined;
  }
  if (!isLargeTextMemoryConfiguration(memoryConfiguration)) {
    return `非 P7 自动化测试应使用 MARS 内存配置 FixedCompactLargeText 或 CompactLargeText，以支持更长的随机机器码。当前配置为 ${memoryConfiguration}。`;
  }
  return undefined;
}

function isCourseTraceMarsRun(mode: MarsRunMode, options: MarsRunOptions): boolean {
  return options.courseTrace === true || options.traceOutput === true;
}

function withMarsCompatibilityDiagnostics(
  result: RunResult,
  services: AppServices,
  mode: MarsRunMode,
  options: MarsRunOptions,
  memoryConfiguration: string
): RunResult {
  const message = marsCompatibilityMessage(result, mode, options, memoryConfiguration);
  if (!message) {
    return result;
  }
  services.output.appendLine(message);
  return {
    ...result,
    ok: false,
    stderr: result.stderr ? `${result.stderr}\n${message}` : message
  };
}

function marsCompatibilityMessage(
  result: RunResult,
  mode: MarsRunMode,
  options: MarsRunOptions,
  memoryConfiguration: string
): string | undefined {
  const output = `${result.stdout}\n${result.stderr}`;
  if (options.traceOutput && /Invalid Command Argument:\s*coL1/i.test(output)) {
    return '当前 MARS 不支持 coL1 trace 参数。课程自动对拍默认需要 Toby-Shi-cloud/Mars-with-BUAA-CO-extension 修改版 Mars，请检查 co.toolchain.mars / co.toolchain.marsP7。';
  }
  if (isCourseTraceMarsRun(mode, options) && /Invalid Command Argument:\s*(efc|p7irq)/i.test(output)) {
    return '当前 MARS 不支持 efc / p7irq（P7 异常与外部中断）参数。P7 自动对拍需要含该功能的修改版 Mars 构建，请重新构建并配置 co.toolchain.marsP7。';
  }
  const memoryMatch = /Invalid memory configuration:\s*([A-Za-z0-9_]+)/i.exec(output);
  if (memoryMatch) {
    const rejected = memoryMatch[1] || memoryConfiguration;
    if (isLargeTextMemoryConfiguration(rejected)) {
      return `当前 MARS 不支持 ${rejected} 内存配置。非 P7 自动化测试默认使用 large text 配置以支持超长机器码，请改用修改版 Mars。`;
    }
    if (mode === 'dumpText' || mode === 'run') {
      return `当前 MARS 不支持 ${rejected} 内存配置，请检查 co.mips.memoryConfiguration 或更换修改版 Mars。`;
    }
  }
  return undefined;
}

async function mergeP7KernelTextDump(
  services: AppServices,
  asmUri: vscode.Uri,
  java: string,
  mars: string,
  cwd: string,
  textOutputFile: vscode.Uri,
  previousResult: RunResult
): Promise<RunResult> {
  const tempDirPath = coTmpDir(asmUri, 'co-p7-ktext-');
  const tempDir = vscode.Uri.file(tempDirPath);
  const kernelOutputFile = vscode.Uri.file(path.join(tempDir.fsPath, `${basenameNoExt(asmUri)}.kernel-merge.txt`));
  const args = buildMarsArgs(asmUri, mars, 'dumpKernel', {}, p7CourseMemoryConfiguration);
  args.push('a', 'dump', '0x00004180-0x00004ffc', 'HexText', kernelOutputFile.fsPath, asmUri.fsPath);

  const kernelResult = await runTool(java, args, {
    cwd,
    output: services.output,
    resource: asmUri
  });
  if (!kernelResult.ok) {
    return kernelResult;
  }

  try {
    if (!await workspaceFileExists(kernelOutputFile)) {
      return previousResult;
    }
    const textLines = machineCodeLines(await readTextFile(textOutputFile));
    const kernelLines = machineCodeLines(await readTextFile(kernelOutputFile));
    if (!kernelLines.length) {
      return previousResult;
    }

    const maxTextLinesBeforeStopLoop = p7KernelTextStartIndex - 2;
    if (textLines.length > maxTextLinesBeforeStopLoop) {
      const message = `P7 机器码导出失败：用户文本段已有 ${textLines.length} 条指令，无法在 0x${p7KernelTextBaseAddress.toString(16)} 异常入口前插入安全停机自环。`;
      services.output.appendLine(message);
      return {
        ...previousResult,
        ok: false,
        exitCode: null,
        stderr: previousResult.stderr ? `${previousResult.stderr}\n${message}` : message,
        timedOut: false
      };
    }

    const merged = [...textLines, mipsSelfBranchHex, mipsNopHex];
    while (merged.length < p7KernelTextStartIndex) {
      merged.push(mipsNopHex);
    }
    for (let i = 0; i < kernelLines.length; i++) {
      merged[p7KernelTextStartIndex + i] = kernelLines[i];
    }
    await writeTextFile(textOutputFile, `${merged.join('\n')}\n`);
    services.output.appendLine(`已合并 P7 内核文本段到 ${textOutputFile.fsPath}`);
    return previousResult;
  } finally {
    try {
      await vscode.workspace.fs.delete(kernelOutputFile, { useTrash: false });
    } catch {
      // Best-effort cleanup only.
    }
    await cleanupCoTmp(tempDirPath);
  }
}

function machineCodeLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function workspaceFileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function marsRunOutputDirectory(asmUri: vscode.Uri): vscode.Uri {
  const folder = workspaceFolderFor(asmUri);
  const baseDir = folder?.uri.fsPath ?? dirname(asmUri);
  return vscode.Uri.file(path.join(baseDir, '.co', 'out'));
}

function marsOutputFileName(asmUri: vscode.Uri, stdinSource?: vscode.Uri): string {
  const asmName = basenameNoExt(asmUri);
  if (!stdinSource) {
    return `${asmName}.mars.out`;
  }
  const inputName = path.basename(stdinSource.fsPath, path.extname(stdinSource.fsPath));
  return `${asmName}.${sanitizeFileStem(inputName)}.mars.out`;
}

const p7UserTextBaseAddress = 0x3000;
const p7KernelTextBaseAddress = 0x4180;
const p7KernelTextStartIndex = (p7KernelTextBaseAddress - p7UserTextBaseAddress) / 4;
const p7CourseMemoryConfiguration = 'CompactLargeText';
const largeTextMemoryConfigurations = new Set(['FixedCompactLargeText', 'CompactLargeText']);
const mipsNopHex = '00000000';
const mipsSelfBranchHex = '1000ffff';

function buildMarsArgs(
  asmUri: vscode.Uri,
  mars: string,
  mode: MarsRunMode,
  options: MarsRunOptions = {},
  memoryConfiguration = getMemoryConfiguration(asmUri)
): string[] {
  const args = ['-jar', mars, 'nc', 'mc', memoryConfiguration];
  if (useDelayedBranching(asmUri)) {
    args.push('db');
  }
  args.push(...getMipsExtraArgs(asmUri));
  if (mode === 'run' && options.traceOutput && !hasMarsArg(args, 'coL1')) {
    args.push('coL1');
  }
  if (mode === 'run' && getProfile(asmUri) === 'P7' && isCourseTraceMarsRun(mode, options)) {
    // efc = enable P7 exception/interrupt handling (dispatch to 0x4180, BUAA CP0 semantics).
    if (!hasMarsArg(args, 'efc')) {
      args.push('efc');
    }
    // p7irq = inject the external interrupt so MARS defers the same instruction the CPU does.
    // The schedule holds the testbench target_pc (the instruction the CPU defers, sampled at its
    // M-stage macroscopic_pc). MARS's prevIRQ injection commits the p7irq instruction and defers
    // the next one, so fire one slot earlier (target - 4); the generator guarantees target - 4 is
    // an executed simple instruction.
    const schedule = (options.interruptSchedule ?? []).filter((pc) => Number.isFinite(pc) && pc > 0);
    if (schedule.length && !args.some((arg) => arg.toLowerCase().startsWith('p7irq='))) {
      args.push(`p7irq=${schedule.map((pc) => `0x${((pc - 4) >>> 0).toString(16)}`).join(',')}`);
    }
  }
  if (mode === 'run') {
    args.push(asmUri.fsPath);
  }
  return args;
}

function hasMarsArg(args: readonly string[], value: string): boolean {
  return args.some((arg) => arg.toLowerCase() === value.toLowerCase());
}

function isLargeTextMemoryConfiguration(value: string): boolean {
  return largeTextMemoryConfigurations.has(value);
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_') || 'stdin';
}
