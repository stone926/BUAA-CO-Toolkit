import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  config,
  ensureConcreteProfile,
  getMachineCode,
  getIsePath,
  getProfile,
  getRunTimeout,
  getSimTime,
  getTestbench,
  getTopModule
} from './config';
import { CoSettings, defaultCoSettings } from './language/common/settings';
import {
  buildTestbench,
  moduleAtPosition,
  parseVerilog,
  VerilogModule
} from './language/verilog/service';
import { ensureDirectory, workspaceFolderFor, writeTextFile } from './fsUtil';
import { launchTool, revealOutputChannel, runTool } from './process';
import { buildIseEnvironment, findFuse } from './toolchain';
import { AppServices, RunResult } from './types';
import { P7ProbeMetadata } from './courseTesting/builtinAsmGenerator';
import { executeLanguageServerCommand } from './languageClient';
import type { MutableVerilogModuleProvider } from './language/verilog/moduleProvider';
import {
  AsmCase,
  copyAsmCaseArtifact,
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  resolveAsmCaseInput,
  updateAsmCaseArtifacts,
  writeAsmCaseArtifact
} from './asmCaseStore';
import {
  buildIseProjectText,
  buildIsimRunTcl,
  buildIsimVcdTcl,
  buildIsimWaveTcl,
  generatedRuntimeTestbenchText,
  isGeneratedRuntimeTestbench,
  p7AutoRuntimeTestbenchName,
  runtimeTestbenchFileName,
  verilogProjectExcludeGlob
} from './verilogSimulationFiles';
import { sha256Bytes } from './asmCaseStoreCore';

export interface IseProjectFiles {
  prj: vscode.Uri;
  tcl: vscode.Uri;
  outDir: vscode.Uri;
}

export interface IseProjectOptions {
  resource?: vscode.Uri;
  showMessages?: boolean;
  revealOutput?: boolean;
  testbenchName?: string;
  extraVerilogFiles?: vscode.Uri[];
  tclFileName?: string;
  tclText?: string;
}

export interface IsimRunOptions extends IseProjectOptions {
  machineCodeSource?: vscode.Uri;
  asmCase?: AsmCase;
  moduleRegistry?: MutableVerilogModuleProvider;
  simOutputFileName?: string;
  /** P7: external-interrupt target PCs; when set, a dedicated interrupt testbench is generated. */
  interruptSchedule?: number[];
  /** P7: black-box probe metadata; when set, a dedicated probe testbench is generated. */
  p7Probe?: P7ProbeMetadata;
}

export interface IsimRunOutput {
  generated: IseProjectFiles;
  fuseResult: RunResult;
  simResult: RunResult;
  simOut?: vscode.Uri;
}

interface VerilogModuleDefinition {
  module: VerilogModule;
  uri: vscode.Uri;
}

type TestbenchResolutionKind = 'active' | 'user' | 'generated' | 'p7-auto';

interface TestbenchResolution {
  moduleName: string;
  kind: TestbenchResolutionKind;
  sourceUri?: vscode.Uri;
  generatedUri?: vscode.Uri;
  sha256?: string;
}

interface CompiledIsimOutput {
  generated: IseProjectFiles;
  fuseResult: RunResult;
  testbenchName: string;
  exePath: string;
  asmCase?: AsmCase;
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
    vscode.commands.registerCommand('co.verilog.disableLintRule', (rule?: string) => disableLintRule(rule)),
    vscode.commands.registerCommand('co.verilog.generateTestbench', () => generateTestbench(moduleRegistry)),
    vscode.commands.registerCommand('co.verilog.generateIseProject', () => generateIseProject(services)),
    vscode.commands.registerCommand('co.verilog.checkSyntaxWithIse', () => checkSyntaxWithIse()),
    vscode.commands.registerCommand('co.verilog.runIsim', () => runIsim(services, { moduleRegistry })),
    vscode.commands.registerCommand('co.verilog.openIsimWaveform', () => openIsimWaveform(services, moduleRegistry)),
    vscode.commands.registerCommand('co.verilog.exportVcd', () => exportVcdWaveform(services, moduleRegistry))
  );
}

