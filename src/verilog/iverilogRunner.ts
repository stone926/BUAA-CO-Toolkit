// @index verilog-iverilog-runner — bundled Icarus 编译/VVP 仿真、watchdog 与课程输入准备
import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { CO_IVERILOG_DIR } from '../constants';
import {
  ensureConcreteProfile,
  getMachineCode,
  getProfile,
  getSimTime,
  getTestbench
} from '../config';
import { automaticExternalToolTimeoutMs } from '../courseTesting/automaticTestPolicy';
import type { P7ProbeMetadata } from '../courseTesting/builtinAsmGenerator';
import {
  ensureDirectory,
  workspaceFolderFor,
  writeTextFile,
  writeTextFileIfChanged
} from '../fsUtil';
import type { MutableVerilogModuleProvider } from '../language/verilog/moduleProvider';
import { dedupeUris, normalizePathKey } from '../pathUtils';
import { revealOutputChannel, runTool } from '../process';
import type { AppServices, RunResult } from '../types';
import type { AsmCase } from '../asmCaseStore';
import {
  asmCaseArtifactUri,
  copyAsmCaseArtifact,
  writeAsmCaseArtifact
} from '../asmCaseStore';
import {
  simulationOutputFileName,
  simulationOutputDirectory
} from '../verilogSimulationOutput';
import { isCustomTestbenchPath, isUserTestbenchPath } from '../verilogSimulationFiles';
import { resolveVerilogProjectFiles } from './verilogProject';
import {
  buildIverilogIncludeArgs,
  buildIverilogEnvironment,
  buildIverilogRuntimeArgs,
  IverilogPreflightResult,
  IverilogRuntime,
  preflightIverilogRuntime
} from './iverilogRuntime';
import {
  IverilogCompileCacheInput,
  lookupIverilogCompileCache,
  prepareIverilogCompileCacheMiss,
  storeIverilogCompileCache
} from './iverilogCompileCache';
import {
  copyMachineCodeToSimDirectory,
  resolveMachineCodeSource
} from './simulationInputs';
import {
  ensureP7InterruptTestbench,
  ensureRunnableTestbench,
  findUserTestbenchSourceUris,
  recordTestbenchForAsmCase,
  resolveNamedTestbench,
  testbenchCompileSources,
  TestbenchResolution
} from './testbenchResolver';
import { runSerializedWorkspaceOperation } from './workspaceOperationQueue';
import { prepareUserCpuProgram, type UserCpuProgramSession } from './userCpuProgram';
import {
  createVerilogSimulationFailure,
  verilogSimulationFailureMessage
} from './simulationDiagnostic';

const defaultWatchdogLimitPs = 200_000_000;
/** Compiler diagnostics are textual and should remain well below this per-stream ceiling. */
const maximumIverilogCompileOutputBytes = 4 * 1024 * 1024;
/** Course traces share the same 16 MiB ceiling used by replay artifacts. */
const maximumIverilogSimulationOutputBytes = 16 * 1024 * 1024;
const iverilogWatchdogFileName = 'co_iverilog_watchdog.v';
const iverilogDependencyFileName = 'simulation.dependencies';

export interface IverilogRunOptions {
  /** One user action may retry compilation without asking for its ASM again. */
  userCpuProgramSession?: UserCpuProgramSession;
  resource?: vscode.Uri;
  showMessages?: boolean;
  revealOutput?: boolean;
  testbenchName?: string;
  extraVerilogFiles?: vscode.Uri[];
  nonInteractive?: boolean;
  machineCodeSource?: vscode.Uri;
  asmCase?: AsmCase;
  moduleRegistry?: MutableVerilogModuleProvider;
  simOutputFileName?: string;
  simOutputUri?: vscode.Uri;
  interruptSchedule?: number[];
  p7Probe?: P7ProbeMetadata;
  signal?: AbortSignal;
  /** Extension installation root. Production callers normally provide it through AppServices. */
  extensionRoot?: string;
  /** Explicit watchdog budget in picoseconds. */
  watchdogLimitPs?: number;
  /** Automatic pipeline duration, e.g. `4195us`. */
  simTime?: string;
  /**
   * Extra generated top-level modules (e.g. the waveform dumper) elaborated beside
   * the testbench. Called once the testbench is known; the files are written to the
   * simulation directory and compiled after every design source.
   */
  generatedTopModules?: (context: IverilogGeneratedTopContext) => Promise<readonly IverilogGeneratedTopModule[]>;
  /** Show the "simulation finished" notification (default true). Errors are always reported. */
  announceSuccess?: boolean;
  /** Directory for `<testbench>.sim.out` instead of `.co/out` (ignored when simOutputUri is set). */
  simOutputDirectory?: vscode.Uri;
  /** Return false to keep a compile failure out of the UI because the caller will retry. */
  shouldReportCompileFailure?: (result: RunResult) => boolean;
  /**
   * Inspect a successful compile before simulating; return false to skip the
   * simulation (e.g. warnings show generated sources would fail at run time).
   * The output then has no simResult, and a rejected compile is not cached.
   */
  acceptCompileResult?: (result: RunResult) => boolean;
}

