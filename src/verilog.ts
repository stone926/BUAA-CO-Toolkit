// @index verilog-commands — ISE/ISim工作流：编译/仿真/波形/P7 probe
import * as path from 'path';
import * as vscode from 'vscode';
import { Commands } from './constants';
import {
  ensureConcreteProfile,
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
import { pathExists, writeTextFile } from './fsUtil';
import { AppServices } from './types';
import { executeLanguageServerCommand } from './languageClient';
import type { MutableVerilogModuleProvider } from './language/verilog/moduleProvider';
import {
  exportVcdWaveform,
  openIsimWaveform
} from './verilogWaveform';
import {
  generateIseProject
} from './verilog/iseProject';
import {
  coSettingsForUri,
  toTextDocument,
  verilogDelayFromSimTime
} from './verilog/documentContext';
import {
  defaultUserTestbenchUri,
  findExistingTestbenchResolution,
} from './verilog/testbenchResolver';
import {
  compileIsim as compileIsimCore,
  CompileIsimOptions,
  CompiledIsimOutput,
  runIsim as runIsimCore,
  IsimRunOptions,
  IsimRunOutput
} from './verilog/isimRunner';

export { generateIseProject } from './verilog/iseProject';
export { coSettingsForUri, toTextDocument } from './verilog/documentContext';
export type { IsimRunOptions, IsimRunOutput, CompileIsimOptions, CompiledIsimOutput } from './verilog/isimRunner';

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
  return await runIsimCore(services, withSharedModuleRegistry(options));
}

async function compileIsim(
  services: AppServices,
  options: CompileIsimOptions = {}
): Promise<CompiledIsimOutput | undefined> {
  return await compileIsimCore(services, withSharedModuleRegistry(options));
}

function withSharedModuleRegistry<T extends { moduleRegistry?: MutableVerilogModuleProvider }>(options: T): T {
  return {
    ...options,
    moduleRegistry: options.moduleRegistry ?? sharedModuleRegistry
  };
}

function normalizeLintRule(rule?: string): string | undefined {
  const normalized = rule?.trim().toLowerCase();
  return normalized && /^vc-\d{3}$/.test(normalized) ? normalized : undefined;
}
