// @index verilog-isim-runner — ISim 编译/运行、机器码准备与 ASM case 记录
import * as path from 'path';
import * as vscode from 'vscode';
import { ASM_NEEDED_VERILOG_PROFILES } from '../constants';
import {
  ensureConcreteProfile,
  getMachineCode,
  getIsePath,
  getProfile,
  getSimTime
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
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  resolveAsmCaseInput,
  updateAsmCaseArtifacts,
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
  ensureP7InterruptTestbench,
  ensureRunnableTestbench,
  recordTestbenchForAsmCase,
  resolveNamedTestbench,
  TestbenchResolution
} from './testbenchResolver';

export interface IsimRunOptions extends IseProjectOptions {
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
}

export interface IsimRunOutput {
  generated: IseProjectFiles;
  fuseResult: RunResult;
  simResult: RunResult;
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

export async function runIsim(
  services: AppServices,
  options: IsimRunOptions = {}
): Promise<IsimRunOutput | undefined> {
  const activeUri = options.resource ?? vscode.window.activeTextEditor?.document.uri;
  const showMessages = options.showMessages !== false;
  const asmCase = options.asmCase ?? await ensureSimulationAsmCase(services, activeUri, showMessages);
  if (requiresAsmCase(activeUri) && !asmCase) {
    return undefined;
  }
  const compiled = await compileIsim(services, options);
  if (!compiled) {
    return;
  }
  await prepareIsimRunInputs(services, activeUri, compiled, options, asmCase, showMessages);
  const isePath = getIsePath(activeUri);
  const iseEnv = buildIseEnvironment(isePath);
  const simResult = await runTool(compiled.exePath, ['-nolog', '-tclbatch', path.basename(compiled.generated.tcl.fsPath)], {
    cwd: compiled.generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: iseEnv
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
        await updateAsmCaseArtifacts(asmCase, 'verilog', { simOut: simOut.fsPath });
      } else {
        await writeAsmCaseArtifact(asmCase, 'verilog', path.basename(simOut.fsPath), simResult.stdout, 'simOut');
      }
    }
    if (showMessages) {
      vscode.window.showInformationMessage('ISim 运行完成，输出见.co/out');
    }
  } else {
    if (showMessages) {
      vscode.window.showErrorMessage('ISim 运行失败。请查看插件输出面板');
    }
  }
  return { generated: compiled.generated, fuseResult: compiled.fuseResult, simResult, simOut };
}

export async function compileIsim(
  services: AppServices,
  options: CompileIsimOptions = {}
): Promise<CompiledIsimOutput | undefined> {
  const activeUri = options.resource ?? vscode.window.activeTextEditor?.document.uri;
  const showMessages = options.showMessages !== false;
  if (!await ensureConcreteProfile(activeUri, '运行 ISim 需要先确定项目 Profile')) {
    return undefined;
  }
  if (!options.compileCache) {
    await vscode.workspace.saveAll(false);
  }
  const isePath = getIsePath(activeUri);
  if (!isePath) {
    vscode.window.showErrorMessage('ISE 路径未配置。请设置 co.toolchain.isePath');
    return undefined;
  }
  const fuse = findFuse(isePath);
  const iseEnv = buildIseEnvironment(isePath);
  if (!await isFile(fuse)) {
    vscode.window.showErrorMessage(`未找到 fuse 可执行文件：${fuse}`);
    return undefined;
  }
  const folder = workspaceFolderFor(activeUri);
  if (!folder) {
    vscode.window.showErrorMessage('运行 ISim 前请先打开一个工作区文件夹');
    return undefined;
  }

  const moduleRegistry = options.moduleRegistry;
  const resolved = options.testbenchName
    ? await resolveNamedTestbench(options.testbenchName, activeUri, moduleRegistry)
    : (await ensureP7InterruptTestbench(services, activeUri, options.interruptSchedule, options.p7Probe, showMessages))
    ?? await ensureRunnableTestbench(services, activeUri, showMessages, moduleRegistry);
  if (!resolved?.moduleName) {
    return undefined;
  }
  const extraVerilogFiles = dedupeUris([
    ...(options.extraVerilogFiles ?? []),
    ...(resolved.generatedUri ? [resolved.generatedUri] : [])
  ]);
  const projectFiles = await resolveIseProjectFiles(folder, extraVerilogFiles);
  if (!projectFiles.length) {
    vscode.window.showErrorMessage('工作区中未找到 Verilog 文件');
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
    services.output.appendLine(`复用 ISim 编译: ${cached.exePath}`);
    return cached;
  }
  const artifactStem = cacheKey ? isimCompileArtifactStem(resolved.moduleName, cacheKey) : resolved.moduleName;

  const generated = await generateIseProject(services, {
    resource: activeUri,
    showMessages,
    testbenchName: resolved.moduleName,
    projectFileBaseName: artifactStem,
    projectFiles,
    tclFileName: cacheKey ? undefined : options.tclFileName,
    tclText
  });
  if (!generated) {
    return undefined;
  }

  const exeName = isimExecutableName(artifactStem, fuse);
  if (options.revealOutput !== false) {
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
    env: iseEnv
  });
  if (!fuseResult.ok) {
    if (showMessages) {
      vscode.window.showErrorMessage('ISim 编译失败。请查看插件输出面板');
    }
    return undefined;
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
  return compiled;
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
    services.output.appendLine(`已从 ${machineCodeSource.fsPath} 准备 ${getMachineCode(activeUri)}`);
    if (asmCase) {
      await updateAsmCaseArtifacts(asmCase, 'verilog', {
        machineCodeInSim: path.join(compiled.generated.outDir.fsPath, getMachineCode(activeUri)),
        prj: compiled.generated.prj.fsPath,
        tcl: compiled.generated.tcl.fsPath
      });
    }
  } else if (machineCodeExpected) {
    services.output.appendLine(`未找到可复制到 ${compiled.generated.outDir.fsPath} 的 ${getMachineCode(activeUri)} 源文件`);
    if (showMessages) {
      vscode.window.showWarningMessage(`未找到 ${getMachineCode(activeUri)}。如果设计中调用了 $readmemh("${getMachineCode(activeUri)}")，ISim 可能会失败`);
    }
  }

  if (asmCase) {
    await recordTestbenchForAsmCase(asmCase, compiled.testbench);
  }
}

async function ensureSimulationAsmCase(
  services: AppServices,
  resource: vscode.Uri | undefined,
  showMessages: boolean
): Promise<AsmCase | undefined> {
  if (!requiresAsmCase(resource)) {
    return undefined;
  }
  const asm = await resolveAsmCaseInput('选择用于 Verilog 仿真的 MIPS ASM 文件');
  if (!asm) {
    if (showMessages) {
      vscode.window.showWarningMessage('已取消：P4-P7 Verilog 仿真需要选择 ASM 以生成可追溯机器码');
    }
    return undefined;
  }
  const asmCase = await createAsmCaseFromAsm(asm, {
    resource,
    source: { kind: 'selected' }
  });
  const dump = await prepareAsmCaseMachineCode(services, asmCase, { showMessages: false });
  if (!dump?.result.ok || !dump.outputFile) {
    if (showMessages) {
      vscode.window.showErrorMessage('MARS 导出机器码失败，无法继续 Verilog 仿真');
    }
    return undefined;
  }
  services.output.appendLine(`ASM case: ${asmCase.manifestUri.fsPath}`);
  return asmCase;
}

function requiresAsmCase(resource: vscode.Uri | undefined): boolean {
  return ASM_NEEDED_VERILOG_PROFILES.has(getProfile(resource));
}
