// @index mips-commands — MARS运行/dump/终端/P7内核段合并
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  getJava,
  getMachineCode,
  getMarsJar,
  getMemoryConfiguration,
  getProfile,
  ensureConcreteProfile
} from './config';
import { basenameNoExt, cleanupCoTmp, coTmpDir, dirname, ensureDirectory, isFile, readTextFile, workspaceFolderFor, writeTextFile } from './fsUtil';
import { commandLine, revealOutputChannel, runTool } from './process';
import { appendHaltLoop, courseTraceHaltLoopError, courseTraceHaltPc, MIPS_NOP_HEX, MIPS_SELF_BRANCH_HEX } from './courseTesting/mipsUtil';
import { courseDataDumpChunks, courseDataInitializationError } from './courseTesting/courseDataInitialization';
import { p7ExceptionHandlerAddress, p7KernelTextDumpEndAddress, p7UserTextBaseAddress } from './courseTesting/p7Hardware';
import { AppServices, ProjectProfile, RunResult } from './types';
import { pickOneFile } from './workflowInputs';
import { sanitizeFileStem } from './pathUtils';
import {
  buildMarsArgs,
  isCourseTraceMarsRun,
  isLargeTextMemoryConfiguration,
  p7InternalUnknownInstructionClassPath,
  p7RiInstructionNeeded,
  P7_COURSE_MEMORY_CONFIG
} from './language/mips/marsArgs';
import { Commands, CO_OUT_DIR, CPU_HALT_PROFILES } from './constants';
import type { EngineArtifactIdentity } from './mips/providers/contracts';

// Re-export for testability
export { buildMarsArgs } from './language/mips/marsArgs';

export type MarsRunMode = 'run' | 'dumpText' | 'dumpKernel';

export interface MarsRunOptions {
  showMessages?: boolean;
  revealOutput?: boolean;
  stdin?: string;
  stdinSource?: vscode.Uri;
  courseTrace?: boolean;
  traceOutput?: boolean;
  traceLevel?: 1 | 2;
  dumpOutputFile?: vscode.Uri;
  runOutputFile?: vscode.Uri;
  interruptSchedule?: number[];
  p7RiInstruction?: boolean;
  maxSteps?: number;
  haltPc?: number;
  /** Cancels every external MARS process started for this logical run. */
  signal?: AbortSignal;
}

export interface MarsRunOutput {
  result: RunResult;
  outputFile?: vscode.Uri;
  /** Halt PC derived from the pre-merge user-text dump. */
  courseHaltPc?: number;
  /** Exact primary JAR identity verified before and after this run. */
  engineArtifact?: EngineArtifactIdentity;
}