async function checkSyntaxWithIse(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'verilog') {
    vscode.window.showErrorMessage('请先打开一个 Verilog 文件');
    return;
  }
  await editor.document.save();
  await executeLanguageServerCommand('co.internal.verilog.checkSyntaxWithIse', [editor.document.uri.toString()]);
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
  if (fs.existsSync(tbUri.fsPath)) {
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

async function defaultUserTestbenchUri(resource: vscode.Uri, tbName: string, configuredTop: boolean): Promise<vscode.Uri> {
  const folder = workspaceFolderFor(resource);
  if (configuredTop && folder) {
    const testDir = vscode.Uri.file(path.join(folder.uri.fsPath, 'test'));
    await ensureDirectory(testDir);
    return vscode.Uri.file(path.join(testDir.fsPath, `${tbName}.v`));
  }
  return vscode.Uri.file(path.join(path.dirname(resource.fsPath), `${tbName}.v`));
}

export async function generateIseProject(
  services: AppServices,
  options: IseProjectOptions = {}
): Promise<IseProjectFiles | undefined> {
  const activeUri = options.resource ?? vscode.window.activeTextEditor?.document.uri;
  const showMessages = options.showMessages !== false;
  if (!await ensureConcreteProfile(activeUri, '生成 ISE 工程需要先确定项目 Profile')) {
    return undefined;
  }
  const folder = workspaceFolderFor(activeUri);
  if (!folder) {
    vscode.window.showErrorMessage('生成 ISE 文件前请先打开一个工作区文件夹');
    return undefined;
  }
  const top = getTestbench(activeUri);
  const testbenchName = options.testbenchName ?? top;
  const simTime = getSimTime(activeUri);
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.v'), verilogProjectExcludeGlob, 5000);
  const projectFiles = dedupeUris([...files, ...(options.extraVerilogFiles ?? [])]);
  if (!projectFiles.length) {
    vscode.window.showErrorMessage('工作区中未找到 Verilog 文件');
    return undefined;
  }

  const outDir = vscode.Uri.file(path.join(folder.uri.fsPath, '.co', 'isim'));
  await ensureDirectory(outDir);
  const prj = vscode.Uri.file(path.join(outDir.fsPath, `${testbenchName}.prj`));
  const tcl = vscode.Uri.file(path.join(outDir.fsPath, options.tclFileName ?? `${testbenchName}.tcl`));
  const prjText = buildIseProjectText(projectFiles.map((uri) => uri.fsPath));
  const tclText = options.tclText ?? buildIsimRunTcl(simTime);
  await writeTextFile(prj, prjText);
  await writeTextFile(tcl, tclText);
  services.output.appendLine(`已生成 ${prj.fsPath}`);
  services.output.appendLine(`已生成 ${tcl.fsPath}`);
  if (showMessages) {
    vscode.window.showInformationMessage('已生成 ISE PRJ/TCL 文件');
  }
  return { prj, tcl, outDir };
}

export async function runIsim(
  services: AppServices,
  options: IsimRunOptions = {}
): Promise<IsimRunOutput | undefined> {
  const activeUri = options.resource ?? vscode.window.activeTextEditor?.document.uri;
  const showMessages = options.showMessages !== false;
  const compiled = await compileIsim(services, options);
  if (!compiled) {
    return;
  }
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
    const simOutDir = await simulationOutputDirectory(activeUri, compiled.generated.outDir);
    simOut = vscode.Uri.file(path.join(simOutDir.fsPath, isimOutputFileName(compiled.testbenchName, options.simOutputFileName)));
    await writeTextFile(simOut, simResult.stdout);
    if (compiled.asmCase) {
      await writeAsmCaseArtifact(compiled.asmCase, 'verilog', path.basename(simOut.fsPath), simResult.stdout, 'simOut');
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

async function openIsimWaveform(services: AppServices, moduleRegistry?: MutableVerilogModuleProvider): Promise<void> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const simTime = getSimTime(activeUri);
  const compiled = await compileIsim(services, {
    resource: activeUri,
    moduleRegistry,
    debug: true,
    tclFileName: 'co_wave.tcl',
    tclText: buildIsimWaveTcl(simTime)
  });
  if (!compiled) {
    return;
  }
  const isePath = getIsePath(activeUri);
  const iseEnv = buildIseEnvironment(isePath);
  const result = await launchTool(compiled.exePath, ['-gui', '-tclbatch', path.basename(compiled.generated.tcl.fsPath)], {
    cwd: compiled.generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: iseEnv
  });
  if (result.ok) {
    if (compiled.asmCase) {
      await updateAsmCaseArtifacts(compiled.asmCase, 'verilog', {
        waveTcl: compiled.generated.tcl.fsPath,
        isimExecutable: compiled.exePath
      });
    }
    vscode.window.showInformationMessage('已启动 ISim 波形窗口');
  } else {
    vscode.window.showErrorMessage('启动 ISim 波形窗口失败。请查看插件输出面板');
  }
}

async function exportVcdWaveform(services: AppServices, moduleRegistry?: MutableVerilogModuleProvider): Promise<void> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const simTime = getSimTime(activeUri);
  const simOutDir = await simulationOutputDirectory(activeUri, vscode.Uri.file(path.join(workspaceFolderFor(activeUri)?.uri.fsPath ?? process.cwd(), '.co', 'isim')));
  const preliminaryTestbenchName = getTestbench(activeUri);
  const preliminaryVcd = vscode.Uri.file(path.join(simOutDir.fsPath, `${preliminaryTestbenchName}.vcd`));
  const compiled = await compileIsim(services, {
    resource: activeUri,
    moduleRegistry,
    debug: true,
    tclFileName: 'co_vcd.tcl',
    tclText: buildIsimVcdTcl(preliminaryVcd.fsPath, preliminaryTestbenchName, simTime)
  });
  if (!compiled) {
    return;
  }

  const vcd = vscode.Uri.file(path.join(simOutDir.fsPath, `${compiled.testbenchName}.vcd`));
  if (!samePath(vcd.fsPath, preliminaryVcd.fsPath)) {
    await writeTextFile(compiled.generated.tcl, buildIsimVcdTcl(vcd.fsPath, compiled.testbenchName, simTime));
  }
  const isePath = getIsePath(activeUri);
  const iseEnv = buildIseEnvironment(isePath);
  const result = await runTool(compiled.exePath, ['-nolog', '-tclbatch', path.basename(compiled.generated.tcl.fsPath)], {
    cwd: compiled.generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: iseEnv
  });
  if (result.ok && fs.existsSync(vcd.fsPath)) {
    if (compiled.asmCase) {
      await copyAsmCaseArtifact(compiled.asmCase, 'verilog', vcd, path.basename(vcd.fsPath), 'vcd');
    }
    await vscode.commands.executeCommand('revealFileInOS', vcd);
    vscode.window.showInformationMessage(`已导出 VCD 波形：${path.basename(vcd.fsPath)}`);
  } else {
    vscode.window.showErrorMessage('导出 VCD 波形失败。请查看插件输出面板');
  }
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
  await vscode.workspace.saveAll(false);
  const isePath = getIsePath(activeUri);
  if (!isePath) {
    vscode.window.showErrorMessage('ISE 路径未配置。请设置 co.toolchain.isePath');
    return undefined;
  }
  const fuse = findFuse(isePath);
  const iseEnv = buildIseEnvironment(isePath);
  if (!fs.existsSync(fuse)) {
    vscode.window.showErrorMessage(`未找到 fuse 可执行文件：${fuse}`);
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

  const generated = await generateIseProject(services, {
    resource: activeUri,
    showMessages,
    testbenchName: resolved.moduleName,
    extraVerilogFiles: resolved.generatedUri ? [resolved.generatedUri] : undefined,
    tclFileName: options.tclFileName,
    tclText: options.tclText
  });
  if (!generated) {
    return undefined;
  }

  const asmCase = options.asmCase ?? await ensureSimulationAsmCase(services, activeUri, showMessages);
  if (requiresAsmCase(activeUri) && !asmCase) {
    return undefined;
  }
  const machineCodeExpected = getProfile(activeUri) !== 'P1';
  const machineCodeSource = machineCodeExpected
    ? asmCase?.machineCode ?? options.machineCodeSource ?? await resolveMachineCodeSource(activeUri, generated.outDir)
    : undefined;
  if (machineCodeSource) {
    await copyMachineCodeToSimDirectory(machineCodeSource, generated.outDir, activeUri);
    services.output.appendLine(`已从 ${machineCodeSource.fsPath} 准备 ${getMachineCode(activeUri)}`);
    if (asmCase) {
      await updateAsmCaseArtifacts(asmCase, 'verilog', {
        machineCodeInSim: path.join(generated.outDir.fsPath, getMachineCode(activeUri)),
        prj: generated.prj.fsPath,
        tcl: generated.tcl.fsPath
      });
    }
  } else if (machineCodeExpected) {
    services.output.appendLine(`未找到可复制到 ${generated.outDir.fsPath} 的 ${getMachineCode(activeUri)} 源文件`);
    if (showMessages) {
      vscode.window.showWarningMessage(`未找到 ${getMachineCode(activeUri)}。如果设计中调用了 $readmemh("${getMachineCode(activeUri)}")，ISim 可能会失败`);
    }
  }

  if (asmCase) {
    await recordTestbenchForAsmCase(asmCase, resolved);
  }

  const exeName = process.platform === 'win32' ? `${resolved.moduleName}.exe` : resolved.moduleName;
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

  return {
    generated,
    fuseResult,
    testbenchName: resolved.moduleName,
    exePath: path.join(generated.outDir.fsPath, exeName),
    asmCase,
    testbench: resolved
  };
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
  return new Set(['P4', 'P5', 'P6', 'P7']).has(getProfile(resource));
}

function isimOutputFileName(top: string, configured?: string): string {
  const trimmed = configured?.trim();
  return trimmed ? path.basename(trimmed) : `${top}.sim.out`;
}

async function simulationOutputDirectory(resource: vscode.Uri | undefined, isimDir: vscode.Uri): Promise<vscode.Uri> {
  const folder = workspaceFolderFor(resource) ?? workspaceFolderFor(isimDir) ?? vscode.workspace.workspaceFolders?.[0];
  const baseDir = folder?.uri.fsPath ?? path.dirname(path.dirname(isimDir.fsPath));
  const outDir = vscode.Uri.file(path.join(baseDir, '.co', 'out'));
  await ensureDirectory(outDir);
  return outDir;
}

/**
 * For P7 automated trace runs that inject an external interrupt, generate a dedicated testbench
 * (the official P7 interrupt testbench with the interrupt block active and target_pc baked in)
 * under .co/isim, without overwriting the student's own testbench. Returns the module name, or
 * undefined when no schedule is given or the top module cannot be located.
 */
async function ensureP7InterruptTestbench(
  services: AppServices,
  resource: vscode.Uri | undefined,
  interruptSchedule: number[] | undefined,
  p7Probe: P7ProbeMetadata | undefined,
  showMessages: boolean
): Promise<TestbenchResolution | undefined> {
  if ((!interruptSchedule || !interruptSchedule.length) && !p7Probe) {
    return undefined;
  }
  const topName = getTopModule(resource);
  const topDefinition = await findTopModuleDefinition(resource, topName);
  if (!topDefinition) {
    services.output.appendLine(`未找到顶层模块 ${topName}，无法生成 P7 中断 testbench；改用默认 testbench（不注入外部中断）。`);
    return undefined;
  }
  const folder = workspaceFolderFor(resource) ?? workspaceFolderFor(topDefinition.uri) ?? vscode.workspace.workspaceFolders?.[0];
  const baseDir = folder?.uri.fsPath ?? path.dirname(topDefinition.uri.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, '.co', 'isim'));
  await ensureDirectory(outDir);
  const tbUri = vscode.Uri.file(path.join(outDir.fsPath, `${p7AutoRuntimeTestbenchName}.v`));
  const written = await writeGeneratedRuntimeTestbench(tbUri, buildTestbench(topDefinition.module, p7AutoRuntimeTestbenchName, {
    finishDelay: verilogDelayFromSimTime(getSimTime(resource)),
    profile: 'P7',
    interruptSchedule,
    p7Probe
  }));
  if (!written) {
    return undefined;
  }
  if (p7Probe) {
    services.output.appendLine(`已生成 P7 probe testbench ${tbUri.fsPath}（scenarios=${p7Probe.scenarios.map((scenario) => `${scenario.id}:${scenario.kind}`).join(',')}）`);
  } else {
    services.output.appendLine(`已生成 P7 中断 testbench ${tbUri.fsPath}（target_pc=${(interruptSchedule ?? []).map((pc) => `0x${(pc >>> 0).toString(16)}`).join(',')}）`);
  }
  if (showMessages) {
    vscode.window.showInformationMessage('已生成 P7 中断 testbench');
  }
  return { moduleName: p7AutoRuntimeTestbenchName, kind: 'p7-auto', generatedUri: tbUri, sha256: await fileSha256(tbUri) };
}

async function ensureRunnableTestbench(
  services: AppServices,
  resource: vscode.Uri | undefined,
  showMessages: boolean,
  moduleRegistry?: MutableVerilogModuleProvider
): Promise<TestbenchResolution | undefined> {
  const configuredTestbench = getTestbench(resource);
  const activeTestbench = await activeTestbenchModuleName(resource, configuredTestbench);
  if (activeTestbench) {
    return {
      moduleName: activeTestbench,
      kind: 'active',
      sourceUri: resource,
      sha256: resource ? await fileSha256(resource) : undefined
    };
  }

  const topName = getTopModule(resource);
  const topDefinition = await findTopModuleDefinition(resource, topName, moduleRegistry);
  if (!topDefinition) {
    if (getProfile(resource) === 'P1') {
      const activeTestbench = await ensureActiveModuleTestbench(services, resource, showMessages, moduleRegistry);
      if (activeTestbench) {
        return activeTestbench;
      }
    }
    services.output.appendLine(`未找到顶层模块 ${topName}；使用配置的 testbench ${configuredTestbench}`);
    return await resolveNamedTestbench(configuredTestbench, resource, moduleRegistry);
  }

  const existing = await findExistingTestbenchResolution(topDefinition.uri, configuredTestbench, moduleRegistry);
  if (existing.conflict) {
    return undefined;
  }
  if (existing.resolution) {
    return existing.resolution;
  }

  const tbUri = await runtimeTestbenchUri(topDefinition.uri, configuredTestbench);
  const written = await writeGeneratedRuntimeTestbench(tbUri, buildTestbench(topDefinition.module, configuredTestbench, {
    finishDelay: verilogDelayFromSimTime(getSimTime(topDefinition.uri)),
    profile: getProfile(topDefinition.uri)
  }));
  if (!written) {
    return undefined;
  }
  services.output.appendLine(`已生成 testbench ${tbUri.fsPath}`);
  if (showMessages) {
    vscode.window.showInformationMessage(`已为 ISim 生成 ${path.basename(tbUri.fsPath)}`);
  }
  return { moduleName: configuredTestbench, kind: 'generated', generatedUri: tbUri, sha256: await fileSha256(tbUri) };
}

async function ensureActiveModuleTestbench(
  services: AppServices,
  resource: vscode.Uri | undefined,
  showMessages: boolean,
  moduleRegistry?: MutableVerilogModuleProvider
): Promise<TestbenchResolution | undefined> {
  const definition = await activeModuleDefinition(resource);
  if (!definition) {
    return undefined;
  }
  const tbName = `${definition.module.name}_tb`;
  const existing = await findExistingTestbenchResolution(definition.uri, tbName, moduleRegistry);
  if (existing.conflict) {
    return undefined;
  }
  if (existing.resolution) {
    return existing.resolution;
  }
  const tbUri = await runtimeTestbenchUri(definition.uri, tbName);
  const written = await writeGeneratedRuntimeTestbench(tbUri, buildTestbench(definition.module, tbName, {
    finishDelay: verilogDelayFromSimTime(getSimTime(definition.uri)),
    profile: getProfile(definition.uri)
  }));
  if (!written) {
    return undefined;
  }
  services.output.appendLine(`已生成 P1 testbench ${tbUri.fsPath}`);
  if (showMessages) {
    vscode.window.showInformationMessage(`已为 ISim 生成 ${path.basename(tbUri.fsPath)}`);
  }
  return { moduleName: tbName, kind: 'generated', generatedUri: tbUri, sha256: await fileSha256(tbUri) };
}

async function runtimeTestbenchUri(resource: vscode.Uri, testbenchName: string): Promise<vscode.Uri> {
  const folder = workspaceFolderFor(resource) ?? vscode.workspace.workspaceFolders?.[0];
  const baseDir = folder?.uri.fsPath ?? path.dirname(resource.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, '.co', 'isim'));
  await ensureDirectory(outDir);
  return vscode.Uri.file(path.join(outDir.fsPath, runtimeTestbenchFileName(testbenchName)));
}

