import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  config,
  getMachineCode,
  getIsePath,
  getProfile,
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
import { runTool } from './process';
import { findFuse } from './toolchain';
import { AppServices, RunResult } from './types';

export interface IseProjectFiles {
  prj: vscode.Uri;
  tcl: vscode.Uri;
  outDir: vscode.Uri;
}

export interface IseProjectOptions {
  resource?: vscode.Uri;
  showMessages?: boolean;
  testbenchName?: string;
}

export interface IsimRunOptions extends IseProjectOptions {
  machineCodeSource?: vscode.Uri;
  simOutputFileName?: string;
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

export function registerVerilog(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.verilog.disableLintRule', (rule?: string) => disableLintRule(rule)),
    vscode.commands.registerCommand('co.verilog.generateTestbench', () => generateTestbench()),
    vscode.commands.registerCommand('co.verilog.generateIseProject', () => generateIseProject(services)),
    vscode.commands.registerCommand('co.verilog.runIsim', () => runIsim(services))
  );
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

async function generateTestbench(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'verilog') {
    vscode.window.showErrorMessage('请先打开一个 Verilog 文件');
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
  const tbName = target.name === getTopModule(editor.document.uri) ? configuredTb : `${target.name}_tb`;
  const tbUri = vscode.Uri.file(path.join(path.dirname(editor.document.uri.fsPath), `${tbName}.v`));
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
  await writeTextFile(tbUri, buildTestbench(target, tbName, { finishDelay: verilogDelayFromSimTime(getSimTime(editor.document.uri)) }));
  await vscode.window.showTextDocument(tbUri);
}

export async function generateIseProject(
  services: AppServices,
  options: IseProjectOptions = {}
): Promise<IseProjectFiles | undefined> {
  const activeUri = options.resource ?? vscode.window.activeTextEditor?.document.uri;
  const showMessages = options.showMessages !== false;
  const folder = workspaceFolderFor(activeUri);
  if (!folder) {
    vscode.window.showErrorMessage('生成 ISE 文件前请先打开一个工作区文件夹');
    return undefined;
  }
  const top = getTestbench(activeUri);
  const testbenchName = options.testbenchName ?? top;
  const simTime = getSimTime(activeUri);
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.v'), '**/{node_modules,out,.git}/**', 5000);
  if (!files.length) {
    vscode.window.showErrorMessage('工作区中未找到 Verilog 文件');
    return undefined;
  }

  const outDir = vscode.Uri.file(path.join(folder.uri.fsPath, '.co', 'isim'));
  await ensureDirectory(outDir);
  const prj = vscode.Uri.file(path.join(outDir.fsPath, `${testbenchName}.prj`));
  const tcl = vscode.Uri.file(path.join(outDir.fsPath, `${testbenchName}.tcl`));
  const prjText = files
    .map((uri) => `Verilog work "${uri.fsPath.replace(/\\/g, '/')}"`)
    .sort()
    .join('\n') + '\n';
  const tclText = `run ${simTime};\nexit\n`;
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
  await vscode.workspace.saveAll(false);
  const isePath = getIsePath(activeUri);
  if (!isePath) {
    vscode.window.showErrorMessage('ISE 路径未配置。请设置 co.toolchain.isePath');
    return;
  }
  const fuse = findFuse(isePath);
  if (!fs.existsSync(fuse)) {
    vscode.window.showErrorMessage(`未找到 fuse 可执行文件：${fuse}`);
    return;
  }
  const testbenchName = options.testbenchName ?? await ensureRunnableTestbench(services, activeUri, showMessages);
  const generated = await generateIseProject(services, { resource: activeUri, showMessages, testbenchName });
  if (!generated) {
    return;
  }
  const machineCodeSource = options.machineCodeSource ?? await resolveMachineCodeSource(activeUri, generated.outDir);
  if (machineCodeSource) {
    await copyMachineCodeToSimDirectory(machineCodeSource, generated.outDir, activeUri);
    services.output.appendLine(`已从 ${machineCodeSource.fsPath} 准备 ${getMachineCode(activeUri)}`);
  } else {
    services.output.appendLine(`未找到可复制到 ${generated.outDir.fsPath} 的 ${getMachineCode(activeUri)} 源文件`);
    if (showMessages) {
      vscode.window.showWarningMessage(`未找到 ${getMachineCode(activeUri)}。如果设计中调用了 $readmemh("${getMachineCode(activeUri)}")，ISim 可能会失败`);
    }
  }
  const top = testbenchName ?? getTestbench(activeUri);
  const exeName = process.platform === 'win32' ? `${top}.exe` : top;
  services.output.show(true);
  const fuseResult = await runTool(fuse, ['-nodebug', '-prj', path.basename(generated.prj.fsPath), '-o', exeName, top], {
    cwd: generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: {
      XILINX: isePath
    }
  });
  if (!fuseResult.ok) {
    if (showMessages) {
      vscode.window.showErrorMessage('ISim 编译失败。请查看北航 CO 输出面板');
    }
    return undefined;
  }
  const exePath = path.join(generated.outDir.fsPath, exeName);
  const simResult = await runTool(exePath, ['-nolog', '-tclbatch', path.basename(generated.tcl.fsPath)], {
    cwd: generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: {
      XILINX: isePath
    }
  });
  let simOut: vscode.Uri | undefined;
  if (simResult.ok) {
    const simOutDir = await simulationOutputDirectory(activeUri, generated.outDir);
    simOut = vscode.Uri.file(path.join(simOutDir.fsPath, isimOutputFileName(top, options.simOutputFileName)));
    await writeTextFile(simOut, simResult.stdout);
    if (showMessages) {
      vscode.window.showInformationMessage('ISim 运行完成');
    }
  } else {
    if (showMessages) {
      vscode.window.showErrorMessage('ISim 运行失败。请查看北航 CO 输出面板');
    }
  }
  return { generated, fuseResult, simResult, simOut };
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

async function ensureRunnableTestbench(
  services: AppServices,
  resource: vscode.Uri | undefined,
  showMessages: boolean
): Promise<string | undefined> {
  const configuredTestbench = getTestbench(resource);
  const activeTestbench = await activeTestbenchModuleName(resource, configuredTestbench);
  if (activeTestbench) {
    return activeTestbench;
  }

  const topName = getTopModule(resource);
  const topDefinition = await findTopModuleDefinition(resource, topName);
  if (!topDefinition) {
    if (getProfile(resource) === 'P1') {
      const activeTestbench = await ensureActiveModuleTestbench(services, resource, showMessages);
      if (activeTestbench) {
        return activeTestbench;
      }
    }
    services.output.appendLine(`未找到顶层模块 ${topName}；使用配置的 testbench ${configuredTestbench}`);
    return configuredTestbench;
  }

  if (await findExistingTestbenchFile(topDefinition.uri, configuredTestbench)) {
    return configuredTestbench;
  }

  const tbUri = vscode.Uri.file(path.join(path.dirname(topDefinition.uri.fsPath), `${configuredTestbench}.v`));
  await writeTextFile(tbUri, buildTestbench(topDefinition.module, configuredTestbench, { finishDelay: verilogDelayFromSimTime(getSimTime(topDefinition.uri)) }));
  services.output.appendLine(`已生成 testbench ${tbUri.fsPath}`);
  if (showMessages) {
    vscode.window.showInformationMessage(`已为 ISim 生成 ${path.basename(tbUri.fsPath)}`);
  }
  return configuredTestbench;
}

async function ensureActiveModuleTestbench(
  services: AppServices,
  resource: vscode.Uri | undefined,
  showMessages: boolean
): Promise<string | undefined> {
  const definition = await activeModuleDefinition(resource);
  if (!definition) {
    return undefined;
  }
  const tbName = `${definition.module.name}_tb`;
  if (await findExistingTestbenchFile(definition.uri, tbName)) {
    return tbName;
  }
  const tbUri = vscode.Uri.file(path.join(path.dirname(definition.uri.fsPath), `${tbName}.v`));
  await writeTextFile(tbUri, buildTestbench(definition.module, tbName, { finishDelay: verilogDelayFromSimTime(getSimTime(definition.uri)) }));
  services.output.appendLine(`已生成 P1 testbench ${tbUri.fsPath}`);
  if (showMessages) {
    vscode.window.showInformationMessage(`已为 ISim 生成 ${path.basename(tbUri.fsPath)}`);
  }
  return tbName;
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

async function findTopModuleDefinition(resource: vscode.Uri | undefined, topName: string): Promise<VerilogModuleDefinition | undefined> {
  if (!topName.trim()) {
    return undefined;
  }
  const active = await topModuleDefinitionFromUri(resource, topName);
  if (active) {
    return active;
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

async function findExistingTestbenchFile(resource: vscode.Uri, tbName: string): Promise<vscode.Uri | undefined> {
  const folder = workspaceFolderFor(resource);
  if (!folder) {
    return undefined;
  }
  const matches = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, `**/${tbName}.v`),
    '**/{node_modules,out,.git,.co}/**',
    20
  );
  return matches[0];
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

function safeIsFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
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

function toTextDocument(document: vscode.TextDocument): TextDocument {
  return TextDocument.create(document.uri.toString(), document.languageId, document.version, document.getText());
}

function coSettingsForUri(uri: vscode.Uri): CoSettings {
  return {
    ...defaultCoSettings,
    project: {
      ...defaultCoSettings.project,
      profile: getProfile(uri),
      topModule: getTopModule(uri),
      testbench: getTestbench(uri),
      simTime: getSimTime(uri)
    },
    verilog: {
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
