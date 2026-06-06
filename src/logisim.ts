import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getJava, getLogisimJar } from './config';
import { dirname, readTextFile, writeTextFile } from './fsUtil';
import { findLogisimRomTargets, injectMachineCodeIntoLogisimRom, LogisimRomTarget } from './language/logisim/rom';
import { launchTool } from './process';
import { AppServices } from './types';
import { pickOneFile, resolveActiveOrPickedTextFile, resolveMachineCodeInput } from './workflowInputs';

export function registerLogisim(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.logisim.generateRom', () => generateLogisimRom()),
    vscode.commands.registerCommand('co.logisim.injectRomIntoCircuit', () => injectRomIntoCircuit()),
    vscode.commands.registerCommand('co.logisim.convertLogToCsv', () => convertLogToCsv()),
    vscode.commands.registerCommand('co.logisim.openCurrentCircuit', () => openCurrentCircuit(services))
  );
}

async function generateLogisimRom(): Promise<void> {
  const input = await resolveMachineCodeInput();
  if (!input) {
    return;
  }
  const text = await readTextFile(input);
  const rom = normalizeLogisimRom(text);
  const defaultName = `${path.basename(input.fsPath, path.extname(input.fsPath))}.logisim.txt`;
  const output = vscode.Uri.file(path.join(path.dirname(input.fsPath), defaultName));
  await writeTextFile(output, rom);
  await vscode.window.showTextDocument(output);
  vscode.window.showInformationMessage(`已生成 Logisim ROM 文件：${path.basename(output.fsPath)}。`);
}

async function injectRomIntoCircuit(): Promise<void> {
  const circuit = await resolveCircuitInput();
  if (!circuit) {
    return;
  }
  const machineCode = await resolveMachineCodeInput('选择用于 Logisim ROM 注入的 MARS HexText 机器码');
  if (!machineCode) {
    return;
  }

  const circuitText = await readTextFile(circuit);
  const machineCodeText = await readTextFile(machineCode);
  const target = await resolveRomTarget(circuitText);
  if (!target) {
    return;
  }

  let injected;
  try {
    injected = injectMachineCodeIntoLogisimRom(circuitText, machineCodeText, target.index);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(message);
    return;
  }

  const output = vscode.Uri.file(path.join(
    path.dirname(circuit.fsPath),
    `${path.basename(circuit.fsPath, path.extname(circuit.fsPath))}.${path.basename(machineCode.fsPath, path.extname(machineCode.fsPath))}.circ`
  ));
  await writeTextFile(output, injected.text);
  await vscode.window.showTextDocument(output);
  vscode.window.showInformationMessage(`已向 ${path.basename(output.fsPath)} 注入 ${injected.wordCount} 个机器码字。`);
}

async function convertLogToCsv(): Promise<void> {
  const input = await resolveActiveOrPickedTextFile('选择 Logisim 日志文本文件');
  if (!input) {
    return;
  }
  const text = await readTextFile(input);
  const csv = logisimLogToCsv(text);
  const output = vscode.Uri.file(path.join(path.dirname(input.fsPath), `${path.basename(input.fsPath, path.extname(input.fsPath))}.csv`));
  await writeTextFile(output, csv);
  await vscode.window.showTextDocument(output);
}

async function openCurrentCircuit(services: AppServices): Promise<void> {
  const circuit = await resolveCircuitInput();
  if (!circuit) {
    return;
  }
  const logisim = getLogisimJar(circuit);
  if (!logisim) {
    vscode.window.showErrorMessage('Logisim jar 未配置。请设置 co.toolchain.logisim。');
    return;
  }
  if (!fs.existsSync(logisim)) {
    vscode.window.showErrorMessage(`Logisim jar 不存在：${logisim}`);
    return;
  }
  const result = await launchTool(getJava(circuit), ['-jar', logisim, circuit.fsPath], {
    cwd: dirname(circuit),
    output: services.output,
    resource: circuit
  });
  if (!result.ok) {
    vscode.window.showErrorMessage('启动 Logisim 失败。请查看北航 CO 输出面板。');
  }
}

async function resolveCircuitInput(): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && isLogisimCircuitFile(editor.document.uri)) {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }
  return await pickOneFile('选择 Logisim .circ 文件', {
    Logisim: ['circ']
  });
}

function isLogisimCircuitFile(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && path.extname(uri.fsPath).toLowerCase() === '.circ';
}

async function resolveRomTarget(circuitText: string): Promise<LogisimRomTarget | undefined> {
  const candidates = findLogisimRomTargets(circuitText)
    .filter((target) => target.dataWidth === undefined || target.dataWidth === 32);
  if (!candidates.length) {
    vscode.window.showErrorMessage('所选 Logisim 电路中未找到 32 位 ROM 组件。');
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((target) => ({
      label: target.label ? `${target.index}: ${target.label}` : `${target.index}: ROM`,
      description: [
        target.loc ? `位置 ${target.loc}` : undefined,
        target.addrWidth ? `地址 ${target.addrWidth}` : undefined,
        target.dataWidth ? `数据 ${target.dataWidth}` : undefined,
        target.hasContents ? '有内容' : '空'
      ].filter(Boolean).join(' | '),
      target
    })),
    {
      title: '选择要注入机器码的 Logisim ROM'
    }
  );
  return picked?.target;
}

function normalizeLogisimRom(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return 'v2.0 raw\n';
  }
  if (/^v2\.0\s+raw$/i.test(lines[0])) {
    return `${lines.join('\n')}\n`;
  }
  return `v2.0 raw\n${lines.join('\n')}\n`;
}

function logisimLogToCsv(text: string): string {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/).map(csvEscape).join(','));
  return rows.join('\n') + (rows.length ? '\n' : '');
}

function csvEscape(value: string): string {
  if (!/[",\r\n]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

