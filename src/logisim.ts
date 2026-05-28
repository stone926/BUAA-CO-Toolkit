import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getJava, getLogisimJar, getMachineCode } from './config';
import { dirname, readTextFile, writeTextFile, workspaceFolderFor } from './fsUtil';
import { runTool } from './process';
import { AppServices } from './types';

export function registerLogisim(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.logisim.generateRom', () => generateLogisimRom()),
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
  vscode.window.showInformationMessage(`Generated Logisim ROM file: ${path.basename(output.fsPath)}.`);
}

async function convertLogToCsv(): Promise<void> {
  const input = await resolveActiveOrPickedTextFile('Select Logisim logging text file');
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
    vscode.window.showErrorMessage('Logisim jar is not configured. Set co.toolchain.logisim.');
    return;
  }
  if (!fs.existsSync(logisim)) {
    vscode.window.showErrorMessage(`Logisim jar does not exist: ${logisim}`);
    return;
  }
  services.output.show(true);
  const result = await runTool(getJava(circuit), ['-jar', logisim, circuit.fsPath], {
    cwd: dirname(circuit),
    output: services.output,
    resource: circuit
  });
  if (!result.ok) {
    vscode.window.showErrorMessage('Logisim exited with an error. Check the BUAA CO output panel.');
  }
}

async function resolveMachineCodeInput(): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file' && path.basename(editor.document.uri.fsPath).toLowerCase() === getMachineCode(editor.document.uri).toLowerCase()) {
    return editor.document.uri;
  }
  const base = editor?.document.uri.scheme === 'file'
    ? path.dirname(editor.document.uri.fsPath)
    : workspaceFolderFor()?.uri.fsPath;
  if (base) {
    const candidate = path.join(base, getMachineCode(editor?.document.uri));
    if (fs.existsSync(candidate)) {
      return vscode.Uri.file(candidate);
    }
  }
  return await pickOneFile('Select MARS HexText machine code file', {
    Code: ['txt'],
    All: ['*']
  });
}

async function resolveActiveOrPickedTextFile(title: string): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    return editor.document.uri;
  }
  return await pickOneFile(title, {
    Text: ['txt', 'log'],
    All: ['*']
  });
}

async function resolveCircuitInput(): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'logisim-circ' && editor.document.uri.scheme === 'file') {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }
  return await pickOneFile('Select Logisim .circ file', {
    Logisim: ['circ']
  });
}

async function pickOneFile(title: string, filters: Record<string, string[]>): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title,
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters
  });
  return picked?.[0];
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

