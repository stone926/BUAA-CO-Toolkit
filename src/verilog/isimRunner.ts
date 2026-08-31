// @index verilog-isim-runner — ISim 编译/运行、机器码准备与 ASM case 记录
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ensureConcreteProfile,
  getMachineCode,
  getIsePath,
  getProfile,
  getSimTime,
  getTestbench
} from '../config';
import { ensureDirectory, isFile, pathExists, workspaceFolderFor, writeTextFile } from '../fsUtil';
import { revealOutputChannel, runTool } from '../process';
import { buildIseEnvironment, findFuse } from '../toolchain';
import { isimExecutableName } from '../iseCommon';
import { AppServices, RunResult } from '../types';
import { P7ProbeMetadata } from '../courseTesting/builtinAsmGenerator';
import type { MutableVerilogModuleProvider } from '../language/verilog/moduleProvider';
import {
  AsmCase,
  copyAsmCaseArtifact,
  writeAsmCaseArtifact
} from '../asmCaseStore';
import { buildIsimRunTcl } from '../verilogSimulationFiles';
import {
  isimOutputFileName,
  simulationOutputDirectory
} from '../verilogIsimOutput';
import {
  IsimCompileCache,
  isimCompileArtifactStem,
  isimCompileCacheKey
} from '../verilogIsimCache';
import {
  dedupeUris,
  normalizePathKey
} from '../pathUtils';
import {
  generateIseProject,
  IseProjectFiles,
  IseProjectOptions,
  resolveIseProjectFiles,
  verilogProjectSignature
} from './iseProject';
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
import { automaticExternalToolTimeoutMs } from '../courseTesting/automaticTestPolicy';
import {
  createVerilogSimulationFailure,
  verilogSimulationFailureMessage
} from './simulationDiagnostic';

/** Fuse diagnostics are textual and should remain well below this per-stream ceiling. */
const maximumIsimCompileOutputBytes = 4 * 1024 * 1024;
/** Bound user-controlled simulator traces to the course replay artifact ceiling. */
const maximumIsimSimulationOutputBytes = 16 * 1024 * 1024;

export interface IsimRunOptions extends IseProjectOptions {
  /** Internal operation snapshot; direct/legacy callers omit it and read current configuration. */
  isePath?: string;
  machineCodeSource?: vscode.Uri;
  asmCase?: AsmCase;
  moduleRegistry?: MutableVerilogModuleProvider;
  simOutputFileName?: string;
  simOutputUri?: vscode.Uri;
  /** P7: external-interrupt target PCs; when set, a dedicated interrupt testbench is generated. */
  interruptSchedule?: number[];
  /** P7: black-box probe metadata; when set, a dedicated probe testbench is generated. */
  p7Probe?: P7ProbeMetadata;
  compileCache?: IsimCompileCache;
  /** Cancels both compile and simulation subprocess trees. */
  signal?: AbortSignal;
}

export interface IsimRunOutput {
  generated: IseProjectFiles;
  fuseResult: RunResult;
  /** Absent when fuse failed before the simulator executable could be launched. */
  simResult?: RunResult;
  simOut?: vscode.Uri;
}

export interface CompiledIsimOutput {
  generated: IseProjectFiles;
  fuseResult: RunResult;
  testbenchName: string;
  exePath: string;
  testbench: TestbenchResolution;
}

export interface CompileIsimOptions extends IsimRunOptions {
  debug?: boolean;
  tclFileName?: string;
  tclText?: string;
}

type IsimCompileAttempt =
  | { kind: 'compiled'; output: CompiledIsimOutput }
  | { kind: 'failed'; output: Pick<IsimRunOutput, 'generated' | 'fuseResult'> };