export interface IverilogGeneratedTopContext {
  readonly folder: vscode.WorkspaceFolder;
  /** VVP working directory; relative paths inside generated sources resolve against it. */
  readonly outDir: vscode.Uri;
  readonly testbench: TestbenchResolution;
}

export interface IverilogGeneratedTopModule {
  readonly moduleName: string;
  /** File name inside the simulation directory. */
  readonly fileName: string;
  readonly text: string;
}

export interface IverilogGeneratedFiles {
  outDir: vscode.Uri;
  compiled: vscode.Uri;
  watchdog: vscode.Uri;
}

export interface IverilogRunOutput {
  backend: 'iverilog';
  runtimeVersion: string;
  runtime: IverilogRuntime;
  generated: IverilogGeneratedFiles;
  testbench: TestbenchResolution;
  /** True when compilation was safely skipped after content-validating the session cache. */
  compileCacheHit: boolean;
  compileResult: RunResult;
  simResult?: RunResult;
  simOut?: vscode.Uri;
}

export interface IverilogCompileArguments {
  runtime: IverilogRuntime;
  testbenchModule: string;
  watchdogModule: string;
  outputFile: string;
  dependencyFile: string;
  workspaceRoot: string;
  sourceFiles: readonly string[];
  watchdogFile: string;
  /** Additional generated roots, compiled after the watchdog. */
  extraTopModules?: readonly { readonly moduleName: string; readonly file: string }[];
}

/** Build the exact MVP compile argv, keeping generated sources last. */
export function buildIverilogCompileArgs(input: IverilogCompileArguments): string[] {
  assertVerilogModuleName(input.testbenchModule, 'testbenchModule');
  assertVerilogModuleName(input.watchdogModule, 'watchdogModule');
  const extraTopModules = input.extraTopModules ?? [];
  for (const extra of extraTopModules) {
    assertVerilogModuleName(extra.moduleName, 'extraTopModules.moduleName');
  }
  if (!input.outputFile.trim()) {
    throw new RangeError('outputFile must not be empty');
  }
  const extraFiles = extraTopModules.map((extra) => extra.file);
  return [
    ...buildIverilogRuntimeArgs(input.runtime),
    '-g2005',
    ...buildIverilogIncludeArgs(input.workspaceRoot, [
      ...input.sourceFiles,
      input.watchdogFile,
      ...extraFiles
    ]),
    `-Mall=${input.dependencyFile}`,
    '-t',
    'vvp',
    '-s',
    input.testbenchModule,
    '-s',
    input.watchdogModule,
    ...extraTopModules.flatMap((extra) => ['-s', extra.moduleName]),
    '-o',
    input.outputFile,
    ...input.sourceFiles,
    input.watchdogFile,
    ...extraFiles
  ];
}

export function buildIverilogWatchdog(moduleName: string): string {
  assertVerilogModuleName(moduleName, 'moduleName');
  return [
    '`timescale 1ps/1ps',
    `module ${moduleName};`,
    '    time limit_ps;',
    '    initial begin',
    `        if (!$value$plusargs("co_watchdog_limit_ps=%d", limit_ps)) begin`,
    `            limit_ps = ${defaultWatchdogLimitPs};`,
    '        end',
    '        #(limit_ps);',
    '        #1;',
    '        $finish;',
    '    end',
    'endmodule',
    ''
  ].join('\n');
}

/** Parse a Verilog duration into the watchdog's 1ps time base. */
export function verilogDurationToPicoseconds(duration: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(fs|ps|ns|us|ms|s)?$/i.exec(duration.trim());
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? 'ns').toLowerCase();
  const multipliers: Record<string, number> = {
    fs: 0.001,
    ps: 1,
    ns: 1_000,
    us: 1_000_000,
    ms: 1_000_000_000,
    s: 1_000_000_000_000
  };
  const picoseconds = Math.ceil(value * multipliers[unit]);
  return Number.isSafeInteger(picoseconds) && picoseconds >= 0 ? picoseconds : undefined;
}

