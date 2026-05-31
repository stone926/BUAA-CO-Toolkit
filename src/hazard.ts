import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getHazardCalculator, getJava } from './config';
import { runTool } from './process';
import { AppServices } from './types';
import { pickOneFile, resolveMachineCodeInput } from './workflowInputs';

export function registerHazard(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.hazard.analyzeCurrentMachineCode', () => analyzeCurrentMachineCode(services)),
    vscode.commands.registerCommand('co.hazard.openReport', () => openHazardReport())
  );
}

async function analyzeCurrentMachineCode(services: AppServices): Promise<void> {
  const input = await resolveMachineCodeInput('Select code.txt for Hazard-Calculator');
  if (!input) {
    return;
  }
  const jar = getHazardCalculator(input);
  if (!jar) {
    vscode.window.showErrorMessage('Hazard-Calculator jar is not configured. Set co.toolchain.hazardCalculator.');
    return;
  }
  if (!fs.existsSync(jar)) {
    vscode.window.showErrorMessage(`Hazard-Calculator jar does not exist: ${jar}`);
    return;
  }

  services.output.show(true);
  const cwd = path.dirname(input.fsPath);
  const result = await runTool(getJava(input), ['-jar', jar, '--hz', input.fsPath], {
    cwd,
    output: services.output,
    resource: input
  });
  if (!result.ok) {
    vscode.window.showErrorMessage('Hazard analysis failed. Check the BUAA CO output panel.');
    return;
  }

  const report = findHazardReport(cwd);
  if (!report) {
    vscode.window.showInformationMessage('Hazard analysis completed.');
    return;
  }
  const choice = await vscode.window.showInformationMessage('Hazard analysis completed.', 'Open Report');
  if (choice === 'Open Report') {
    await vscode.window.showTextDocument(vscode.Uri.file(report));
  }
}

async function openHazardReport(): Promise<void> {
  const activeDir = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
    ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
    : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const report = activeDir ? findHazardReport(activeDir) : undefined;
  if (report) {
    await vscode.window.showTextDocument(vscode.Uri.file(report));
    return;
  }
  const picked = await pickOneFile('Select hazard report JSON', {
    JSON: ['json'],
    All: ['*']
  });
  if (picked) {
    await vscode.window.showTextDocument(picked);
  }
}

function findHazardReport(directory: string): string | undefined {
  const candidates = [
    path.join(directory, 'hazard_statistic.json'),
    path.join(directory, 'hazard.json')
  ];
  return candidates.find((file) => fs.existsSync(file));
}
