// @index verilog-iverilog-runner — bundled Icarus 编译/VVP 仿真、watchdog 与课程输入准备
import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { CO_ISIM_DIR } from '../constants';
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
  isimOutputFileName,
  simulationOutputDirectory
} from '../verilogIsimOutput';
import type { IseProjectOptions } from './iseProject';
import { resolveIseProjectFiles } from './iseProject';
import type { IsimRunOptions } from './isimRunner';
import {
  buildIverilogIncludeArgs,
  buildIverilogEnvironment,
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
  ensureSimulationAsmCase,
  requiresSimulationAsmCase
} from './simulationAsmCase';
import {
  ensureP7InterruptTestbench,
  ensureRunnableTestbench,
  findUserTestbenchSourceUris,
  recordTestbenchForAsmCase,
  resolveNamedTestbench,
  TestbenchResolution
} from './testbenchResolver';
import { runSerializedWorkspaceOperation } from './workspaceOperationQueue';
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

export interface IverilogRunOptions extends IseProjectOptions, Pick<IsimRunOptions,
  | 'machineCodeSource'
  | 'asmCase'
  | 'moduleRegistry'
  | 'simOutputFileName'
  | 'simOutputUri'
  | 'interruptSchedule'
  | 'p7Probe'
  | 'signal'
> {
  /** Extension installation root. Production callers normally provide it through AppServices. */
  extensionRoot?: string;
  /** Explicit watchdog budget in picoseconds; mainly useful to non-TCL callers and tests. */
  watchdogLimitPs?: number;
  /** Existing automatic pipeline budget, e.g. `run 4195us;\nexit`. */
  tclText?: string;
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
  testbenchModule: string;
  watchdogModule: string;
  outputFile: string;
  dependencyFile: string;
  workspaceRoot: string;
  sourceFiles: readonly string[];
  watchdogFile: string;
}

/** Build the exact MVP compile argv, keeping generated sources last. */
export function buildIverilogCompileArgs(input: IverilogCompileArguments): string[] {
  assertVerilogModuleName(input.testbenchModule, 'testbenchModule');
  assertVerilogModuleName(input.watchdogModule, 'watchdogModule');
  if (!input.outputFile.trim()) {
    throw new RangeError('outputFile must not be empty');
  }
  return [
    '-g2005',
    ...buildIverilogIncludeArgs(input.workspaceRoot, [
      ...input.sourceFiles,
      input.watchdogFile
    ]),
    `-Mall=${input.dependencyFile}`,
    '-t',
    'vvp',
    '-s',
    input.testbenchModule,
    '-s',
    input.watchdogModule,
    '-o',
    input.outputFile,
    ...input.sourceFiles,
    input.watchdogFile
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

/** Parse a Verilog/ISim duration into the watchdog's 1ps time base. */
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

/** Read the final `run <duration>` command from an existing automatic ISim TCL. */
export function watchdogLimitPsFromTcl(tclText: string): number | undefined {
  const pattern = /\brun\s+(\d+(?:\.\d+)?\s*(?:fs|ps|ns|us|ms|s)?)\s*;?/gi;
  let result: number | undefined;
  for (const match of tclText.matchAll(pattern)) {
    result = verilogDurationToPicoseconds(match[1]);
  }
  return result;
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

  const asmCase = options.asmCase ?? await ensureSimulationAsmCase(services, activeUri, {
    showMessages,
    signal: options.signal,
    nonInteractive
  });
  if (requiresSimulationAsmCase(activeUri) && !asmCase) {
    return undefined;
  }

  return await runSerializedWorkspaceOperation(folder.uri.fsPath, options.signal, async () =>
    await runIverilogInWorkspace(
      services,
      options,
      activeUri,
      folder,
      asmCase,
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
    ...(testbench.generatedUri ? [testbench.generatedUri] : [])
  ]);
  const configuredTestbench = getTestbench(activeUri);
  const excludedTestbenchSources = nonInteractive
    ? await findUserTestbenchSourceUris(activeUri ?? folder.uri, configuredTestbench, options.moduleRegistry)
    : [];
  const sourceFiles = await resolveIseProjectFiles(folder, extraVerilogFiles, nonInteractive
    ? {
        excludedFiles: excludedTestbenchSources,
        excludedBasenames: [`${configuredTestbench}.v`],
        protectedFiles: testbench.designSourceUri ? [testbench.designSourceUri] : []
      }
    : {});
  if (!sourceFiles.length) {
    reportRunnerError(services, activeUri, showMessages, '工作区中未找到 Verilog 文件');
    return undefined;
  }

  const outDir = vscode.Uri.file(path.join(folder.uri.fsPath, CO_ISIM_DIR));
  await ensureDirectory(outDir);
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

  await prepareIverilogRunInputs(services, activeUri, outDir, options, asmCase, testbench, showMessages);
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
    watchdog.fsPath
  ];
  const compileArguments = buildIverilogCompileArgs({
    testbenchModule: testbench.moduleName,
    watchdogModule,
    outputFile: compiled.fsPath,
    dependencyFile: dependencies.fsPath,
    workspaceRoot: folder.uri.fsPath,
    sourceFiles: sourceFilePaths,
    watchdogFile: watchdog.fsPath
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
    if (cacheCanBeStored && cacheLookup.snapshot && compileResult.ok) {
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
    if (showMessages) {
      vscode.window.showErrorMessage(verilogSimulationFailureMessage(
        createVerilogSimulationFailure('iverilog', 'compile', compileResult, folder.uri.fsPath),
        'iverilog'
      ));
    }
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
      : isimOutputFileName(testbench.moduleName, options.simOutputFileName);
    if (options.simOutputUri) {
      simOut = options.simOutputUri;
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
    if (showMessages) {
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
  return (options.tclText ? watchdogLimitPsFromTcl(options.tclText) : undefined)
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
