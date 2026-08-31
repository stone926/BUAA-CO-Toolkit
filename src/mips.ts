// @index mips-legacy-runner — MARS 运行、兼容 dump 与 P7 内核段合并
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import {
  getJava,
  getMachineCode,
  getMarsJar,
  ensureConcreteProfile
} from './config';
import { basenameNoExt, cleanupCoTmp, coTmpDir, dirname, ensureDirectory, workspaceFolderFor, writeTextFile } from './fsUtil';
import { commandLine, revealOutputChannel, runTool } from './process';
import { appendHaltLoop, courseTraceHaltLoopError, courseTraceHaltPc, MIPS_NOP_HEX, MIPS_SELF_BRANCH_HEX } from './courseTesting/mipsUtil';
import {
  courseDataDumpChunks,
  courseDataInitializationError,
  marsDumpExplicitlyEmpty,
  marsDumpFailureDiagnostic
} from './courseTesting/courseDataInitialization';
import { p7ExceptionHandlerAddress, p7KernelTextDumpEndAddress, p7UserTextBaseAddress } from './courseTesting/p7Hardware';
import { AppServices, ProjectProfile, RunResult } from './types';
import { sanitizeFileStem } from './pathUtils';
import {
  buildMarsArgs,
  isCourseTraceMarsRun,
  p7InternalUnknownInstructionClassPath,
  P7_COURSE_MEMORY_CONFIG
} from './language/mips/marsArgs';
import { Commands, CO_OUT_DIR, CPU_HALT_PROFILES } from './constants';
import type { EngineArtifactIdentity } from './mips/providers/contracts';
import {
  ImmutableEngineArtifactRegistry,
  workspaceEngineRegistryRoot
} from './mips/replay/engineRegistry';
import {
  launchResolutionMessage,
  resolveLegacyMarsLaunch,
  type ResolvedLegacyMarsLaunch
} from './mips/providers/legacyMarsLaunch';
import type { ResolvedEngineRun } from './mips/providers/contracts';
import { legacyMarsCompatibilityDiagnostic } from './language/mips/legacyMarsDiagnostics';
import {
  maximumReplayMachineCodeBytes,
  maximumReplayTraceBytes,
  readBoundedRegularFile
} from './mips/replay/boundedFile';
import { disableMipsPseudoWarnings } from './diagnosticSettings';
import { pickOneFile } from './workflowInputs';

// Re-export for testability
export { buildMarsArgs } from './language/mips/marsArgs';

export type MarsRunMode = 'run' | 'dumpText' | 'dumpKernel';

export interface MarsRunOptions {
  showMessages?: boolean;
  revealOutput?: boolean;
  /**
   * Internal automatic-test lane: preserve the MARS result while suppressing prompts and
   * command/cwd/raw-stream or artifact-path chatter in the user-facing output channel.
   */
  nonInteractive?: boolean;
  stdin?: string;
  stdinSource?: vscode.Uri;
  courseTrace?: boolean;
  traceOutput?: boolean;
  traceLevel?: 1 | 2;
  dumpOutputFile?: vscode.Uri;
  runOutputFile?: vscode.Uri;
  interruptSchedule?: number[];
  p7RiInstruction?: boolean;
  /** Internal immutable runtime companion override; never exposed as a user launch option. */
  p7InstructionClassDir?: string;
  maxSteps?: number;
  haltPc?: number;
  /** Cancels every external MARS process started for this logical run. */
  signal?: AbortSignal;
  /** Internal, side-effect-free preflight snapshot supplied by LegacyMarsProvider. */
  resolvedLaunch?: ResolvedLegacyMarsLaunch;
}

export interface MarsRunOutput {
  result: RunResult;
  outputFile?: vscode.Uri;
  /** Halt PC derived from the pre-merge user-text dump. */
  courseHaltPc?: number;
  /** Exact primary JAR identity verified before and after this run. */
  engineArtifact?: EngineArtifactIdentity;
  /** Exact runtime/config values resolved before this run produced side effects. */
  resolvedRun?: ResolvedEngineRun;
}

/** Register only the commands whose console/interactive semantics require MARS. */
export function registerMips(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.Mips.DisablePseudoWarnings, disableMipsPseudoWarnings),
    vscode.commands.registerCommand(Commands.Mips.RunCurrentFile, () => runMarsCurrentFile(services)),
    vscode.commands.registerCommand(Commands.Mips.RunAndCapture, () => runMarsCurrentFile(services)),
    vscode.commands.registerCommand(Commands.Mips.RunWithStdinFile, () => runMarsCurrentFileWithStdinFile(services)),
    vscode.commands.registerCommand(Commands.Mips.RunInTerminal, () => runMarsCurrentFileInTerminal())
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

