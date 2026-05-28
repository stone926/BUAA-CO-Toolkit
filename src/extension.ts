import * as vscode from 'vscode';
import { getProfile } from './config';
import { startLanguageServer, stopLanguageServer } from './languageClient';
import { registerLogisim } from './logisim';
import { registerMips } from './mips';
import { checkToolchain } from './toolchain';
import { AppServices, ProjectProfile, ToolDetection } from './types';
import { registerVerilog } from './verilog';

export function activate(context: vscode.ExtensionContext): void {
  startLanguageServer(context);

  const output = vscode.window.createOutputChannel('BUAA CO');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'co.checkToolchain';
  context.subscriptions.push(output, statusBar);

  const services: AppServices = {
    output,
    statusBar
  };

  registerMips(context, services);
  registerVerilog(context, services);
  registerLogisim(context, services);

  context.subscriptions.push(
    vscode.commands.registerCommand('co.checkToolchain', () => showToolchainReport(output)),
    vscode.commands.registerCommand('co.selectProjectProfile', () => selectProjectProfile()),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatus(statusBar)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('co.project.profile')) {
        updateStatus(statusBar);
      }
    })
  );

  updateStatus(statusBar);
}

export async function deactivate(): Promise<void> {
  await stopLanguageServer();
}

async function showToolchainReport(output: vscode.OutputChannel): Promise<void> {
  output.show(true);
  output.appendLine('Checking BUAA CO toolchain...');
  const resource = vscode.window.activeTextEditor?.document.uri;
  const checks = await checkToolchain(output, resource);
  output.appendLine('');
  for (const check of checks) {
    output.appendLine(`${check.ok ? 'OK' : 'MISS'} ${check.name}: ${check.detail}`);
    if (check.suggestion) {
      output.appendLine(`  suggestion: ${check.suggestion}`);
    }
  }

  const panel = vscode.window.createWebviewPanel('coToolchainReport', 'BUAA CO Toolchain', vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  panel.webview.html = renderToolchainReport(checks);
}

async function selectProjectProfile(): Promise<void> {
  const profiles: ProjectProfile[] = ['auto', 'P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
  const current = getProfile(vscode.window.activeTextEditor?.document.uri);
  const picked = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile,
      description: profile === current ? 'current' : profileDescription(profile),
      profile
    })),
    {
      title: 'Select BUAA CO project profile'
    }
  );
  if (!picked) {
    return;
  }
  await vscode.workspace.getConfiguration('co').update('project.profile', picked.profile, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`BUAA CO profile set to ${picked.profile}.`);
}

function updateStatus(statusBar: vscode.StatusBarItem): void {
  const resource = vscode.window.activeTextEditor?.document.uri;
  const profile = getProfile(resource);
  statusBar.text = `CO: ${profile}`;
  statusBar.tooltip = 'BUAA CO Toolkit - click to check toolchain';
  statusBar.show();
}

function profileDescription(profile: ProjectProfile): string {
  switch (profile) {
    case 'P0':
    case 'P3':
      return 'Logisim';
    case 'P2':
      return 'MIPS ASM';
    case 'P1':
    case 'P4':
    case 'P5':
    case 'P6':
    case 'P7':
      return 'Verilog';
    default:
      return 'Infer where possible';
  }
}

function renderToolchainReport(checks: ToolDetection[]): string {
  const rows = checks.map((check) => {
    const status = check.ok ? 'OK' : 'Missing';
    const suggestion = check.suggestion ?? '';
    return `<tr class="${check.ok ? 'ok' : 'bad'}"><td>${escapeHtml(check.name)}</td><td>${status}</td><td>${escapeHtml(check.detail)}</td><td>${escapeHtml(suggestion)}</td></tr>`;
  }).join('\n');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 8px;
      text-align: left;
      vertical-align: top;
    }
    .ok td:nth-child(2) {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .bad td:nth-child(2) {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
    }
  </style>
</head>
<body>
  <h1>BUAA CO Toolchain</h1>
  <table>
    <thead>
      <tr><th>Tool</th><th>Status</th><th>Path / Version</th><th>Suggestion</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