export async function runIverilog(
  services: AppServices,
  options: IverilogRunOptions = {}
): Promise<IverilogRunOutput | undefined> {
  const activeUri = options.resource ?? vscode.window.activeTextEditor?.document.uri;
  const nonInteractive = options.nonInteractive === true;
  const showMessages = !nonInteractive && options.showMessages !== false;
  if (!await ensureConcreteProfile(activeUri, '运行 Verilog 仿真需要先确定项目 Profile')) {
    return undefined;
  }
  if (!nonInteractive) {
    await vscode.workspace.saveAll(false);
  }

  const extensionRoot = options.extensionRoot ?? services.extensionRoot;
  if (!extensionRoot?.trim()) {
    reportRunnerError(
      services,
      activeUri,
      showMessages,
      '无法定位内置 Icarus Verilog：扩展安装根路径未提供'
    );
    return undefined;
  }

  let preflight;
  try {
    preflight = await preflightIverilogRuntime(extensionRoot, {
      signal: options.signal,
      timeoutMs: nonInteractive ? automaticExternalToolTimeoutMs : undefined
    });
  } catch (error) {
    reportRunnerError(
      services,
      activeUri,
      showMessages,
      error instanceof Error ? error.message : String(error)
    );
    return undefined;
  }

  const folder = workspaceFolderFor(activeUri);
  if (!folder) {
    reportRunnerError(services, activeUri, showMessages, '运行 Verilog 仿真前请先打开一个工作区文件夹');
    return undefined;
  }

  return await runSerializedWorkspaceOperation(folder.uri.fsPath, options.signal, async () =>
    await runIverilogInWorkspace(
      services,
      options,
      activeUri,
      folder,
      options.asmCase,
      preflight,
      showMessages,
      nonInteractive
    )
  );
}