export function registerMips(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.Mips.DisablePseudoWarnings, async () => {
      await vscode.workspace.getConfiguration('co').update('mips.warnPseudoInstruction', false, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage('已在当前工作区中禁用 MIPS 伪指令警告');
    }),
    vscode.commands.registerCommand(Commands.Mips.RunCurrentFile, () => runMarsCurrentFile(services, 'run')),
    vscode.commands.registerCommand(Commands.Mips.RunAndCapture, () => runMarsCurrentFile(services, 'run')),
    vscode.commands.registerCommand(Commands.Mips.RunWithStdinFile, () => runMarsCurrentFileWithStdinFile(services)),
    vscode.commands.registerCommand(Commands.Mips.RunInTerminal, () => runMarsCurrentFileInTerminal()),
    vscode.commands.registerCommand(Commands.Mips.DumpText, () => runMarsCurrentFile(services, 'dumpText')),
    vscode.commands.registerCommand(Commands.Mips.DumpKernelText, () => runMarsCurrentFile(services, 'dumpKernel'))
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
  if (!await ensureConcreteProfile(document.uri, '运行 MARS 需要先确定项目 Profile')) { return; }

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
  if (!await ensureConcreteProfile(asmUri, '运行 MARS 需要先确定项目 Profile')) {
    return undefined;
  }
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
  let engineArtifact: EngineArtifactIdentity;
  try {
    engineArtifact = await fingerprintMarsArtifact(mars);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `无法读取已配置的 MARS artifact，运行已终止：${detail}`;
    services.output.appendLine(message);
    if (showMessages) {
      vscode.window.showErrorMessage(message);
    }
    return {
      result: localMarsRunFailure(java, ['-jar', mars], cwd, message)
    };
  }
  const memoryConfiguration = getMemoryConfiguration(asmUri);
  const p7RiInstruction = options.p7RiInstruction ?? await p7RiInstructionNeeded(asmUri);
  const effectiveOptions: MarsRunOptions = { ...options, p7RiInstruction };
  const args = buildMarsArgs(asmUri, mars, mode, effectiveOptions, memoryConfiguration);

  let outputFile: vscode.Uri | undefined;
  if (mode === 'dumpText') {
    outputFile = options.dumpOutputFile ?? vscode.Uri.file(path.join(cwd, getMachineCode(asmUri)));
    await ensureDirectory(vscode.Uri.file(path.dirname(outputFile.fsPath)));
    const textRange = isCourseTraceMarsRun(mode, effectiveOptions)
      ? courseUserTextDumpRange(getProfile(asmUri))
      : '.text';
    args.push('a', 'dump', textRange, 'HexText', outputFile.fsPath);
  } else if (mode === 'dumpKernel') {
    outputFile = options.dumpOutputFile ?? vscode.Uri.file(path.join(cwd, `${basenameNoExt(asmUri)}.kernel.txt`));
    await ensureDirectory(vscode.Uri.file(path.dirname(outputFile.fsPath)));
    args.push('a', 'dump', p7KernelTextDumpRange(), 'HexText', outputFile.fsPath);
  }

  const setupError = await marsRunSetupError(asmUri, mode, effectiveOptions, memoryConfiguration);
  if (setupError) {
    services.output.appendLine(setupError);
    const result = localMarsRunFailure(java, args, cwd, setupError);
    if (showMessages) {
      vscode.window.showErrorMessage(setupError);
    }
    return { result, outputFile, engineArtifact };
  }

  let result: RunResult;
  let validatedCourseHaltPc: number | undefined;
  let courseDataDump: CourseDataDumpFiles | undefined;
  const requiresCourseDataPreflight = mode === 'dumpText' && isCourseTraceMarsRun(mode, effectiveOptions);
  try {
    if (requiresCourseDataPreflight) {
      courseDataDump = await prepareCourseDataDumpFiles(asmUri, args);
    }
    if (mode === 'dumpText' || mode === 'dumpKernel') {
      args.push(asmUri.fsPath);
    }
    result = await runTool(java, args, {
      cwd,
      output: services.output,
      resource: asmUri,
      stdin: options.stdin,
      signal: options.signal
    });
    result = withMarsCompatibilityDiagnostics(result, services, mode, effectiveOptions, memoryConfiguration);
    if (result.ok && courseDataDump) {
      const dumpError = await validateCourseDataDumpFiles(courseDataDump, result);
      if (dumpError) {
        services.output.appendLine(dumpError);
        result = localMarsRunFailureFrom(result, dumpError);
      }
    }
  } catch (error) {
    if (!requiresCourseDataPreflight) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const message = `课程 DM 初始化 dump 预检失败：${detail}。无法安全确认 MARS 与 P3–P7 硬件的全零 DM 初态一致，已终止课程 Trace。`;
    services.output.appendLine(message);
    result = localMarsRunFailure(java, args, cwd, message);
  } finally {
    if (courseDataDump) {
      await cleanupCoTmp(courseDataDump.tempDirPath);
    }
  }

  if (mode === 'dumpText' && result.ok && outputFile) {
    if (isCourseTraceMarsRun(mode, effectiveOptions)) {
      const userTextDump = await readTextFile(outputFile);
      const haltError = courseTraceHaltLoopError(userTextDump);
      if (haltError) {
        services.output.appendLine(haltError);
        result = localMarsRunFailureFrom(result, haltError);
      } else {
        validatedCourseHaltPc = courseTraceHaltPc(userTextDump);
      }
    }
    if (result.ok && getProfile(asmUri) === 'P7') {
      result = await mergeP7KernelTextDump(services, asmUri, java, mars, cwd, outputFile, result, effectiveOptions);
    } else if (result.ok && cpuHaltProfiles.has(getProfile(asmUri))) {
      await appendHaltLoopToTextDump(outputFile, services);
    }
  }

  const artifactDriftError = await marsArtifactDriftError(mars, engineArtifact.sha256);
  if (artifactDriftError) {
    services.output.appendLine(artifactDriftError);
    result = localMarsRunFailureFrom(result, artifactDriftError);
  }

  if (mode === 'run') {
    outputFile = options.runOutputFile;
    if (!outputFile) {
      const outDir = marsRunOutputDirectory(asmUri);
      await ensureDirectory(outDir);
      outputFile = vscode.Uri.file(path.join(outDir.fsPath, marsOutputFileName(asmUri, options.stdinSource)));
    } else {
      await ensureDirectory(vscode.Uri.file(path.dirname(outputFile.fsPath)));
    }
    await writeTextFile(outputFile, result.stdout);
  }

  if (!showMessages) {
    return { result, outputFile, courseHaltPc: validatedCourseHaltPc, engineArtifact };
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

  return { result, outputFile, courseHaltPc: validatedCourseHaltPc, engineArtifact };
}

async function fingerprintMarsArtifact(file: string): Promise<EngineArtifactIdentity> {
  const bytes = await fs.promises.readFile(file);
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    role: 'user-configured-mars',
    fileName: path.basename(file)
  };
}

