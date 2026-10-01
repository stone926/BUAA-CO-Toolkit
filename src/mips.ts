// @index mips-legacy-runner — 原版 MARS 控制台运行、预检与 HexText 导出
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { getMachineCode } from './config';
import { basenameNoExt, dirname, ensureDirectory, workspaceFolderFor, writeTextFile } from './fsUtil';
import { commandLine, revealOutputChannel, runTool } from './process';
import { p7ExceptionHandlerAddress, p7KernelTextDumpEndAddress, p7UserTextBaseAddress } from './courseTesting/p7Hardware';
import { AppServices, ProjectProfile, RunResult } from './types';
import { sanitizeFileStem } from './pathUtils';
import {
  buildMarsArgs,
  marsInclusiveDumpRange,
  officialMarsUnsupportedReason
} from './language/mips/marsArgs';
import { officialMarsCliFailure } from './language/mips/officialMarsDiagnostics';
import { marsTerminalInvocation } from './mipsTerminal';
import { Commands, CO_OUT_DIR } from './constants';
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
import {
  maximumReplayTraceBytes,
  maximumReplayMachineCodeBytes,
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
  /** Historical archive field; official MARS does not supply a course halt PC. */
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

  const resolution = await resolveLegacyMarsLaunch(document.uri, 'run', {});
  const launch = resolution.launch;
  if (!launch) {
    vscode.window.showErrorMessage(launchResolutionMessage(resolution));
    return;
  }
  const java = launch.runtime.command;
  const cwd = dirname(document.uri);
  const args = buildMarsArgs(document.uri, launch.configuredMars, 'run', {}, launch.memoryConfiguration, launch);
  const invocation = marsTerminalInvocation(java, args);
  const terminal = vscode.window.createTerminal({
    name: `MARS: ${path.basename(document.uri.fsPath)}`,
    cwd,
    shellPath: invocation.shellPath
  });
  terminal.show();
  terminal.sendText(invocation.command, true);
}

export async function runMarsFile(
  services: AppServices,
  asmUri: vscode.Uri,
  mode: MarsRunMode,
  options: MarsRunOptions = {}
): Promise<MarsRunOutput | undefined> {
  const showMessages = options.showMessages !== false && !options.nonInteractive;
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
  const unsupported = officialMarsUnsupportedReason(mode, {
    ...options,
    p7RiInstruction: options.p7RiInstruction || launch.p7RiInstruction
  }, launch.extraArgs);
  if (unsupported) {
    const message = unsupported;
    appendMarsRunMessage(services, options, message);
    if (showMessages) vscode.window.showErrorMessage(message);
    return { result: localMarsRunFailure(launch.runtime.command, [], dirname(asmUri), message) };
  }
  // Construct once before registry/output writes to validate saved launch snapshots too.
  try {
    buildMarsArgs(asmUri, launch.configuredMars, mode, options, launch.memoryConfiguration, launch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendMarsRunMessage(services, options, message);
    if (showMessages) vscode.window.showErrorMessage(message);
    return { result: localMarsRunFailure(launch.runtime.command, [], dirname(asmUri), message) };
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
  } catch (error) {
    if (executionStageDir) {
      await cleanupExecutionStage(executionStageDir).catch(() => undefined);
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
    const args = buildMarsArgs(asmUri, mars, mode, options, memoryConfiguration, launch);
    let outputFile: vscode.Uri | undefined;
    const dumpStageFile = path.join(executionStageDir!, 'text.txt');
    if (mode === 'dumpText') {
      outputFile = options.dumpOutputFile ?? vscode.Uri.file(path.join(cwd, getMachineCode(asmUri)));
      args.push('a', 'dump', '.text', 'HexText', dumpStageFile, asmUri.fsPath);
    }
    let result = await runTool(java, args, {
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
    const cliFailure = officialMarsCliFailure('', result.stderr);
    if (cliFailure) {
      appendMarsRunMessage(services, options, cliFailure);
      result = localMarsRunFailureFrom(result, cliFailure);
    }
    if (mode === 'dumpText' && result.ok && outputFile) {
      try {
        const bytes = await readBoundedRegularFile(dumpStageFile, {
          maximumBytes: maximumReplayMachineCodeBytes,
          label: 'Official MARS HexText dump'
        });
        const text = bytes.toString('utf8');
        const words = text.trim().split(/\r?\n/);
        if (!words.every((word) => /^[\da-fA-F]{8}$/.test(word))) {
          throw new Error('HexText 为空或包含非法机器码行');
        }
        await ensureDirectory(vscode.Uri.file(path.dirname(outputFile.fsPath)));
        await writeTextFile(outputFile, text);
      } catch (error) {
        const message = `原版 MARS 机器码导出失败：${error instanceof Error ? error.message : String(error)}`;
        appendMarsRunMessage(services, options, message);
        result = localMarsRunFailureFrom(result, message);
      }
    }

    const artifactDriftError = await registeredMarsArtifactDriftError(registry, engineArtifact);
    if (artifactDriftError) {
      appendMarsRunMessage(services, options, artifactDriftError);
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
      return { result, outputFile, engineArtifact, resolvedRun };
    }

    if (result.ok) {
      if (mode === 'dumpText') {
        vscode.window.showInformationMessage(`MARS 已导出 ${getMachineCode(asmUri)}`);
      } else {
        const input = options.stdinSource ? `，使用标准输入 ${path.basename(options.stdinSource.fsPath)}` : '';
        vscode.window.showInformationMessage(`MARS 运行完成${input}`);
      }
    } else {
      vscode.window.showErrorMessage(`MARS 运行失败${result.exitCode === null ? '' : `，退出码 ${result.exitCode}`}`);
    }

    return { result, outputFile, engineArtifact, resolvedRun };
  } finally {
    if (executionStageDir) {
      await cleanupExecutionStage(executionStageDir).catch((error) => {
        appendMarsRunMessage(
          services,
          options,
          `无法清理私有 MARS 执行目录 ${executionStageDir}：${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
  }
}

async function cleanupExecutionStage(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith('co-mars-engine-')) {
    throw new Error(`拒绝清理非 MARS 私有执行目录：${resolved}`);
  }
  await fs.promises.rm(resolved, { recursive: true, force: true });
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

function appendMarsRunMessage(
  services: AppServices,
  options: Pick<MarsRunOptions, 'nonInteractive'>,
  message: string
): void {
  if (!options.nonInteractive) {
    services.output.appendLine(message);
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

export function p7KernelTextDumpRange(): string {
  return marsInclusiveDumpRange(p7ExceptionHandlerAddress, p7KernelTextDumpEndAddress);
}

/** Historical helper retained for archive consumers; convert the desired inclusive final word to MARS CLI. */
export function courseUserTextDumpRange(profile: ProjectProfile): string {
  const endInclusive = profile === 'P7'
    ? p7ExceptionHandlerAddress - 4
    : p7KernelTextDumpEndAddress;
  return marsInclusiveDumpRange(p7UserTextBaseAddress, endInclusive);
}