async function resolveNamedTestbench(
  testbenchName: string,
  resource: vscode.Uri | undefined,
  moduleRegistry?: MutableVerilogModuleProvider
): Promise<TestbenchResolution | undefined> {
  const existing = resource
    ? await findExistingTestbenchResolution(resource, testbenchName, moduleRegistry)
    : { resolution: undefined, conflict: false };
  if (existing.conflict) {
    return undefined;
  }
  return existing.resolution ?? { moduleName: testbenchName, kind: 'user' };
}

interface ExistingTestbenchSearchResult {
  resolution?: TestbenchResolution;
  conflict: boolean;
}

async function findExistingTestbenchResolution(
  resource: vscode.Uri,
  tbName: string,
  moduleRegistry?: MutableVerilogModuleProvider
): Promise<ExistingTestbenchSearchResult> {
  const candidates = await testbenchCandidates(resource, tbName, moduleRegistry);
  if (!candidates.length) {
    if (moduleRegistry?.scanning) {
      vscode.window.showWarningMessage('项目 Verilog 模块仍在解析，未找到跨文件 testbench 时可稍后重试');
    }
    return { conflict: false };
  }
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      rank: testbenchCandidateRank(candidate.uri, resource, tbName)
    }))
    .sort((left, right) => left.rank - right.rank || left.uri.fsPath.localeCompare(right.uri.fsPath));
  const best = ranked[0];
  const sameRank = ranked.filter((candidate) => candidate.rank === best.rank);
  if (sameRank.length > 1) {
    const choices = sameRank.map((candidate) => vscode.workspace.asRelativePath(candidate.uri)).join(', ');
    vscode.window.showErrorMessage(`发现多个同优先级 testbench 模块 ${tbName}: ${choices}`);
    return { conflict: true };
  }
  return {
    conflict: false,
    resolution: {
      moduleName: best.module.name,
      kind: 'user',
      sourceUri: best.uri,
      sha256: await fileSha256(best.uri)
    }
  };
}