async function marsArtifactDriftError(file: string, expectedSha256: string): Promise<string | undefined> {
  try {
    const current = await fingerprintMarsArtifact(file);
    return current.sha256 === expectedSha256
      ? undefined
      : `MARS artifact 在运行期间发生变化（期望 SHA-256 ${expectedSha256}，实际 ${current.sha256}），本次结果已拒绝。`;
  } catch (error) {
    return `MARS artifact 在运行结束前变得不可用，本次结果已拒绝：${error instanceof Error ? error.message : String(error)}`;
  }
}

interface CourseDataDumpFiles {
  tempDirPath: string;
  files: vscode.Uri[];
}

async function prepareCourseDataDumpFiles(asmUri: vscode.Uri, args: string[]): Promise<CourseDataDumpFiles> {
  const tempDirPath = coTmpDir(asmUri, 'co-mars-dm-init-');
  try {
    const files = courseDataDumpChunks.map((chunk) => vscode.Uri.file(path.join(
      tempDirPath,
      `${basenameNoExt(asmUri)}.dm-${chunk.index}.txt`
    )));
    // MARS does not create a file for an entirely unallocated 4 KiB data block. Pre-creating an
    // empty file makes that legitimate all-zero state distinguishable from a missing path/read
    // failure, both of which are handled explicitly below.
    for (const file of files) {
      await writeTextFile(file, '');
    }
    for (const chunk of courseDataDumpChunks) {
      args.push('dump', chunk.marsRange, 'HexText', files[chunk.index].fsPath);
    }
    return { tempDirPath, files };
  } catch (error) {
    await cleanupCoTmp(tempDirPath);
    throw error;
  }
}