export async function runIsim(
  services: AppServices,
  options: IsimRunOptions = {}
): Promise<IsimRunOutput | undefined> {
  const activeUri = options.resource ?? vscode.window.activeTextEditor?.document.uri;
  const showMessages = !options.nonInteractive && options.showMessages !== false;
  const asmCase = options.asmCase ?? await ensureSimulationAsmCase(services, activeUri, {
    showMessages,
    signal: options.signal,
    nonInteractive: options.nonInteractive
  });
  if (requiresSimulationAsmCase(activeUri) && !asmCase) {
    return undefined;
  }
  const compileAttempt = await attemptCompileIsim(services, options);
  if (!compileAttempt) {
    return;
  }
  if (compileAttempt.kind === 'failed') {
    return compileAttempt.output;
  }
  const compiled = compileAttempt.output;
  await prepareIsimRunInputs(services, activeUri, compiled, options, asmCase, showMessages);
  const isePath = options.isePath ?? getIsePath(activeUri);
  const iseEnv = buildIseEnvironment(isePath);
  const simResult = await runTool(compiled.exePath, ['-nolog', '-tclbatch', path.basename(compiled.generated.tcl.fsPath)], {
    cwd: compiled.generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: iseEnv,
    nonInteractive: options.nonInteractive,
    timeoutMs: options.nonInteractive ? automaticExternalToolTimeoutMs : undefined,
    signal: options.signal,
    maxStdoutBytes: maximumIsimSimulationOutputBytes,
    maxStderrBytes: maximumIsimSimulationOutputBytes
  });
  let simOut: vscode.Uri | undefined;
  if (simResult.ok) {
    if (options.simOutputUri) {
      simOut = options.simOutputUri;
      await ensureDirectory(vscode.Uri.file(path.dirname(simOut.fsPath)));
    } else {
      const simOutDir = await simulationOutputDirectory(activeUri, compiled.generated.outDir);
      simOut = vscode.Uri.file(path.join(simOutDir.fsPath, isimOutputFileName(compiled.testbenchName, options.simOutputFileName)));
    }
    await writeTextFile(simOut, simResult.stdout);
    if (asmCase) {
      if (options.simOutputUri) {
        await copyAsmCaseArtifact(asmCase, 'verilog', simOut, path.basename(simOut.fsPath), 'simOut');
      } else {
        await writeAsmCaseArtifact(asmCase, 'verilog', path.basename(simOut.fsPath), simResult.stdout, 'simOut');
      }
    }
    if (showMessages) {
      vscode.window.showInformationMessage('ISim 运行完成，输出见.co/out');
    }
  } else {
    if (showMessages) {
      vscode.window.showErrorMessage(verilogSimulationFailureMessage(
        createVerilogSimulationFailure(
          'isim',
          'simulate',
          simResult,
          workspaceFolderFor(activeUri)?.uri.fsPath
        ),
        'isim'
      ));
    }
  }
  return { generated: compiled.generated, fuseResult: compiled.fuseResult, simResult, simOut };
}

export async function compileIsim(
  services: AppServices,
  options: CompileIsimOptions = {}
): Promise<CompiledIsimOutput | undefined> {
  const attempt = await attemptCompileIsim(services, options);
  return attempt?.kind === 'compiled' ? attempt.output : undefined;
}

