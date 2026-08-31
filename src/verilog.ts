// @index verilog-commands — ISE/ISim工作流：编译/仿真/波形/P7 probe
import * as path from 'path';
import * as vscode from 'vscode';
import { Commands } from './constants';
import {
  ensureConcreteProfile,
  getIsePath,
  getSimTime,
  getTestbench,
  getTopModule
} from './config';
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
} from './verilog/isimRunner';
import {
  runVerilogSimulation,
  setVerilogSimulationModuleRegistry
} from './verilog/simulationRunner';
import { disableVerilogLintRule } from './diagnosticSettings';

export { generateIseProject } from './verilog/iseProject';
export { coSettingsForUri, toTextDocument } from './verilog/documentContext';
export { runIsim } from './verilog/isimRunner';
export { runVerilogSimulation };
export type { IsimRunOptions, IsimRunOutput, CompileIsimOptions, CompiledIsimOutput } from './verilog/isimRunner';
export type { VerilogSimulationRunOptions, VerilogSimulationRunOutput } from './verilog/simulationRunner';

export function registerVerilog(context: vscode.ExtensionContext, services: AppServices, moduleRegistry?: MutableVerilogModuleProvider): void {
  setVerilogSimulationModuleRegistry(moduleRegistry);
  context.subscriptions.push(
    vscode.commands.registerCommand(
      Commands.Verilog.DisableLintRule,
      disableVerilogLintRule
    ),
    vscode.commands.registerCommand(Commands.Verilog.GenerateTestbench, () => generateTestbench(moduleRegistry)),
    vscode.commands.registerCommand(Commands.Verilog.GenerateIseProject, () => runIseOnlyCommand(() => generateIseProject(services))),
    vscode.commands.registerCommand(Commands.Verilog.CheckSyntaxWithIse, () => checkVerilogSyntax()),
    vscode.commands.registerCommand(Commands.Verilog.RunIsim, () => runVerilogSimulation(services, { moduleRegistry })),
    vscode.commands.registerCommand(Commands.Verilog.OpenIsimWaveform, () => runIseOnlyCommand(() => openIsimWaveform(services, { compileIsim: compileIsimCore, moduleRegistry }))),
    vscode.commands.registerCommand(Commands.Verilog.ExportVcd, () => runIseOnlyCommand(() => exportVcdWaveform(services, { compileIsim: compileIsimCore, moduleRegistry })))
  );
}

async function checkVerilogSyntax(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'verilog') {
    vscode.window.showErrorMessage('请先打开一个 Verilog 文件');
    return;
  }
  if (coSettingsForUri(editor.document.uri).verilog.syntax.external.mode === 'off') {
    vscode.window.showInformationMessage('外部 Verilog 语法检查已在设置中关闭');
    return;
  }
  await editor.document.save();
  await executeLanguageServerCommand(Commands.Server.InternalVerilogCheckSyntaxWithIse, [editor.document.uri.toString()]);
  vscode.window.showInformationMessage('已触发外部 Verilog 语法检查，结果会显示在问题面板');
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

async function runIseOnlyCommand<T>(action: () => Promise<T>): Promise<T | undefined> {
  const resource = vscode.window.activeTextEditor?.document.uri;
  if (!getIsePath(resource).trim()) {
    vscode.window.showErrorMessage('此功能需要 Xilinx ISE。请先设置 co.toolchain.isePath');
    return undefined;
  }
  return await action();
}