async function validateCourseDataDumpFiles(
  dump: CourseDataDumpFiles,
  marsResult: RunResult
): Promise<string | undefined> {
  const dumpDiagnostic = `${marsResult.stdout}\n${marsResult.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /Error while attempting to save dump|segment\/address-range .* is invalid|dump, format .* was not found/i.test(line));
  if (dumpDiagnostic) {
    return `课程 DM 初始化 dump 失败：MARS 报告“${dumpDiagnostic}”。无法安全确认 MARS 与 P3–P7 硬件的全零 DM 初态一致，已终止课程 Trace。`;
  }
  const texts: string[] = [];
  for (const file of dump.files) {
    texts.push(await readTextFile(file));
  }
  return courseDataInitializationError(texts);
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

function localMarsRunFailureFrom(previous: RunResult, message: string): RunResult {
  return {
    ...previous,
    ok: false,
    exitCode: null,
    stderr: previous.stderr ? `${previous.stderr}\n${message}` : message,
    timedOut: false
  };
}

async function marsRunSetupError(
  asmUri: vscode.Uri,
  mode: MarsRunMode,
  options: MarsRunOptions,
  memoryConfiguration: string
): Promise<string | undefined> {
  if (mode === 'run' && isCourseTraceMarsRun(mode, options)) {
    if (!Number.isSafeInteger(options.maxSteps) || (options.maxSteps ?? 0) <= 0) {
      return '课程 MARS 黄金模型必须设置正整数 maxSteps，作为未到达标准停机尾时的有限执行预算。';
    }
    if (!Number.isSafeInteger(options.haltPc) || (options.haltPc ?? -1) < 0) {
      return '课程 MARS 黄金模型缺少由最终用户 .text dump 验证得到的 haltPc，无法区分标准停机尾与跳出程序/错误自环。';
    }
  }
  const profile = getProfile(asmUri);
  if (profile === 'P7') {
    if (options.p7RiInstruction && !await isFile(p7InternalUnknownInstructionClassPath())) {
      return `P7 RI 异常测试需要内部 MARS 额外指令 class，但文件不存在: ${p7InternalUnknownInstructionClassPath()}`;
    }
    if ((mode === 'dumpText' || mode === 'dumpKernel' || isCourseTraceMarsRun(mode, options)) && memoryConfiguration !== P7_COURSE_MEMORY_CONFIG) {
      return `P7 机器码 dump 必须使用 MARS 内存配置 ${P7_COURSE_MEMORY_CONFIG}。${memoryConfiguration} 会改变异常入口或让程序顺序落入 0x${p7ExceptionHandlerAddress.toString(16)} 处理程序，不适配课程 CPU。`;
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
  if (options.traceOutput && /Invalid Command Argument:\s*coL[12]/i.test(output)) {
    return '当前 MARS 不支持 coL1/coL2 trace 参数。课程自动对拍需要 Toby-Shi-cloud/Mars-with-BUAA-CO-extension 修改版 Mars，请检查 co.toolchain.mars / co.toolchain.marsP7。';
  }
  if (isCourseTraceMarsRun(mode, options) && /Invalid Command Argument:\s*(efc|p7irq)/i.test(output)) {
    return '当前 MARS 不支持 efc / p7irq（P7 异常与外部中断）参数。P7 自动对拍需要含该功能的修改版 Mars 构建，请重新构建并配置 co.toolchain.marsP7。';
  }
  if (options.p7RiInstruction && /Invalid Command Argument:\s*cl/i.test(output)) {
    return '当前 MARS 不支持 cl 额外指令加载，无法生成/运行 P7 RI 异常测试。请使用支持 cl 的修改版 Mars，或从 co.test.p7.exceptionTypes 中移除 RI。';
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
  previousResult: RunResult,
  options: MarsRunOptions
): Promise<RunResult> {
  const tempDirPath = coTmpDir(asmUri, 'co-p7-ktext-');
  const tempDir = vscode.Uri.file(tempDirPath);
  const kernelOutputFile = vscode.Uri.file(path.join(tempDir.fsPath, `${basenameNoExt(asmUri)}.kernel-merge.txt`));
  const args = buildMarsArgs(asmUri, mars, 'dumpKernel', options, P7_COURSE_MEMORY_CONFIG);
  args.push('a', 'dump', p7KernelTextDumpRange(), 'HexText', kernelOutputFile.fsPath, asmUri.fsPath);

  let kernelResult: RunResult;
  try {
    kernelResult = await runTool(java, args, {
      cwd,
      output: services.output,
      resource: asmUri,
      signal: options.signal
    });
  } catch (error) {
    await cleanupCoTmp(tempDirPath);
    throw error;
  }
  if (!kernelResult.ok) {
    await cleanupCoTmp(tempDirPath);
    return kernelResult;
  }

  try {
    const kernelOutput = `${kernelResult.stdout}\n${kernelResult.stderr}`;
    const dumpDiagnostic = kernelOutput.split(/\r?\n/).map((line) => line.trim()).find((line) =>
      /Error while attempting to save dump|segment\/address-range .* is invalid|dump, format .* was not found/i.test(line));
    if (dumpDiagnostic) {
      const message = `P7 内核机器码导出失败：MARS 报告“${dumpDiagnostic}”。不能以缺失异常处理程序的 code.txt 继续测试。`;
      services.output.appendLine(message);
      return localMarsRunFailureFrom(kernelResult, message);
    }
    const explicitlyEmpty = /This segment has not been written to, there is nothing to dump\./i.test(kernelOutput);
    if (!await workspaceFileExists(kernelOutputFile)) {
      if (explicitlyEmpty) {
        return previousResult;
      }
      const message = 'P7 内核机器码导出失败：MARS 未生成 kernel HexText，也未明确报告内核文本段为空。';
      services.output.appendLine(message);
      return localMarsRunFailureFrom(kernelResult, message);
    }
    let kernelText: string;
    try {
      kernelText = await readTextFile(kernelOutputFile);
    } catch (error) {
      const message = `P7 内核机器码导出失败：无法读取 kernel HexText（${error instanceof Error ? error.message : String(error)}）。`;
      services.output.appendLine(message);
      return localMarsRunFailureFrom(kernelResult, message);
    }
    const invalidKernelLine = kernelText.split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !/^[0-9a-fA-F]{8}$/.test(line));
    if (invalidKernelLine) {
      const message = `P7 内核机器码导出失败：kernel HexText 包含非法行 ${JSON.stringify(invalidKernelLine)}。`;
      services.output.appendLine(message);
      return localMarsRunFailureFrom(kernelResult, message);
    }
    const textLines = machineCodeLines(await readTextFile(textOutputFile));
    const kernelLines = machineCodeLines(kernelText);
    if (!kernelLines.length) {
      if (explicitlyEmpty) {
        return previousResult;
      }
      const message = 'P7 内核机器码导出失败：kernel HexText 为空，但 MARS 未明确报告内核文本段未写入。';
      services.output.appendLine(message);
      return localMarsRunFailureFrom(kernelResult, message);
    }

    // Course-trace sources were already required to carry the tutorial-mandated halt loop, so
    // MARS and hardware execute the same user text. Ordinary dumps retain the legacy append.
    const terminatedTextLines = textLines.length
      ? machineCodeLines(appendHaltLoop(`${textLines.join('\n')}\n`))
      : [MIPS_SELF_BRANCH_HEX, MIPS_NOP_HEX];
    if (terminatedTextLines.length > p7KernelTextStartIndex) {
      const message = `P7 机器码导出失败：用户文本段及停机自环共有 ${terminatedTextLines.length} 条指令，已覆盖 0x${p7ExceptionHandlerAddress.toString(16)} 异常入口。`;
      services.output.appendLine(message);
      return {
        ...previousResult,
        ok: false,
        exitCode: null,
        stderr: previousResult.stderr ? `${previousResult.stderr}\n${message}` : message,
        timedOut: false
      };
    }

    const merged = [...terminatedTextLines];
    while (merged.length < p7KernelTextStartIndex) {
      merged.push(MIPS_NOP_HEX);
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

/**
 * 非 P7 的流水线/CPU Profile（P4/P5/P6）：其 dump 出的 code.txt 会被 ISim CPU 和 hazard 对拍工具执行。
 * 这些工具会在执行完最后一条指令后继续向指令存储器末尾之外取指，触发取指 AdEL。P7 由
 * mergeP7KernelTextDump 自带停机自环，这里覆盖 P4/P5/P6。
 */
const cpuHaltProfiles = CPU_HALT_PROFILES;

/**
 * 给普通（非课程 Trace）dump 出的机器码追加停机自环（与 P7 一致）。课程 Trace 会先要求
 * ASM 自身具备该尾部，禁止只改 code.txt 造成 MARS 与硬件程序不一致。
 */
async function appendHaltLoopToTextDump(outputFile: vscode.Uri, services: AppServices): Promise<void> {
  try {
    const text = await readTextFile(outputFile);
    const terminated = appendHaltLoop(text);
    if (terminated !== text) {
      await writeTextFile(outputFile, terminated);
      services.output.appendLine('已为机器码追加停机自环（防止流水线取指越界，避免 hazard 工具报 AdEL）');
    }
  } catch (error) {
    services.output.appendLine(`追加停机自环失败：${error instanceof Error ? error.message : String(error)}`);
  }
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
  return vscode.Uri.file(path.join(baseDir, CO_OUT_DIR));
}

function marsOutputFileName(asmUri: vscode.Uri, stdinSource?: vscode.Uri): string {
  const asmName = basenameNoExt(asmUri);
  if (!stdinSource) {
    return `${asmName}.mars.out`;
  }
  const inputName = path.basename(stdinSource.fsPath, path.extname(stdinSource.fsPath));
  return `${asmName}.${sanitizeFileStem(inputName, { fallback: 'stdin', trimOuterUnderscores: false })}.mars.out`;
}

const p7KernelTextStartIndex = (p7ExceptionHandlerAddress - p7UserTextBaseAddress) / 4;

function formatMarsDumpAddress(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

export function p7KernelTextDumpRange(): string {
  return `${formatMarsDumpAddress(p7ExceptionHandlerAddress)}-${formatMarsDumpAddress(p7KernelTextDumpEndAddress)}`;
}

/**
 * MARS treats an explicit dump upper bound as exclusive. Keep the P7 user dump below the
 * 0x4180 handler even when user text and kernel text are physically contiguous. Stable MARS
 * v0.6.3 also treats Compact*'s configured 0x6ffc text limit as exclusive, so course dumps end at
 * 0x6ff8 even though the physical course IM has one additional word at 0x6ffc.
 */
export function courseUserTextDumpRange(profile: ProjectProfile): string {
  const endExclusive = profile === 'P7'
    ? p7ExceptionHandlerAddress
    : p7KernelTextDumpEndAddress;
  return `${formatMarsDumpAddress(p7UserTextBaseAddress)}-${formatMarsDumpAddress(endExclusive)}`;
}