async function runIverilogInWorkspace(
  services: AppServices,
  options: IverilogRunOptions,
  activeUri: vscode.Uri | undefined,
  folder: vscode.WorkspaceFolder,
  asmCase: AsmCase | undefined,
  preflight: IverilogPreflightResult,
  showMessages: boolean,
  nonInteractive: boolean
): Promise<IverilogRunOutput | undefined> {
  const testbench = await resolveSimulationTestbench(services, activeUri, options, showMessages);
  if (!testbench?.moduleName) {
    return undefined;
  }

  const extraVerilogFiles = dedupeUris([
    ...(options.extraVerilogFiles ?? []),
    ...testbenchCompileSources(folder, testbench),
    ...(!nonInteractive && testbench.sourceUri ? [testbench.sourceUri] : [])
  ]).filter((uri) => !nonInteractive || (
    !isCustomTestbenchPath(uri.fsPath)
    && !isUserTestbenchPath(folder.uri.fsPath, uri.fsPath)
  ));
  const configuredTestbench = getTestbench(activeUri);
  const excludedTestbenchSources = nonInteractive
    ? await findUserTestbenchSourceUris(activeUri ?? folder.uri, configuredTestbench, options.moduleRegistry)
    : [];
  const sourceFiles = await resolveVerilogProjectFiles(folder, extraVerilogFiles, {
    ...(nonInteractive ? {
      excludedFiles: excludedTestbenchSources,
      excludedBasenames: [`${configuredTestbench}.v`]
    } : {}),
    protectedFiles: [testbench.designSourceUri, testbench.sourceUri]
      .filter((uri): uri is vscode.Uri => Boolean(uri)),
    excludeCustomTestbenches: true
  });
  if (!sourceFiles.length) {
    reportRunnerError(services, activeUri, showMessages, '工作区中未找到 Verilog 文件');
    return undefined;
  }

  const outDir = vscode.Uri.file(path.join(folder.uri.fsPath, CO_IVERILOG_DIR));
  await ensureDirectory(outDir);
  const userProgram = !nonInteractive && !asmCase && !options.machineCodeSource
    ? await prepareUserCpuProgram(services, testbench.sourceUri, outDir, options.signal, options.userCpuProgramSession)
    : { kind: 'unmanaged' as const };
  if (userProgram.kind === 'stopped') return undefined;
  const inputOptions = userProgram.kind === 'ready'
    ? { ...options, machineCodeSource: userProgram.machineCodeSource }
    : options;
  // Workspace operations are serialized, so one deterministic watchdog is sufficient.
  // The workspace digest keeps the name stable for caching while making collision with
  // a user's fixed module name negligibly likely; the old random name leaked one file/case.
  const watchdogModule = iverilogWatchdogModuleName(folder.uri.fsPath);
  const watchdog = vscode.Uri.file(path.join(outDir.fsPath, iverilogWatchdogFileName));
  const compiled = vscode.Uri.file(path.join(outDir.fsPath, 'simulation.vvp'));
  const dependencies = vscode.Uri.file(path.join(outDir.fsPath, iverilogDependencyFileName));
  const watchdogLimitPs = resolveWatchdogLimitPs(activeUri, options);
  await writeTextFileIfChanged(watchdog, buildIverilogWatchdog(watchdogModule));
  const generated: IverilogGeneratedFiles = { outDir, compiled, watchdog };
  const extraTopModules: { moduleName: string; file: string }[] = [];
  for (const extra of await options.generatedTopModules?.({ folder, outDir, testbench }) ?? []) {
    const file = vscode.Uri.file(path.join(outDir.fsPath, path.basename(extra.fileName)));
    await writeTextFileIfChanged(file, extra.text);
    extraTopModules.push({ moduleName: extra.moduleName, file: file.fsPath });
  }

  await prepareIverilogRunInputs(services, activeUri, outDir, inputOptions, asmCase, testbench, showMessages);
  if (!nonInteractive && options.revealOutput !== false) {
    revealOutputChannel(services.output, activeUri);
  }
  services.output.appendLine(`Verilog backend: ${preflight.version} (bundled)`);

  const processOptions = {
    cwd: outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: buildIverilogEnvironment(preflight.runtime),
    nonInteractive,
    timeoutMs: nonInteractive ? automaticExternalToolTimeoutMs : undefined,
    signal: options.signal
  };
  const sourceFilePaths = sourceFiles.map((uri) => uri.fsPath);
  const directSourceFiles = [
    ...sourceFilePaths,
    watchdog.fsPath,
    ...extraTopModules.map((extra) => extra.file)
  ];
  const compileArguments = buildIverilogCompileArgs({
    runtime: preflight.runtime,
    testbenchModule: testbench.moduleName,
    watchdogModule,
    outputFile: compiled.fsPath,
    dependencyFile: dependencies.fsPath,
    workspaceRoot: folder.uri.fsPath,
    sourceFiles: sourceFilePaths,
    watchdogFile: watchdog.fsPath,
    extraTopModules
  });
  const cacheInput: IverilogCompileCacheInput = {
    workspaceRoot: folder.uri.fsPath,
    compileCwd: outDir.fsPath,
    runtime: { ...preflight.runtime, version: preflight.version },
    compileArguments,
    directSourceFiles,
    compiledFile: compiled.fsPath,
    dependencyFile: dependencies.fsPath
  };
  const cacheLookup = await lookupIverilogCompileCache(cacheInput, options.signal);
  const compileCacheHit = cacheLookup.hit !== undefined;
  const compile = async (): Promise<RunResult> => await runTool(
    preflight.runtime.iverilogPath,
    compileArguments,
    {
      ...processOptions,
      maxStdoutBytes: maximumIverilogCompileOutputBytes,
      maxStderrBytes: maximumIverilogCompileOutputBytes
    }
  );
  // The caller's verdict is taken once per compile. A rejected compile is never
  // published: the cache keeps no compiler warnings, so a later hit could not be
  // rejected again.
  let compileAccepted: boolean | undefined;
  const acceptCompile = (result: RunResult): boolean =>
    compileAccepted ??= options.acceptCompileResult?.(result) !== false;
  let compileResult: RunResult;
  if (cacheLookup.hit) {
    compileResult = cacheLookup.hit.compileResult;
  } else if (options.signal?.aborted) {
    // Let the process supervisor produce the canonical stopped result without
    // deleting a still-valid cache artifact after cancellation won the lookup.
    compileResult = await compile();
  } else {
    const cacheCanBeStored = await prepareIverilogCompileCacheMiss(cacheInput);
    compileResult = await compile();
    if (cacheCanBeStored && cacheLookup.snapshot && compileResult.ok && acceptCompile(compileResult)) {
      await storeIverilogCompileCache(cacheLookup.snapshot, compileResult, options.signal);
    }
  }
  const baseOutput: Omit<IverilogRunOutput, 'compileResult'> = {
    backend: 'iverilog',
    runtimeVersion: preflight.version,
    runtime: preflight.runtime,
    generated,
    testbench,
    compileCacheHit
  };
  if (!compileResult.ok) {
    await persistIverilogFailureLog(services, asmCase, 'compile', compileResult);
    if (showMessages && options.shouldReportCompileFailure?.(compileResult) !== false) {
      vscode.window.showErrorMessage(verilogSimulationFailureMessage(
        createVerilogSimulationFailure('iverilog', 'compile', compileResult, folder.uri.fsPath),
        'iverilog'
      ));
    }
    return { ...baseOutput, compileResult };
  }
  if (!acceptCompile(compileResult)) {
    return { ...baseOutput, compileResult };
  }

  const simResult = await runTool(preflight.runtime.vvpPath, [
    '-N',
    compiled.fsPath,
    `+co_watchdog_limit_ps=${watchdogLimitPs}`
  ], {
    ...processOptions,
    maxStdoutBytes: maximumIverilogSimulationOutputBytes,
    maxStderrBytes: maximumIverilogSimulationOutputBytes
  });
  let simOut: vscode.Uri | undefined;
  if (simResult.ok) {
    const simFileName = options.simOutputUri
      ? path.basename(options.simOutputUri.fsPath)
      : simulationOutputFileName(testbench.moduleName, options.simOutputFileName);
    if (options.simOutputUri) {
      simOut = options.simOutputUri;
    } else if (options.simOutputDirectory) {
      await ensureDirectory(options.simOutputDirectory);
      simOut = vscode.Uri.joinPath(options.simOutputDirectory, simFileName);
    } else {
      const outputDir = await simulationOutputDirectory(activeUri, outDir);
      simOut = vscode.Uri.file(path.join(outputDir.fsPath, simFileName));
    }
    const expectedCaseOutput = asmCase
      ? asmCaseArtifactUri(asmCase, 'verilog', simFileName)
      : undefined;
    if (asmCase
      && options.simOutputUri
      && options.simOutputUri.scheme === 'file'
      && expectedCaseOutput
      && normalizePathKey(simOut.fsPath) === normalizePathKey(expectedCaseOutput.fsPath)) {
      // Automatic tests already target the case artifact path. Persist and bind
      // the retained stdout in one write without reopening a trace of up to 16 MiB.
      await writeAsmCaseArtifact(asmCase, 'verilog', simFileName, simResult.stdout, 'simOut');
    } else {
      if (options.simOutputUri) {
        const outputParent = options.simOutputUri.scheme === 'file'
          ? vscode.Uri.file(path.dirname(simOut.fsPath))
          : simOut.with({ path: path.posix.dirname(simOut.path), query: '', fragment: '' });
        await ensureDirectory(outputParent);
      }
      await writeTextFile(simOut, simResult.stdout);
      if (asmCase) {
        // The process result is the authoritative bounded byte source. Reusing
        // it avoids reopening a requested output (including virtual-file URIs).
        await writeAsmCaseArtifact(asmCase, 'verilog', simFileName, simResult.stdout, 'simOut');
      }
    }
    if (showMessages && options.announceSuccess !== false) {
      vscode.window.showInformationMessage('Icarus Verilog 仿真完成，输出见 .co/out');
    }
  } else {
    await persistIverilogFailureLog(services, asmCase, 'simulation', simResult);
    if (showMessages) {
      vscode.window.showErrorMessage(verilogSimulationFailureMessage(
        createVerilogSimulationFailure('iverilog', 'simulate', simResult, folder.uri.fsPath),
        'iverilog'
      ));
    }
  }

  return { ...baseOutput, compileResult, simResult, simOut };
}