async function attemptCompileIsim(
  services: AppServices,
  options: CompileIsimOptions
): Promise<IsimCompileAttempt | undefined> {
  const activeUri = options.resource ?? vscode.window.activeTextEditor?.document.uri;
  const showMessages = !options.nonInteractive && options.showMessages !== false;
  if (!await ensureConcreteProfile(activeUri, '运行 ISim 需要先确定项目 Profile')) {
    return undefined;
  }
  if (!options.compileCache) {
    await vscode.workspace.saveAll(false);
  }
  const isePath = options.isePath ?? getIsePath(activeUri);
  if (!isePath) {
    if (!options.nonInteractive) {
      vscode.window.showErrorMessage('ISE 路径未配置。请设置 co.toolchain.isePath');
    }
    return undefined;
  }
  const fuse = findFuse(isePath);
  const iseEnv = buildIseEnvironment(isePath);
  if (!await isFile(fuse)) {
    if (!options.nonInteractive) {
      vscode.window.showErrorMessage(`未找到 fuse 可执行文件：${fuse}`);
    }
    return undefined;
  }
  const folder = workspaceFolderFor(activeUri);
  if (!folder) {
    if (!options.nonInteractive) {
      vscode.window.showErrorMessage('运行 ISim 前请先打开一个工作区文件夹');
    }
    return undefined;
  }

  const moduleRegistry = options.moduleRegistry;
  const resolutionOptions = { nonInteractive: options.nonInteractive };
  const resolved = options.nonInteractive
    ? (await ensureP7InterruptTestbench(services, activeUri, options.interruptSchedule, options.p7Probe, showMessages, resolutionOptions))
      ?? await ensureRunnableTestbench(services, activeUri, showMessages, moduleRegistry, resolutionOptions)
    : options.testbenchName
      ? await resolveNamedTestbench(options.testbenchName, activeUri, moduleRegistry, resolutionOptions)
      : (await ensureP7InterruptTestbench(services, activeUri, options.interruptSchedule, options.p7Probe, showMessages, resolutionOptions))
        ?? await ensureRunnableTestbench(services, activeUri, showMessages, moduleRegistry, resolutionOptions);
  if (!resolved?.moduleName) {
    return undefined;
  }
  const extraVerilogFiles = dedupeUris([
    ...(options.extraVerilogFiles ?? []),
    ...(resolved.generatedUri ? [resolved.generatedUri] : [])
  ]);
  const configuredTestbench = getTestbench(activeUri);
  const excludedTestbenchSources = options.nonInteractive
    ? await findUserTestbenchSourceUris(activeUri ?? folder.uri, configuredTestbench, moduleRegistry)
    : [];
  const projectFiles = await resolveIseProjectFiles(folder, extraVerilogFiles, options.nonInteractive
    ? {
        excludedFiles: excludedTestbenchSources,
        excludedBasenames: [`${configuredTestbench}.v`],
        protectedFiles: resolved.designSourceUri ? [resolved.designSourceUri] : []
      }
    : {});
  if (!projectFiles.length) {
    if (!options.nonInteractive) {
      vscode.window.showErrorMessage('工作区中未找到 Verilog 文件');
    }
    return undefined;
  }
  const tclText = options.tclText ?? buildIsimRunTcl(getSimTime(activeUri));
  const generatedFileSignatures = new Map<string, string>();
  if (resolved.generatedUri && resolved.sha256) {
    generatedFileSignatures.set(normalizePathKey(resolved.generatedUri.fsPath), resolved.sha256);
  }
  const projectSignature = await verilogProjectSignature(projectFiles, generatedFileSignatures);
  const cacheKey = options.compileCache
    ? isimCompileCacheKey({
      workspaceRoot: folder.uri.fsPath,
      isePath,
      moduleName: resolved.moduleName,
      testbenchKind: resolved.kind,
      testbenchSource: resolved.sourceUri?.fsPath ?? resolved.generatedUri?.fsPath,
      testbenchSha256: resolved.sha256,
      projectSignature,
      tclText,
      debug: Boolean(options.debug)
    })
    : undefined;
  const cached = cacheKey ? options.compileCache?.get(cacheKey) as CompiledIsimOutput | undefined : undefined;
  if (cached && await isFile(cached.exePath) && await pathExists(cached.generated.tcl.fsPath)) {
    if (!options.nonInteractive) {
      services.output.appendLine(`复用 ISim 编译: ${cached.exePath}`);
    }
    return { kind: 'compiled', output: cached };
  }
  const artifactStem = cacheKey ? isimCompileArtifactStem(resolved.moduleName, cacheKey) : resolved.moduleName;

  const generated = await generateIseProject(services, {
    resource: activeUri,
    showMessages,
    testbenchName: resolved.moduleName,
    projectFileBaseName: artifactStem,
    projectFiles,
    tclFileName: cacheKey ? undefined : options.tclFileName,
    tclText,
    nonInteractive: options.nonInteractive
  });
  if (!generated) {
    return undefined;
  }

  const exeName = isimExecutableName(artifactStem, fuse);
  if (!options.nonInteractive && options.revealOutput !== false) {
    revealOutputChannel(services.output, activeUri);
  }
  const fuseArgs = [
    ...(options.debug ? [] : ['-nodebug']),
    '-prj',
    path.basename(generated.prj.fsPath),
    '-o',
    exeName,
    resolved.moduleName
  ];
  const fuseResult = await runTool(fuse, fuseArgs, {
    cwd: generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: iseEnv,
    nonInteractive: options.nonInteractive,
    timeoutMs: options.nonInteractive ? automaticExternalToolTimeoutMs : undefined,
    signal: options.signal,
    maxStdoutBytes: maximumIsimCompileOutputBytes,
    maxStderrBytes: maximumIsimCompileOutputBytes
  });
  if (!fuseResult.ok) {
    if (showMessages) {
      vscode.window.showErrorMessage(verilogSimulationFailureMessage(
        createVerilogSimulationFailure('isim', 'compile', fuseResult, folder.uri.fsPath),
        'isim'
      ));
    }
    return {
      kind: 'failed',
      output: { generated, fuseResult }
    };
  }

  const compiled = {
    generated,
    fuseResult,
    testbenchName: resolved.moduleName,
    exePath: path.join(generated.outDir.fsPath, exeName),
    testbench: resolved
  };
  if (cacheKey) {
    options.compileCache?.set(cacheKey, compiled);
  }
  return { kind: 'compiled', output: compiled };
}

