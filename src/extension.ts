import * as vscode from 'vscode';
import { getProfile } from './config';
import { startLanguageServer, stopLanguageServer } from './languageClient';
import { registerLogisim } from './logisim';
import { registerMips } from './mips';
import { clearProjectConfigCache } from './projectConfig';
import { CoSidebarProvider } from './sidebar';
import { checkToolchain } from './toolchain';
import { AppServices, ProjectProfile, ToolDetection } from './types';
import { registerVerilog } from './verilog';
import { runProjectWizard } from './wizard';

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

  // Watch .co/config.json changes
  const configWatcher = vscode.workspace.createFileSystemWatcher('**/.co/config.json');
  configWatcher.onDidChange(() => {
    clearProjectConfigCache();
    sidebarProvider.refresh();
  });
  configWatcher.onDidCreate(() => {
    clearProjectConfigCache();
    sidebarProvider.refresh();
  });
  configWatcher.onDidDelete(() => {
    clearProjectConfigCache();
    sidebarProvider.refresh();
  });
  context.subscriptions.push(configWatcher);

  // Register refresh command for sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('co.sidebar.refresh', () => sidebarProvider.refresh())
  );

  registerMips(context, services);
  registerVerilog(context, services);
  registerLogisim(context, services);

  // Cache toolchain status
  let cachedToolchain: ToolDetection[] | undefined;
  let toolchainCacheTime = 0;
  const TOOLCHAIN_CACHE_TTL = 60000; // 1 minute

  async function getToolchainStatus(): Promise<ToolDetection[]> {
    const now = Date.now();
    if (cachedToolchain && now - toolchainCacheTime < TOOLCHAIN_CACHE_TTL) {
      return cachedToolchain;
    }
    const resource = vscode.window.activeTextEditor?.document.uri;
    cachedToolchain = await checkToolchain(output, resource);
    toolchainCacheTime = now;
    sidebarProvider.refresh();
    return cachedToolchain;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('co.checkToolchain', () => showToolchainReport(output)),
    vscode.commands.registerCommand('co.selectProjectProfile', () => selectProjectProfile()),
    vscode.commands.registerCommand('co.projectWizard', () => runProjectWizard()),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatus(statusBar, getToolchainStatus)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('co.project.profile') || event.affectsConfiguration('co.toolchain')) {
        cachedToolchain = undefined; // Invalidate cache
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

function updateStatus(statusBar: vscode.StatusBarItem, getToolchainStatus?: () => Promise<ToolDetection[]>): void {
  const resource = vscode.window.activeTextEditor?.document.uri;
  const profile = getProfile(resource);
  statusBar.text = `CO: ${profile}`;
  statusBar.tooltip = 'BUAA CO Toolkit - click to check toolchain';
  statusBar.show();

  // Update with toolchain info asynchronously
  if (getToolchainStatus) {
    getToolchainStatus().then((checks) => {
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