function iverilogWatchdogModuleName(workspaceRoot: string): string {
  const digest = createHash('sha256')
    .update(normalizePathKey(path.resolve(workspaceRoot)))
    .digest('hex')
    .slice(0, 16);
  return `__co_iverilog_watchdog_${digest}`;
}

async function resolveSimulationTestbench(
  services: AppServices,
  activeUri: vscode.Uri | undefined,
  options: IverilogRunOptions,
  showMessages: boolean
): Promise<TestbenchResolution | undefined> {
  const resolutionOptions = { nonInteractive: options.nonInteractive };
  if (options.nonInteractive) {
    return (await ensureP7InterruptTestbench(
      services,
      activeUri,
      options.interruptSchedule,
      options.p7Probe as P7ProbeMetadata | undefined,
      showMessages,
      resolutionOptions,
      options.moduleRegistry
    )) ?? await ensureRunnableTestbench(
      services,
      activeUri,
      showMessages,
      options.moduleRegistry,
      resolutionOptions
    );
  }
  if (options.testbenchName) {
    return await resolveNamedTestbench(
      options.testbenchName,
      activeUri,
      options.moduleRegistry,
      resolutionOptions
    );
  }
  return await ensureRunnableTestbench(
    services,
    activeUri,
    showMessages,
    options.moduleRegistry,
    resolutionOptions
  );
}

