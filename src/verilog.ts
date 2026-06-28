// @index verilog-commands — ISE/ISim工作流：编译/仿真/波形/P7 probe
import * as path from 'path';
import * as vscode from 'vscode';
import { Commands, ASM_NEEDED_VERILOG_PROFILES } from './constants';
import {
  ensureConcreteProfile,
  getMachineCode,
  getIsePath,
  getProfile,
  getSimTime,
  getTestbench,
  getTopModule
} from './config';
import { defaultCoSettings } from './language/common/settings';
import {
  buildTestbench,
  moduleAtPosition,
  parseVerilog
} from './language/verilog/service';
import { ensureDirectory, isFile, pathExists, workspaceFolderFor, writeTextFile } from './fsUtil';
import { revealOutputChannel, runTool } from './process';
import { buildIseEnvironment, findFuse } from './toolchain';
import { AppServices, RunResult } from './types';
import { P7ProbeMetadata } from './courseTesting/builtinAsmGenerator';
import { executeLanguageServerCommand } from './languageClient';
import type { MutableVerilogModuleProvider } from './language/verilog/moduleProvider';
import {
  AsmCase,
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  resolveAsmCaseInput,
  updateAsmCaseArtifacts,
  writeAsmCaseArtifact
} from './asmCaseStore';
import {
  buildIsimRunTcl
} from './verilogSimulationFiles';
import {
  exportVcdWaveform,
  openIsimWaveform
} from './verilogWaveform';
import {
  isimOutputFileName,
  simulationOutputDirectory
} from './verilogIsimOutput';
import {
  IsimCompileCache,
  isimCompileArtifactStem,
  isimCompileCacheKey
} from './verilogIsimCache';
import {
  dedupeUris,
  normalizePathKey
} from './pathUtils';
import {
  generateIseProject,
  IseProjectFiles,
  IseProjectOptions,
  resolveIseProjectFiles,
  verilogProjectSignature
} from './verilog/iseProject';
import {
  copyMachineCodeToSimDirectory,
  resolveMachineCodeSource
} from './verilog/simulationInputs';
import {
  coSettingsForUri,
  toTextDocument,
  verilogDelayFromSimTime
} from './verilog/documentContext';
import {
  defaultUserTestbenchUri,
  ensureP7InterruptTestbench,
  ensureRunnableTestbench,
  findExistingTestbenchResolution,
  recordTestbenchForAsmCase,
  resolveNamedTestbench,
  TestbenchResolution
} from './verilog/testbenchResolver';

export { generateIseProject } from './verilog/iseProject';
export { coSettingsForUri, toTextDocument } from './verilog/documentContext';

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

interface CompiledIsimOutput {
  generated: IseProjectFiles;
  fuseResult: RunResult;
  testbenchName: string;
  exePath: string;
  testbench: TestbenchResolution;
}

interface CompileIsimOptions extends IsimRunOptions {
  debug?: boolean;
  tclFileName?: string;
  tclText?: string;
}

let sharedModuleRegistry: MutableVerilogModuleProvider | undefined;

export function registerVerilog(context: vscode.ExtensionContext, services: AppServices, moduleRegistry?: MutableVerilogModuleProvider): void {
  sharedModuleRegistry = moduleRegistry;
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.Verilog.DisableLintRule, (rule?: string) => disableLintRule(rule)),
    vscode.commands.registerCommand(Commands.Verilog.GenerateTestbench, () => generateTestbench(moduleRegistry)),
    vscode.commands.registerCommand(Commands.Verilog.GenerateIseProject, () => generateIseProject(services)),
    vscode.commands.registerCommand(Commands.Verilog.CheckSyntaxWithIse, () => checkSyntaxWithIse()),
    vscode.commands.registerCommand(Commands.Verilog.RunIsim, () => runIsim(services, { moduleRegistry })),
    vscode.commands.registerCommand(Commands.Verilog.OpenIsimWaveform, () => openIsimWaveform(services, { compileIsim, moduleRegistry })),
    vscode.commands.registerCommand(Commands.Verilog.ExportVcd, () => exportVcdWaveform(services, { compileIsim, moduleRegistry }))
  );
}

async function checkSyntaxWithIse(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'verilog') {
    vscode.window.showErrorMessage('请先打开一个 Verilog 文件');
    return;
  }
  await editor.document.save();
  await executeLanguageServerCommand(Commands.Server.InternalVerilogCheckSyntaxWithIse, [editor.document.uri.toString()]);
  vscode.window.showInformationMessage('已触发 ISE 语法检查，结果会显示在问题面板');
}

async function disableLintRule(rule?: string): Promise<void> {
  const normalized = normalizeLintRule(rule);
  if (!normalized) {
    vscode.window.showErrorMessage('无法禁用此 Verilog Lint 规则，因为规则 ID 无效');
    return;
  }
  const config = vscode.workspace.getConfiguration('co');
  const current = config.get<string[]>('verilog.lint.disabledRules', defaultCoSettings.verilog.lint.disabledRules);
  const merged = [...new Set([...current.map((item) => item.toLowerCase()), normalized])].sort();
  await config.update('verilog.lint.disabledRules', merged, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`已在当前工作区中禁用 ${normalized.toUpperCase()}`);
}

async function generateTestbench(moduleRegistry?: MutableVerilogModuleProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'verilog') {
    vscode.window.showErrorMessage('请先打开一个 Verilog 文件');
    return;
  }
  const profile = await ensureConcreteProfile(editor.document.uri, '生成 Testbench 需要先确定项目 Profile');
  if (!profile) {
    return;
  }
  const document = toTextDocument(editor.document);
  const parsed = parseVerilog(document, coSettingsForUri(editor.document.uri), false);
  const target = moduleAtPosition(parsed.modules, {
    line: editor.selection.active.line,
    character: editor.selection.active.character
  }) ?? parsed.modules[0];
  if (!target) {
    vscode.window.showErrorMessage('当前文件中未找到 Verilog 模块');
    return;
  }

  const configuredTb = getTestbench(editor.document.uri);
  const isConfiguredTop = target.name === getTopModule(editor.document.uri);
  const tbName = isConfiguredTop ? configuredTb : `${target.name}_tb`;
  const existing = await findExistingTestbenchResolution(editor.document.uri, tbName, moduleRegistry);
  if (existing.conflict) {
    return;
  }
  if (existing.resolution?.sourceUri) {
    await vscode.window.showTextDocument(existing.resolution.sourceUri);
    return;
  }
  const tbUri = await defaultUserTestbenchUri(editor.document.uri, tbName, isConfiguredTop);
  if (await pathExists(tbUri.fsPath)) {
    const choice = await vscode.window.showWarningMessage(`${path.basename(tbUri.fsPath)} 已存在`, '打开', '覆盖');
    if (choice === '打开') {
      await vscode.window.showTextDocument(tbUri);
      return;
    }
    if (choice !== '覆盖') {
      return;
    }
  }
  await writeTextFile(tbUri, buildTestbench(target, tbName, {
    finishDelay: verilogDelayFromSimTime(getSimTime(editor.document.uri)),
    profile
  }));
  moduleRegistry?.updateUri(tbUri);
  await vscode.window.showTextDocument(tbUri);
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

async function compileIsim(
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

  const moduleRegistry = options.moduleRegistry ?? sharedModuleRegistry;
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

  const exeName = process.platform === 'win32' ? `${artifactStem}.exe` : artifactStem;
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

function normalizeLintRule(rule?: string): string | undefined {
  const normalized = rule?.trim().toLowerCase();
  return normalized && /^vc-\d{3}$/.test(normalized) ? normalized : undefined;
}
