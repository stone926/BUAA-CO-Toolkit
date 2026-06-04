import * as vscode from 'vscode';
import { getProfile } from './config';
import {
  diagnosticCodeKey,
  diagnosticCodeToString,
  disableDiagnosticCodeCommand,
  defaultCoSettings
} from './language/common/settings';
import { startLanguageServer, stopLanguageServer } from './languageClient';
import { registerLogisim } from './logisim';
import { registerMips } from './mips';
import { clearProjectConfigCache } from './projectConfig';
import { CoSidebarProvider } from './sidebar';
import { checkToolchain } from './toolchain';
import { AppServices, ProjectProfile, ToolDetection } from './types';
import { registerVerilog } from './verilog';
import { runProjectWizard } from './wizard';
import { registerHazard } from './hazard';
import { registerTraceCompare } from './traceCompare';
import { registerCourseTest } from './courseTest';

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

  // Register sidebar
  const sidebarProvider = new CoSidebarProvider(context);
  const sidebarView = vscode.window.registerTreeDataProvider('coSidebar', sidebarProvider);
  context.subscriptions.push(sidebarView);

  // Cache toolchain status per resource so multi-root and .co/config.json overrides do not leak across projects.
  const toolchainCache = new Map<string, { checks: ToolDetection[]; timestamp: number }>();
  const TOOLCHAIN_CACHE_TTL = 60000; // 1 minute

  // Watch .co/config.json changes
  const configWatcher = vscode.workspace.createFileSystemWatcher('**/.co/config.json');
  configWatcher.onDidChange(() => {
    clearProjectConfigCache();
    invalidateToolchainCache();
    sidebarProvider.refresh();
    updateStatus(statusBar, getToolchainStatus);
  });
  configWatcher.onDidCreate(() => {
    clearProjectConfigCache();
    invalidateToolchainCache();
    sidebarProvider.refresh();
    updateStatus(statusBar, getToolchainStatus);
  });
  configWatcher.onDidDelete(() => {
    clearProjectConfigCache();
    invalidateToolchainCache();
    sidebarProvider.refresh();
    updateStatus(statusBar, getToolchainStatus);
  });
  context.subscriptions.push(configWatcher);

  // Register refresh command for sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('co.sidebar.refresh', () => sidebarProvider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(disableDiagnosticCodeCommand, (languageId?: string, code?: string) => disableDiagnosticCode(languageId, code))
  );

  registerMips(context, services);
  registerVerilog(context, services);
  registerLogisim(context, services);
  registerHazard(context, services);
  registerTraceCompare(context, services);
  registerCourseTest(context, services);

  async function getToolchainStatus(resource = vscode.window.activeTextEditor?.document.uri): Promise<ToolDetection[]> {
    const now = Date.now();
    const key = toolchainCacheKey(resource);
    const cached = toolchainCache.get(key);
    if (cached && now - cached.timestamp < TOOLCHAIN_CACHE_TTL) {
      return cached.checks;
    }
    const checks = await checkToolchain(output, resource);
    toolchainCache.set(key, { checks, timestamp: now });
    sidebarProvider.refresh();
    return checks;
  }

  function invalidateToolchainCache(): void {
    toolchainCache.clear();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('co.checkToolchain', () => showToolchainReport(output)),
    vscode.commands.registerCommand('co.selectProjectProfile', () => selectProjectProfile()),
    vscode.commands.registerCommand('co.projectWizard', () => runProjectWizard()),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatus(statusBar, getToolchainStatus)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('co.project.profile') || event.affectsConfiguration('co.toolchain')) {
        invalidateToolchainCache();
        updateStatus(statusBar, getToolchainStatus);
        sidebarProvider.refresh();
      }
    })
  );

  updateStatus(statusBar, getToolchainStatus);
}

export async function deactivate(): Promise<void> {
  await stopLanguageServer();
}

async function showToolchainReport(output: vscode.OutputChannel): Promise<void> {
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

async function disableDiagnosticCode(languageId?: string, code?: string): Promise<void> {
  const normalizedLanguageId = typeof languageId === 'string' ? languageId.trim().toLowerCase() : '';
  const normalizedCode = diagnosticCodeToString(code);
  if (!normalizedLanguageId || !normalizedCode) {
    vscode.window.showErrorMessage('Cannot suppress this diagnostic because its code is invalid.');
    return;
  }
  const key = diagnosticCodeKey(normalizedLanguageId, normalizedCode);
  const config = vscode.workspace.getConfiguration('co');
  const current = config.get<string[]>('diagnostics.disabledCodes', defaultCoSettings.diagnostics.disabledCodes);
  const merged = [...new Set([...current.map((item) => item.trim().toLowerCase()).filter(Boolean), key])].sort();
  await config.update('diagnostics.disabledCodes', merged, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`Suppressed ${normalizedCode} diagnostics in this workspace.`);
}

function updateStatus(statusBar: vscode.StatusBarItem, getToolchainStatus?: (resource?: vscode.Uri) => Promise<ToolDetection[]>): void {
  const resource = vscode.window.activeTextEditor?.document.uri;
  const profile = getProfile(resource);
  statusBar.text = `CO: ${profile}`;
  statusBar.tooltip = 'BUAA CO Toolkit - click to check toolchain';
  statusBar.show();

  // Update with toolchain info asynchronously
  if (getToolchainStatus) {
    getToolchainStatus(resource).then((checks) => {
      if (!sameResource(resource, vscode.window.activeTextEditor?.document.uri)) {
        return;
      }
      const toolStatus = checks
        .filter((check) => ['MARS', 'ISE fuse', 'Logisim'].includes(check.name))
        .map((check) => `${check.name} ${check.ok ? 'OK' : '✗'}`)
        .join(' | ');
      if (toolStatus) {
        statusBar.text = `CO: ${profile} | ${toolStatus}`;
      }
    }).catch(() => {
      // Keep the basic status if toolchain check fails
    });
  }
}

function toolchainCacheKey(resource?: vscode.Uri): string {
  return resource?.toString() ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? 'global';
}

function sameResource(left?: vscode.Uri, right?: vscode.Uri): boolean {
  return (left?.toString() ?? '') === (right?.toString() ?? '');
}

function profileDescription(profile: ProjectProfile): string {
  switch (profile) {
    case 'P0':
      return '初识 Logisim';
    case 'P1':
      return '初识 Verilog';
    case 'P2':
      return '初识 ASM';
    case 'P3':
      return 'Logisim 单周期 CPU';
    case 'P4':
      return 'Verilog 单周期 CPU';
    case 'P5':
      return 'Verilog 五级流水线（阻塞+转发）';
    case 'P6':
      return '流水线 + 乘除法 + 外置存储器';
    case 'P7':
      return 'MIPS 微系统（异常+外设）';
    default:
      return '自动推断';
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