async function testbenchCandidates(
  resource: vscode.Uri,
  tbName: string,
  moduleRegistry?: MutableVerilogModuleProvider
): Promise<Array<{ module: VerilogModule; uri: vscode.Uri }>> {
  const seen = new Set<string>();
  const candidates: Array<{ module: VerilogModule; uri: vscode.Uri }> = [];
  const add = (module: VerilogModule): void => {
    if (module.name !== tbName) {
      return;
    }
    const uri = uriForVerilogModule(module);
    if (!uri || isCoPath(uri.fsPath)) {
      return;
    }
    if (!safeIsFile(uri.fsPath)) {
      moduleRegistry?.removeUri(uri);
      return;
    }
    const key = `${module.name}@${normalizePathKey(uri.fsPath)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ module, uri });
  };

  const active = await activeModuleDefinition(resource);
  if (active) {
    add(active.module);
  }
  for (const module of moduleRegistry?.getModules(tbName) ?? []) {
    add(module);
  }
  if (!moduleRegistry) {
    for (const module of await scanWorkspaceModulesByName(resource, tbName)) {
      add(module);
    }
  }
  return candidates;
}

function testbenchCandidateRank(uri: vscode.Uri, resource: vscode.Uri, tbName: string): number {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri && samePath(activeUri.fsPath, uri.fsPath)) {
    return 0;
  }
  const folder = workspaceFolderFor(resource) ?? workspaceFolderFor(uri);
  const relativeParts = folder ? path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).map((part) => part.toLowerCase()) : [];
  if (relativeParts.includes('test') || relativeParts.includes('tests')) {
    return 10;
  }
  if (path.basename(uri.fsPath).toLowerCase() === `${tbName.toLowerCase()}.v`) {
    return 20;
  }
  return 50 + relativeParts.length;
}

async function scanWorkspaceModulesByName(resource: vscode.Uri, moduleName: string): Promise<VerilogModule[]> {
  const folder = workspaceFolderFor(resource);
  if (!folder) {
    return [];
  }
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*.v'),
    '**/{node_modules,out,.git,.co}/**',
    5000
  );
  const found: VerilogModule[] = [];
  for (const uri of files) {
    const document = await verilogDocumentForUri(uri);
    if (!document) {
      continue;
    }
    const parsed = parseVerilog(document, coSettingsForUri(uri), false);
    found.push(...parsed.modules.filter((module) => module.name === moduleName));
  }
  return found;
}

async function recordTestbenchForAsmCase(asmCase: AsmCase, resolution: TestbenchResolution): Promise<void> {
  const source = resolution.sourceUri ?? resolution.generatedUri;
  const artifacts: Record<string, string> = {
    testbenchModule: resolution.moduleName,
    testbenchKind: resolution.kind
  };
  if (source) {
    const snapshot = await copyAsmCaseArtifact(asmCase, 'verilog', source, 'testbench.v', 'testbenchSnapshot');
    const sha256 = await fileSha256(source);
    artifacts.testbenchSource = source.fsPath;
    artifacts.testbenchSnapshot = snapshot.fsPath;
    if (sha256) {
      artifacts.testbenchSha256 = sha256;
    }
  } else if (resolution.sha256) {
    artifacts.testbenchSha256 = resolution.sha256;
  }
  await updateAsmCaseArtifacts(asmCase, 'verilog', artifacts);
}

async function writeGeneratedRuntimeTestbench(uri: vscode.Uri, testbenchText: string): Promise<boolean> {
  if (fs.existsSync(uri.fsPath)) {
    const existing = await readTextFileSafe(uri);
    if (!isGeneratedRuntimeTestbench(existing)) {
      vscode.window.showErrorMessage(`不会覆盖非插件生成的 testbench：${uri.fsPath}`);
      return false;
    }
  }
  await writeTextFile(uri, generatedRuntimeTestbenchText(testbenchText));
  return true;
}

async function readTextFileSafe(uri: vscode.Uri): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return '';
  }
}

async function activeModuleDefinition(resource: vscode.Uri | undefined): Promise<VerilogModuleDefinition | undefined> {
  if (!resource || resource.scheme !== 'file' || path.extname(resource.fsPath).toLowerCase() !== '.v') {
    return undefined;
  }
  const document = await verilogDocumentForUri(resource);
  if (!document) {
    return undefined;
  }
  const parsed = parseVerilog(document, coSettingsForUri(resource), false);
  const activeEditor = vscode.window.activeTextEditor;
  const activePosition = activeEditor?.document.uri.toString() === resource.toString()
    ? activeEditor.selection.active
    : undefined;
  const module = activePosition
    ? moduleAtPosition(parsed.modules, activePosition) ?? parsed.modules[0]
    : parsed.modules[0];
  return module ? { module, uri: resource } : undefined;
}

async function activeTestbenchModuleName(resource: vscode.Uri | undefined, configuredTestbench: string): Promise<string | undefined> {
  if (!resource || resource.scheme !== 'file' || path.extname(resource.fsPath).toLowerCase() !== '.v') {
    return undefined;
  }
  const document = await verilogDocumentForUri(resource);
  if (!document) {
    return undefined;
  }
  const parsed = parseVerilog(document, coSettingsForUri(resource), false);
  const activeEditor = vscode.window.activeTextEditor;
  const activePosition = activeEditor?.document.uri.toString() === resource.toString()
    ? activeEditor.selection.active
    : undefined;
  const activeModule = activePosition ? moduleAtPosition(parsed.modules, activePosition) : undefined;
  if (activeModule && isTestbenchModule(activeModule, configuredTestbench)) {
    return activeModule.name;
  }
  return parsed.modules.find((module) => isTestbenchModule(module, configuredTestbench))?.name;
}

async function verilogDocumentForUri(uri: vscode.Uri): Promise<TextDocument | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.uri.toString() === uri.toString()) {
    return toTextDocument(active);
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return TextDocument.create(uri.toString(), 'verilog', 1, Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
}

function isTestbenchModule(module: { name: string; ports: unknown[] }, configuredTestbench: string): boolean {
  const lower = module.name.toLowerCase();
  return module.name === configuredTestbench || lower.includes('tb') || (module.ports.length === 0 && lower.endsWith('test'));
}

async function findTopModuleDefinition(
  resource: vscode.Uri | undefined,
  topName: string,
  moduleRegistry?: MutableVerilogModuleProvider
): Promise<VerilogModuleDefinition | undefined> {
  if (!topName.trim()) {
    return undefined;
  }
  const active = await topModuleDefinitionFromUri(resource, topName);
  if (active) {
    return active;
  }

  for (const module of moduleRegistry?.getModules(topName) ?? []) {
    const uri = uriForVerilogModule(module);
    if (uri && resource?.toString() !== uri.toString()) {
      return { module, uri };
    }
  }

  const folder = workspaceFolderFor(resource) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*.v'),
    '**/{node_modules,out,.git,.co}/**',
    5000
  );
  const sorted = files
    .filter((uri) => resource?.toString() !== uri.toString())
    .sort((left, right) => left.fsPath.localeCompare(right.fsPath));
  for (const uri of sorted) {
    const definition = await topModuleDefinitionFromUri(uri, topName);
    if (definition) {
      return definition;
    }
  }
  return undefined;
}

async function topModuleDefinitionFromUri(uri: vscode.Uri | undefined, topName: string): Promise<VerilogModuleDefinition | undefined> {
  if (!uri || uri.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.v') {
    return undefined;
  }
  const document = await verilogDocumentForUri(uri);
  if (!document) {
    return undefined;
  }
  const parsed = parseVerilog(document, coSettingsForUri(uri), false);
  const module = parsed.modules.find((candidate) => candidate.name === topName);
  return module ? { module, uri } : undefined;
}

async function resolveMachineCodeSource(resource: vscode.Uri | undefined, outDir: vscode.Uri): Promise<vscode.Uri | undefined> {
  const machineCode = getMachineCode(resource);
  const target = path.resolve(outDir.fsPath, machineCode);
  const candidates: string[] = [];
  if (path.isAbsolute(machineCode)) {
    candidates.push(machineCode);
  }
  if (resource?.scheme === 'file') {
    candidates.push(path.resolve(path.dirname(resource.fsPath), machineCode));
  }
  const folder = workspaceFolderFor(resource) ?? vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    candidates.push(path.resolve(folder.uri.fsPath, machineCode));
  }

  for (const candidate of dedupePaths(candidates)) {
    if (safeIsFile(candidate) && !samePath(candidate, target)) {
      return vscode.Uri.file(candidate);
    }
  }

  if (!folder) {
    return undefined;
  }
  const matches = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, `**/${path.basename(machineCode)}`),
    '**/{node_modules,out,.git,.co}/**',
    50
  );
  return matches
    .filter((uri) => safeIsFile(uri.fsPath) && !samePath(uri.fsPath, target))
    .sort((left, right) => machineCodeCandidateRank(left.fsPath, resource, folder) - machineCodeCandidateRank(right.fsPath, resource, folder))
    [0];
}

function machineCodeCandidateRank(file: string, resource: vscode.Uri | undefined, folder: vscode.WorkspaceFolder): number {
  if (resource?.scheme === 'file' && samePath(path.dirname(file), path.dirname(resource.fsPath))) {
    return 0;
  }
  if (samePath(path.dirname(file), folder.uri.fsPath)) {
    return 10;
  }
  const relative = path.relative(folder.uri.fsPath, file).split(path.sep).map((part) => part.toLowerCase());
  if (relative.includes('test') || relative.includes('tests')) {
    return 20;
  }
  if (relative.includes('data')) {
    return 30;
  }
  return 100 + relative.length;
}

function dedupePaths(files: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const file of files) {
    const key = normalizePathKey(file);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(file);
  }
  return result;
}

function dedupeUris(files: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const result: vscode.Uri[] = [];
  for (const uri of files) {
    const key = normalizePathKey(uri.fsPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(uri);
  }
  return result;
}

function safeIsFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function uriForVerilogModule(module: VerilogModule): vscode.Uri | undefined {
  try {
    return vscode.Uri.parse(module.uri);
  } catch {
    return undefined;
  }
}

async function fileSha256(uri: vscode.Uri | undefined): Promise<string | undefined> {
  if (!uri || uri.scheme !== 'file') {
    return undefined;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return sha256Bytes(bytes);
  } catch {
    return undefined;
  }
}

async function copyMachineCodeToSimDirectory(
  source: vscode.Uri,
  outDir: vscode.Uri,
  resource?: vscode.Uri
): Promise<void> {
  const target = vscode.Uri.file(path.join(outDir.fsPath, getMachineCode(resource)));
  if (samePath(source.fsPath, target.fsPath)) {
    return;
  }
  await ensureDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
  const content = await vscode.workspace.fs.readFile(source);
  await vscode.workspace.fs.writeFile(target, content);
}

function samePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

function normalizePathKey(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isCoPath(file: string): boolean {
  return file.split(/[\\/]+/).some((part) => part.toLowerCase() === '.co');
}

function verilogDelayFromSimTime(simTime: string): string {
  const match = /^(\d+(?:\.\d+)?)\s*(fs|ps|ns|us|ms|s)?$/i.exec(simTime.trim());
  if (!match) {
    return '200000';
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? 'ns').toLowerCase();
  const multipliers: Record<string, number> = {
    fs: 0.000001,
    ps: 0.001,
    ns: 1,
    us: 1000,
    ms: 1000000,
    s: 1000000000
  };
  const delay = value * multipliers[unit];
  if (!Number.isFinite(delay) || delay < 0) {
    return '200000';
  }
  const rounded = Math.round(delay);
  return Math.abs(delay - rounded) < 1e-9 ? String(rounded) : Number(delay.toFixed(6)).toString();
}

export function toTextDocument(document: vscode.TextDocument): TextDocument {
  return TextDocument.create(document.uri.toString(), document.languageId, document.version, document.getText());
}

export function coSettingsForUri(uri: vscode.Uri): CoSettings {
  return {
    ...defaultCoSettings,
    project: {
      ...defaultCoSettings.project,
      profile: getProfile(uri),
      topModule: getTopModule(uri),
      testbench: getTestbench(uri),
      simTime: getSimTime(uri)
    },
    toolchain: {
      isePath: getIsePath(uri)
    },
    run: {
      timeoutMs: getRunTimeout(uri)
    },
    verilog: {
      syntax: {
        ise: {
          enabled: config<boolean>('verilog.syntax.ise.enabled', defaultCoSettings.verilog.syntax.ise.enabled, uri),
          mode: config<CoSettings['verilog']['syntax']['ise']['mode']>('verilog.syntax.ise.mode', defaultCoSettings.verilog.syntax.ise.mode, uri),
          timeoutMs: config<number>('verilog.syntax.ise.timeoutMs', defaultCoSettings.verilog.syntax.ise.timeoutMs, uri)
        }
      },
      implicitNet: {
        diagnostic: config<CoSettings['verilog']['implicitNet']['diagnostic']>('verilog.implicitNet.diagnostic', defaultCoSettings.verilog.implicitNet.diagnostic, uri),
        ignorePatterns: config<string[]>('verilog.implicitNet.ignorePatterns', defaultCoSettings.verilog.implicitNet.ignorePatterns, uri)
      },
      lint: {
        courseRules: config<boolean>('verilog.lint.courseRules', defaultCoSettings.verilog.lint.courseRules, uri),
        synthesizableHints: config<boolean>('verilog.lint.synthesizableHints', defaultCoSettings.verilog.lint.synthesizableHints, uri),
        disabledRules: config<string[]>('verilog.lint.disabledRules', defaultCoSettings.verilog.lint.disabledRules, uri)
      },
      format: {
        style: config<CoSettings['verilog']['format']['style']>('verilog.format.style', defaultCoSettings.verilog.format.style, uri),
        continuationIndent: config<number>('verilog.format.continuationIndent', defaultCoSettings.verilog.format.continuationIndent, uri),
        spaceInRange: config<boolean>('verilog.format.spaceInRange', defaultCoSettings.verilog.format.spaceInRange, uri),
        declarationRangeSpacing: config<CoSettings['verilog']['format']['declarationRangeSpacing']>('verilog.format.declarationRangeSpacing', defaultCoSettings.verilog.format.declarationRangeSpacing, uri),
        spaceBeforeInstancePorts: config<boolean>('verilog.format.spaceBeforeInstancePorts', defaultCoSettings.verilog.format.spaceBeforeInstancePorts, uri),
        separateElse: config<boolean>('verilog.format.separateElse', defaultCoSettings.verilog.format.separateElse, uri),
        maxBlankLines: config<number>('verilog.format.maxBlankLines', defaultCoSettings.verilog.format.maxBlankLines, uri)
      }
    }
  };
}

function normalizeLintRule(rule?: string): string | undefined {
  const normalized = rule?.trim().toLowerCase();
  return normalized && /^vc-\d{3}$/.test(normalized) ? normalized : undefined;
}
