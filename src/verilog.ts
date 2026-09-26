// @index verilog-commands — Icarus 仿真、语法检查与用户 testbench 生成
import * as path from 'path';
import * as vscode from 'vscode';
import { Commands } from './constants';
import {
  ensureConcreteProfile,
  getSimTime,
  getTestbench,
  getTopModule
} from './config';
import {
  moduleAtPosition,
  parseVerilog
} from './language/verilog/service';
import { pathExists, writeTextFile } from './fsUtil';
import { AppServices } from './types';
import { executeLanguageServerCommand } from './languageClient';
import type { MutableVerilogModuleProvider } from './language/verilog/moduleProvider';
import {
  coSettingsForUri,
  toTextDocument
} from './verilog/documentContext';
import {
  findExistingTestbenchResolution,
  userTestbenchText
} from './verilog/testbenchResolver';
import {
  createUserTestbench,
  isUserTestbenchUri,
  userTestbenchUri
} from './verilog/userTestbench';
import {
  runVerilogSimulation,
  setVerilogSimulationModuleRegistry
} from './verilog/simulationRunner';
import { disableVerilogLintRule } from './diagnosticSettings';
import { isCustomTestbenchPath, isPrivateRuntimeTestbenchPath } from './verilogSimulationFiles';

export { coSettingsForUri, toTextDocument } from './verilog/documentContext';
export { runVerilogSimulation };
export type { VerilogSimulationRunOptions, VerilogSimulationRunOutput } from './verilog/simulationRunner';

export function registerVerilog(context: vscode.ExtensionContext, services: AppServices, moduleRegistry?: MutableVerilogModuleProvider): void {
  setVerilogSimulationModuleRegistry(moduleRegistry);
  context.subscriptions.push(
    vscode.commands.registerCommand(
      Commands.Verilog.DisableLintRule,
      disableVerilogLintRule
    ),
    vscode.commands.registerCommand(Commands.Verilog.GenerateTestbench, () => generateTestbench(moduleRegistry)),
    vscode.commands.registerCommand(Commands.Verilog.CheckSyntax, () => checkVerilogSyntax()),
    vscode.commands.registerCommand(Commands.Verilog.RunSimulation, () => runVerilogSimulation(services, { moduleRegistry }))
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
  await executeLanguageServerCommand(Commands.Server.InternalVerilogCheckSyntax, [editor.document.uri.toString()]);
  vscode.window.showInformationMessage('已触发外部 Verilog 语法检查，结果会显示在问题面板');
}

async function generateTestbench(moduleRegistry?: MutableVerilogModuleProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'verilog') {
    vscode.window.showErrorMessage('请先打开一个 Verilog 文件');
    return;
  }
  if (isPrivateRuntimeTestbenchPath(editor.document.uri.fsPath)) {
    vscode.window.showInformationMessage('此文件是自动测试的私有组件，请打开设计模块生成用户 testbench');
    return;
  }
  const profile = await ensureConcreteProfile(editor.document.uri, '生成 Testbench 需要先确定项目 Profile');
  if (!profile) {
    return;
  }
  if (isUserTestbenchUri(editor.document.uri) || isCustomTestbenchPath(editor.document.uri.fsPath)) {
    vscode.window.showInformationMessage('当前文件已是用户 testbench，编写激励后点击运行即可仿真');
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
  const tbUri = userTestbenchUri(editor.document.uri, tbName);
  const tbText = userTestbenchText(target, tbName, {
    profile,
    configuredTop: isConfiguredTop,
    simTime: getSimTime(editor.document.uri)
  });
  if (await pathExists(tbUri.fsPath)) {
    // The file exists but declares no usable testbench module; replace it only on request.
    const choice = await vscode.window.showWarningMessage(`${path.basename(tbUri.fsPath)} 已存在`, '打开', '覆盖');
    if (choice === '打开') {
      await vscode.window.showTextDocument(tbUri);
      return;
    }
    if (choice !== '覆盖') {
      return;
    }
    await writeTextFile(tbUri, tbText);
  } else {
    await createUserTestbench(tbUri, tbText);
  }
  await vscode.window.showTextDocument(tbUri, { preview: false });
}
