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
  vscode.window.showInformationMessage(`Generated Logisim ROM file: ${path.basename(output.fsPath)}.`);
}

async function injectRomIntoCircuit(): Promise<void> {
  const circuit = await resolveCircuitInput();
  if (!circuit) {
    return;
  }
  const machineCode = await resolveMachineCodeInput('Select MARS HexText machine code for Logisim ROM injection');
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
  vscode.window.showInformationMessage(`Injected ${injected.wordCount} machine-code word(s) into ${path.basename(output.fsPath)}.`);
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
  const result = await launchTool(getJava(circuit), ['-jar', logisim, circuit.fsPath], {
    cwd: dirname(circuit),
    output: services.output,
    resource: circuit
  });
  if (!result.ok) {
    vscode.window.showErrorMessage('Failed to launch Logisim. Check the BUAA CO output panel.');
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
  return await pickOneFile('Select Logisim .circ file', {
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
    vscode.window.showErrorMessage('No 32-bit ROM component was found in the selected Logisim circuit.');
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((target) => ({
      label: target.label ? `${target.index}: ${target.label}` : `${target.index}: ROM`,
      description: [
        target.loc ? `loc ${target.loc}` : undefined,
        target.addrWidth ? `addr ${target.addrWidth}` : undefined,
        target.dataWidth ? `data ${target.dataWidth}` : undefined,
        target.hasContents ? 'has contents' : 'empty'
      ].filter(Boolean).join(' | '),
      target
    })),
    {
      title: 'Select Logisim ROM to inject machine code'
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