async function runMarsCurrentFile(services: AppServices): Promise<void> {
  const document = await resolveCurrentMipsDocument();
  if (!document) return;
  await runMarsFile(services, document.uri, 'run');
}

async function runMarsCurrentFileWithStdinFile(services: AppServices): Promise<void> {
  const document = await resolveCurrentMipsDocument();
  if (!document) return;

  const stdinSource = await pickOneFile('选择 MARS 标准输入文本文件', {
    Text: ['txt', 'in', 'input', 'dat'],
    All: ['*']
  });
  if (!stdinSource) return;

  const bytes = await vscode.workspace.fs.readFile(stdinSource);
  await runMarsFile(services, document.uri, 'run', {
    stdin: Buffer.from(bytes).toString('utf8'),
    stdinSource
  });
}

async function runMarsCurrentFileInTerminal(): Promise<void> {
  const document = await resolveCurrentMipsDocument();
  if (!document) return;
  if (!await ensureConcreteProfile(document.uri, '运行 MARS 需要先确定项目 Profile')) return;

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
  const showMessages = options.showMessages !== false && !options.nonInteractive;
  if (!options.resolvedLaunch
    && !await ensureConcreteProfile(asmUri, '运行 MARS 需要先确定项目 Profile')) {
    return undefined;
  }
  const launchResolution = options.resolvedLaunch
    ? { diagnostics: [], launch: options.resolvedLaunch }
    : await resolveLegacyMarsLaunch(asmUri, mode, options);
  const launch = launchResolution.launch;
  if (!launch
    || launch.mode !== mode
    || path.resolve(launch.sourcePath) !== path.resolve(asmUri.fsPath)) {
    const detail = launch
      ? 'legacy MARS preflight snapshot 与当前 source/mode 不匹配'
      : launchResolutionMessage(launchResolution);
    const message = detail || 'legacy MARS preflight 未能解析 launch snapshot';
    appendMarsRunMessage(services, options, message);
    if (showMessages) vscode.window.showErrorMessage(message);
    return {
      result: localMarsRunFailure('java', [], dirname(asmUri), message)
    };
  }
  const resolvedRun: ResolvedEngineRun = {
    profile: launch.profile,
    memoryConfiguration: launch.memoryConfiguration,
    runtime: launch.runtime,
    wallClockMs: launch.wallClockMs,
    p7RiInstruction: launch.p7RiInstruction
  };
  const configuredMars = launch.configuredMars;

  if (!options.nonInteractive && options.revealOutput !== false) {
    revealOutputChannel(services.output, asmUri);
  }
  const java = launch.runtime.command;
  const cwd = dirname(asmUri);
  let engineArtifact: EngineArtifactIdentity;
  let mars: string;
  const workspaceRoot = workspaceFolderFor(asmUri)?.uri.fsPath ?? cwd;
  const registry = new ImmutableEngineArtifactRegistry(
    workspaceEngineRegistryRoot(workspaceRoot),
    workspaceRoot
  );
  try {
    const captured = await registry.registerFile('user-configured-mars', configuredMars, path.basename(configuredMars));
    engineArtifact = { ...captured.identity };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `无法读取已配置的 MARS artifact，运行已终止：${detail}`;
    appendMarsRunMessage(services, options, message);
    if (showMessages) {
      vscode.window.showErrorMessage(message);
    }
    return {
      result: localMarsRunFailure(java, ['-jar', configuredMars], cwd, message),
      resolvedRun
    };
  }
  const memoryConfiguration = launch.memoryConfiguration;
  const p7RiInstruction = launch.p7RiInstruction;
  let p7Dependency: EngineArtifactIdentity | undefined;
  let p7InstructionClassDir: string | undefined;
  if (p7RiInstruction) {
    try {
      const dependency = await registry.registerFile(
        'mars-p7-ri-instruction-class',
        p7InternalUnknownInstructionClassPath(),
        path.basename(p7InternalUnknownInstructionClassPath())
      );
      p7Dependency = { ...dependency.identity };
      engineArtifact = { ...engineArtifact, dependencies: [p7Dependency] };
    } catch (error) {
      const message = `无法捕获 P7 RI instruction runtime artifact，运行已终止：${error instanceof Error ? error.message : String(error)}`;
      appendMarsRunMessage(services, options, message);
      return { result: localMarsRunFailure(java, ['-jar', configuredMars], cwd, message), engineArtifact, resolvedRun };
    }
  }

  // The workspace registry is durable but workspace-writable. Never hand its path directly to
  // Java: copy every authorized role+digest into one unpredictable, owner-private execution
  // directory first, and keep that directory alive for all subprocesses in this logical run.
  let executionStageDir: string | undefined;
  try {
    executionStageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-mars-engine-'));
    await fs.promises.chmod(executionStageDir, 0o700).catch(() => undefined);
    const stagedMars = await registry.stageForExecution(
      engineArtifact,
      path.join(executionStageDir, 'primary')
    );
    mars = stagedMars.path;
    if (p7Dependency) {
      const stagedDependency = await registry.stageForExecution(
        p7Dependency,
        path.join(executionStageDir, 'dependencies', p7Dependency.role!)
      );
      p7InstructionClassDir = path.dirname(stagedDependency.path);
    }
  } catch (error) {
    if (executionStageDir) {
      await fs.promises.rm(executionStageDir, { recursive: true, force: true }).catch(() => undefined);
      executionStageDir = undefined;
    }
    const message = `无法准备私有 MARS 执行 artifact，运行已终止：${error instanceof Error ? error.message : String(error)}`;
    appendMarsRunMessage(services, options, message);
    if (showMessages) vscode.window.showErrorMessage(message);
    return {
      result: localMarsRunFailure(java, ['-jar', configuredMars], cwd, message),
      engineArtifact,
      resolvedRun
    };
  }

  try {
    const effectiveOptions: MarsRunOptions = {
      ...options,
      resolvedLaunch: launch,
      p7RiInstruction,
      p7InstructionClassDir
    };
    const args = buildMarsArgs(asmUri, mars, mode, effectiveOptions, memoryConfiguration, launch);

  let outputFile: vscode.Uri | undefined;
  if (mode === 'dumpText') {
    outputFile = options.dumpOutputFile ?? vscode.Uri.file(path.join(cwd, getMachineCode(asmUri)));
    await ensureDirectory(vscode.Uri.file(path.dirname(outputFile.fsPath)));
    const textRange = isCourseTraceMarsRun(mode, effectiveOptions)
      ? courseUserTextDumpRange(launch.profile as ProjectProfile)
      : '.text';
    args.push('a', 'dump', textRange, 'HexText', outputFile.fsPath);
  } else if (mode === 'dumpKernel') {
    outputFile = options.dumpOutputFile ?? vscode.Uri.file(path.join(cwd, `${basenameNoExt(asmUri)}.kernel.txt`));
    await ensureDirectory(vscode.Uri.file(path.dirname(outputFile.fsPath)));
    args.push('a', 'dump', p7KernelTextDumpRange(), 'HexText', outputFile.fsPath);
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
      timeoutMs: launch.wallClockMs,
      signal: options.signal,
      nonInteractive: options.nonInteractive,
      maxStdoutBytes: maximumReplayTraceBytes,
      maxStderrBytes: maximumReplayTraceBytes
    });
    result = withMarsCompatibilityDiagnostics(result, services, mode, effectiveOptions, memoryConfiguration);
    if (result.ok && courseDataDump) {
      const dumpError = await validateCourseDataDumpFiles(courseDataDump, result);
      if (dumpError) {
        appendMarsRunMessage(services, effectiveOptions, dumpError);
        result = localMarsRunFailureFrom(result, dumpError);
      }
    }
  } catch (error) {
    if (!requiresCourseDataPreflight) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const message = `课程 DM 初始化 dump 预检失败：${detail}。无法安全确认 MARS 与 P3–P7 硬件的全零 DM 初态一致，已终止课程 Trace。`;
    appendMarsRunMessage(services, effectiveOptions, message);
    result = localMarsRunFailure(java, args, cwd, message);
  } finally {
    if (courseDataDump) {
      await cleanupCoTmp(courseDataDump.tempDirPath);
    }
  }

  if (mode === 'dumpText' && result.ok && outputFile) {
    if (isCourseTraceMarsRun(mode, effectiveOptions)) {
      const userTextDump = await readBoundedMarsText(outputFile, 'MARS user text dump');
      const haltError = courseTraceHaltLoopError(userTextDump);
      if (haltError) {
        appendMarsRunMessage(services, effectiveOptions, haltError);
        result = localMarsRunFailureFrom(result, haltError);
      } else {
        validatedCourseHaltPc = courseTraceHaltPc(userTextDump);
      }
    }
    if (result.ok && launch.profile === 'P7') {
      result = await mergeP7KernelTextDump(services, asmUri, java, mars, cwd, outputFile, result, effectiveOptions);
    } else if (result.ok && cpuHaltProfiles.has(launch.profile as ProjectProfile)) {
      await appendHaltLoopToTextDump(outputFile, services, effectiveOptions);
    }
  }

  const artifactDriftError = await registeredMarsArtifactDriftError(registry, engineArtifact);
  if (artifactDriftError) {
    appendMarsRunMessage(services, effectiveOptions, artifactDriftError);
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
    return { result, outputFile, courseHaltPc: validatedCourseHaltPc, engineArtifact, resolvedRun };
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

    return { result, outputFile, courseHaltPc: validatedCourseHaltPc, engineArtifact, resolvedRun };
  } finally {
    if (executionStageDir) {
      await fs.promises.rm(executionStageDir, { recursive: true, force: true }).catch((error) => {
        appendMarsRunMessage(
          services,
          options,
          `无法清理私有 MARS 执行目录 ${executionStageDir}：${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
  }
}

async function registeredMarsArtifactDriftError(
  registry: ImmutableEngineArtifactRegistry,
  identity: EngineArtifactIdentity
): Promise<string | undefined> {
  try {
    await registry.resolve(identity);
    for (const dependency of identity.dependencies ?? []) {
      await registry.resolve(dependency);
    }
    return undefined;
  } catch (error) {
    return `immutable MARS registry artifact 在运行期间发生变化或变得不可用，本次结果已拒绝：${error instanceof Error ? error.message : String(error)}`;
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
  const dumpDiagnostic = marsDumpFailureDiagnostic(marsResult.stdout, marsResult.stderr);
  if (dumpDiagnostic) {
    return `课程 DM 初始化 dump 失败：MARS 报告“${dumpDiagnostic}”。无法安全确认 MARS 与 P3–P7 硬件的全零 DM 初态一致，已终止课程 Trace。`;
  }
  const texts: string[] = [];
  for (const file of dump.files) {
    texts.push(await readBoundedMarsText(file, 'MARS course data dump'));
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

function withMarsCompatibilityDiagnostics(
  result: RunResult,
  services: AppServices,
  mode: MarsRunMode,
  options: MarsRunOptions,
  memoryConfiguration: string
): RunResult {
  const message = legacyMarsCompatibilityDiagnostic({
    stdout: result.stdout,
    stderr: result.stderr,
    mode,
    traceOutput: options.traceOutput === true,
    courseTrace: isCourseTraceMarsRun(mode, options),
    p7RiInstruction: options.p7RiInstruction === true,
    memoryConfiguration
  });
  if (!message) {
    return result;
  }
  appendMarsRunMessage(services, options, message);
  return {
    ...result,
    ok: false,
    stderr: result.stderr ? `${result.stderr}\n${message}` : message
  };
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
  const args = buildMarsArgs(
    asmUri,
    mars,
    'dumpKernel',
    options,
    P7_COURSE_MEMORY_CONFIG,
    options.resolvedLaunch
  );
  args.push('a', 'dump', p7KernelTextDumpRange(), 'HexText', kernelOutputFile.fsPath, asmUri.fsPath);

  let kernelResult: RunResult;
  try {
    kernelResult = await runTool(java, args, {
      cwd,
      output: services.output,
      resource: asmUri,
      timeoutMs: options.resolvedLaunch?.wallClockMs,
      signal: options.signal,
      nonInteractive: options.nonInteractive,
      maxStdoutBytes: maximumReplayTraceBytes,
      maxStderrBytes: maximumReplayTraceBytes
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
    const dumpDiagnostic = marsDumpFailureDiagnostic(kernelResult.stdout, kernelResult.stderr);
    if (dumpDiagnostic) {
      const message = `P7 内核机器码导出失败：MARS 报告“${dumpDiagnostic}”。不能以缺失异常处理程序的 code.txt 继续测试。`;
      appendMarsRunMessage(services, options, message);
      return localMarsRunFailureFrom(kernelResult, message);
    }
    const explicitlyEmpty = marsDumpExplicitlyEmpty(kernelResult.stdout, kernelResult.stderr);
    if (!await workspaceFileExists(kernelOutputFile)) {
      if (explicitlyEmpty) {
        return previousResult;
      }
      const message = 'P7 内核机器码导出失败：MARS 未生成 kernel HexText，也未明确报告内核文本段为空。';
      appendMarsRunMessage(services, options, message);
      return localMarsRunFailureFrom(kernelResult, message);
    }
    let kernelText: string;
    try {
      kernelText = await readBoundedMarsText(kernelOutputFile, 'MARS P7 kernel dump');
    } catch (error) {
      const message = `P7 内核机器码导出失败：无法读取 kernel HexText（${error instanceof Error ? error.message : String(error)}）。`;
      appendMarsRunMessage(services, options, message);
      return localMarsRunFailureFrom(kernelResult, message);
    }
    const invalidKernelLine = kernelText.split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !/^[0-9a-fA-F]{8}$/.test(line));
    if (invalidKernelLine) {
      const message = `P7 内核机器码导出失败：kernel HexText 包含非法行 ${JSON.stringify(invalidKernelLine)}。`;
      appendMarsRunMessage(services, options, message);
      return localMarsRunFailureFrom(kernelResult, message);
    }
    const textLines = machineCodeLines(await readBoundedMarsText(textOutputFile, 'MARS P7 merged text dump'));
    const kernelLines = machineCodeLines(kernelText);
    if (!kernelLines.length) {
      if (explicitlyEmpty) {
        return previousResult;
      }
      const message = 'P7 内核机器码导出失败：kernel HexText 为空，但 MARS 未明确报告内核文本段未写入。';
      appendMarsRunMessage(services, options, message);
      return localMarsRunFailureFrom(kernelResult, message);
    }

    // Course-trace sources were already required to carry the tutorial-mandated halt loop, so
    // MARS and hardware execute the same user text. Ordinary dumps retain the legacy append.
    const terminatedTextLines = textLines.length
      ? machineCodeLines(appendHaltLoop(`${textLines.join('\n')}\n`))
      : [MIPS_SELF_BRANCH_HEX, MIPS_NOP_HEX];
    if (terminatedTextLines.length > p7KernelTextStartIndex) {
      const message = `P7 机器码导出失败：用户文本段及停机自环共有 ${terminatedTextLines.length} 条指令，已覆盖 0x${p7ExceptionHandlerAddress.toString(16)} 异常入口。`;
      appendMarsRunMessage(services, options, message);
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
    appendMarsRunMessage(services, options, `已合并 P7 内核文本段到 ${textOutputFile.fsPath}`);
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
async function appendHaltLoopToTextDump(
  outputFile: vscode.Uri,
  services: AppServices,
  options: MarsRunOptions
): Promise<void> {
  try {
    const text = await readBoundedMarsText(outputFile, 'MARS machine-code dump');
    const terminated = appendHaltLoop(text);
    if (terminated !== text) {
      await writeTextFile(outputFile, terminated);
      appendMarsRunMessage(services, options, '已为机器码追加停机自环（防止流水线取指越界，避免 hazard 工具报 AdEL）');
    }
  } catch (error) {
    appendMarsRunMessage(services, options, `追加停机自环失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function appendMarsRunMessage(
  services: AppServices,
  options: Pick<MarsRunOptions, 'nonInteractive'>,
  message: string
): void {
  if (!options.nonInteractive) {
    services.output.appendLine(message);
  }
}

async function readBoundedMarsText(file: vscode.Uri, label: string): Promise<string> {
  if (file.scheme !== 'file') throw new Error(`${label} requires a local file URI`);
  const bytes = await readBoundedRegularFile(file.fsPath, {
    maximumBytes: maximumReplayMachineCodeBytes,
    label
  });
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} is not lossless UTF-8`);
  return text;
}

async function workspaceFileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Legacy-provider output location; provider code uses the original source URI while staging execution. */
export function marsRunOutputDirectory(asmUri: vscode.Uri): vscode.Uri {
  const folder = workspaceFolderFor(asmUri);
  const baseDir = folder?.uri.fsPath ?? dirname(asmUri);
  return vscode.Uri.file(path.join(baseDir, CO_OUT_DIR));
}

/** Legacy-provider output naming kept here so private source staging does not change user-visible paths. */
export function marsOutputFileName(asmUri: vscode.Uri, stdinSource?: vscode.Uri): string {
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