async function prepareIsimRunInputs(
  services: AppServices,
  activeUri: vscode.Uri | undefined,
  compiled: CompiledIsimOutput,
  options: IsimRunOptions,
  asmCase: AsmCase | undefined,
  showMessages: boolean
): Promise<void> {
  const machineCodeExpected = getProfile(activeUri) !== 'P1';
  const machineCodeSource = machineCodeExpected
    ? asmCase?.machineCode ?? options.machineCodeSource ?? await resolveMachineCodeSource(activeUri, compiled.generated.outDir)
    : undefined;
  if (machineCodeSource) {
    await copyMachineCodeToSimDirectory(machineCodeSource, compiled.generated.outDir, activeUri);
    if (!options.nonInteractive) {
      services.output.appendLine(`已从 ${machineCodeSource.fsPath} 准备 ${getMachineCode(activeUri)}`);
    }
    if (asmCase) {
      await copyAsmCaseArtifact(
        asmCase,
        'verilog',
        vscode.Uri.file(path.join(compiled.generated.outDir.fsPath, getMachineCode(activeUri))),
        'machine-code-in-sim.txt',
        'machineCodeInSim'
      );
      await copyAsmCaseArtifact(asmCase, 'verilog', compiled.generated.prj, 'isim-project.prj', 'prj');
      await copyAsmCaseArtifact(asmCase, 'verilog', compiled.generated.tcl, 'isim-run.tcl', 'tcl');
    }
  } else if (machineCodeExpected) {
    services.output.appendLine(options.nonInteractive
      ? '自动测试未能准备 CPU 机器码'
      : `未找到可复制到 ${compiled.generated.outDir.fsPath} 的 ${getMachineCode(activeUri)} 源文件`);
    if (showMessages) {
      vscode.window.showWarningMessage(`未找到 ${getMachineCode(activeUri)}。如果设计中调用了 $readmemh("${getMachineCode(activeUri)}")，ISim 可能会失败`);
    }
  }

  if (asmCase) {
    await recordTestbenchForAsmCase(asmCase, compiled.testbench);
  }
}