async function prepareIverilogRunInputs(
  services: AppServices,
  activeUri: vscode.Uri | undefined,
  outDir: vscode.Uri,
  options: IverilogRunOptions,
  asmCase: AsmCase | undefined,
  testbench: TestbenchResolution,
  showMessages: boolean
): Promise<void> {
  const machineCodeExpected = getProfile(activeUri) !== 'P1';
  const machineCodeSource = machineCodeExpected
    ? asmCase?.machineCode ?? options.machineCodeSource ?? await resolveMachineCodeSource(activeUri, outDir)
    : undefined;
  if (machineCodeSource) {
    await copyMachineCodeToSimDirectory(machineCodeSource, outDir, activeUri);
    if (!options.nonInteractive) {
      services.output.appendLine(`已从 ${machineCodeSource.fsPath} 准备 ${getMachineCode(activeUri)}`);
    }
    if (asmCase) {
      await copyAsmCaseArtifact(
        asmCase,
        'verilog',
        vscode.Uri.file(path.join(outDir.fsPath, getMachineCode(activeUri))),
        'machine-code-in-sim.txt',
        'machineCodeInSim'
      );
    }
  } else if (machineCodeExpected) {
    services.output.appendLine(options.nonInteractive
      ? '自动测试未能准备 CPU 机器码'
      : `未找到可复制到 ${outDir.fsPath} 的 ${getMachineCode(activeUri)} 源文件`);
    if (showMessages) {
      vscode.window.showWarningMessage(
        `未找到 ${getMachineCode(activeUri)}。如果设计中调用了 $readmemh("${getMachineCode(activeUri)}")，VVP 可能会失败`
      );
    }
  }
  if (asmCase) {
    await recordTestbenchForAsmCase(asmCase, testbench);
  }
}

function resolveWatchdogLimitPs(
  resource: vscode.Uri | undefined,
  options: IverilogRunOptions
): number {
  if (options.watchdogLimitPs !== undefined) {
    assertWatchdogLimit(options.watchdogLimitPs);
    return options.watchdogLimitPs;
  }
  return (options.simTime ? verilogDurationToPicoseconds(options.simTime) : undefined)
    ?? verilogDurationToPicoseconds(getSimTime(resource))
    ?? defaultWatchdogLimitPs;
}

function assertWatchdogLimit(limitPs: number): void {
  if (!Number.isSafeInteger(limitPs) || limitPs < 0) {
    throw new RangeError('watchdog limit must be a non-negative safe integer number of picoseconds');
  }
}

function assertVerilogModuleName(moduleName: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(moduleName)) {
    throw new RangeError(`${label} must be a Verilog identifier`);
  }
}

function reportRunnerError(
  services: AppServices,
  resource: vscode.Uri | undefined,
  showMessages: boolean,
  message: string
): void {
  services.output.appendLine(message);
  if (showMessages) {
    revealOutputChannel(services.output, resource);
    vscode.window.showErrorMessage(message);
  }
}

async function persistIverilogFailureLog(
  services: AppServices,
  asmCase: AsmCase | undefined,
  phase: 'compile' | 'simulation',
  result: RunResult
): Promise<void> {
  if (!asmCase) {
    return;
  }
  const content = [
    `phase=${phase}`,
    `exitCode=${result.exitCode ?? 'none'}`,
    `timedOut=${result.timedOut}`,
    `stopReason=${result.stopReason ?? 'none'}`,
    '',
    '--- stderr ---',
    result.stderr,
    '',
    '--- stdout ---',
    result.stdout
  ].join('\n');
  try {
    await writeAsmCaseArtifact(
      asmCase,
      'verilog',
      `iverilog-${phase}.log`,
      content,
      `${phase}Log`
    );
  } catch {
    // The original simulator failure remains authoritative. Artifact persistence is
    // best-effort so a read-only/legacy case cannot turn it into an internal error.
    services.output.appendLine('Icarus Verilog 失败日志未能写入测试历史');
  }
}
