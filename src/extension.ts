import * as vscode from 'vscode';
import { getProfileResolution, setProfileInferenceProvider } from './config';
import {
  diagnosticCodeKey,
  diagnosticFileCodeKey,
  diagnosticCodeToString,
  disableDiagnosticCodeCommand,
  defaultCoSettings
} from './language/common/settings';
import { startLanguageServer, stopLanguageServer } from './languageClient';
import { registerLogisim } from './logisim';
import { registerMips } from './mips';
import { CoSidebarProvider } from './sidebar';
import { checkToolchain } from './toolchain';
import { AppServices, ProjectProfile, ToolDetection } from './types';
import { registerVerilog } from './verilog';
import { registerVerilogSignalView } from './verilogSignalView';
import { WorkspaceModuleRegistry } from './language/verilog/workspaceModuleRegistry';
import { runProjectWizard } from './wizard';
import { registerHazard } from './hazard';
import { registerTraceCompare } from './traceCompare';
import { registerCourseTest } from './courseTest';
import { registerCourseLinks } from './courseLinks';
import { registerSemanticColorDefaults } from './semanticColors';
import { buildProfileInferenceInput, clearProfileInferenceCache, onDidChangeProfileInferenceCache } from './profileInference';
import { activeKindForDocument, registerAdvancedTools } from './advancedTools';
import { escapeHtml } from './language/common/util';

export function activate(context: vscode.ExtensionContext): void {
  startLanguageServer(context);

  const output = vscode.window.createOutputChannel('BUAA CO Toolkit');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'co.checkToolchain';
  context.subscriptions.push(output, statusBar);

  const services: AppServices = {
    output,
    statusBar
  };

  registerSemanticColorDefaults(context, output);

  // Register sidebar
  const sidebarProvider = new CoSidebarProvider(context);
  const sidebarView = vscode.window.registerTreeDataProvider('coSidebar', sidebarProvider);
  context.subscriptions.push(sidebarView);

  // Cache toolchain status per resource so multi-root settings do not leak across projects.
  const toolchainCache = new Map<string, { checks: ToolDetection[]; timestamp: number }>();
  const TOOLCHAIN_CACHE_TTL = 60000; // 1 minute
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    }
  });

  // Register refresh command for sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('co.sidebar.refresh', () => scheduleRefreshProjectUi())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(disableDiagnosticCodeCommand, (languageId?: string, code?: string, documentUri?: string) => disableDiagnosticCode(languageId, code, documentUri))
  );

  // 工作空间模块注册表：后台解析所有 .v 文件，供 sidebar 连线分析跨文件查找模块
  const moduleRegistry = new WorkspaceModuleRegistry();
  setProfileInferenceProvider((resource) => buildProfileInferenceInput(resource, moduleRegistry));
  context.subscriptions.push({ dispose: () => setProfileInferenceProvider(undefined) });
  moduleRegistry.activate();
  context.subscriptions.push(moduleRegistry);
  context.subscriptions.push(moduleRegistry.onDidChange(() => {
    invalidateToolchainCache();
    scheduleRefreshProjectUi();
  }));
  context.subscriptions.push(onDidChangeProfileInferenceCache(() => {
    scheduleRefreshProjectUi();
  }));
  // 监听文件保存事件，增量更新注册表
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'verilog') {
        moduleRegistry.updateDocument(doc);
      }
    })
  );
  const verilogWatcher = vscode.workspace.createFileSystemWatcher('**/*.v');
  context.subscriptions.push(
    verilogWatcher,
    verilogWatcher.onDidCreate((uri) => {
      clearProfileInferenceCache();
      invalidateToolchainCache();
      moduleRegistry.updateUri(uri);
    }),
    verilogWatcher.onDidChange((uri) => {
      clearProfileInferenceCache();
      invalidateToolchainCache();
      moduleRegistry.updateUri(uri);
    }),
    verilogWatcher.onDidDelete((uri) => {
      clearProfileInferenceCache();
      invalidateToolchainCache();
      moduleRegistry.removeUri(uri);
    })
  );
  const profileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{asm,s,mips,circ}');
  context.subscriptions.push(
    profileWatcher,
    profileWatcher.onDidCreate(() => {
      clearProfileInferenceCache();
      invalidateToolchainCache();
      scheduleRefreshProjectUi();
    }),
    profileWatcher.onDidChange(() => {
      clearProfileInferenceCache();
      invalidateToolchainCache();
      scheduleRefreshProjectUi();
    }),
    profileWatcher.onDidDelete(() => {
      clearProfileInferenceCache();
      invalidateToolchainCache();
      scheduleRefreshProjectUi();
    })
  );

  registerMips(context, services);
  registerVerilog(context, services, moduleRegistry);
  registerVerilogSignalView(context, moduleRegistry);
  registerLogisim(context, services);
  registerHazard(context, services);
  registerTraceCompare(context, services);
  registerCourseTest(context, services);
  registerCourseLinks(context);
  registerAdvancedTools(context);

  function cachedToolchainStatus(resource = vscode.window.activeTextEditor?.document.uri): ToolDetection[] | undefined {
    const now = Date.now();
    const key = toolchainCacheKey(resource);
    const cached = toolchainCache.get(key);
    if (cached && now - cached.timestamp < TOOLCHAIN_CACHE_TTL) {
      return cached.checks;
    }
    return undefined;
  }

  function invalidateToolchainCache(): void {
    toolchainCache.clear();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('co.checkToolchain', async () => {
      const resource = vscode.window.activeTextEditor?.document.uri;
      const checks = await showToolchainReport(output);
      toolchainCache.set(toolchainCacheKey(resource), { checks, timestamp: Date.now() });
      scheduleRefreshProjectUi(resource);
    }),
    vscode.commands.registerCommand('co.selectProjectProfile', () => selectProjectProfile()),
    vscode.commands.registerCommand('co.projectWizard', () => runProjectWizard()),
    vscode.window.onDidChangeActiveTextEditor(() => {
      scheduleRefreshProjectUi();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('co')) {
        clearProfileInferenceCache();
        invalidateToolchainCache();
        scheduleRefreshProjectUi();
      }
    })
  );

  function scheduleRefreshProjectUi(resource = vscode.window.activeTextEditor?.document.uri): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refreshProjectUi(resource);
    }, 300);
  }

  function refreshProjectUi(resource = vscode.window.activeTextEditor?.document.uri): void {
    updateCoContext(resource);
    sidebarProvider.refresh();
    updateStatus(statusBar, cachedToolchainStatus);
  }

  refreshProjectUi();
}

function updateCoContext(resource?: vscode.Uri): void {
  const resolution = getProfileResolution(resource);
  const profile = resolution.effectiveProfile ?? resolution.configuredProfile;
  const rawActiveKind = activeKindForDocument(vscode.window.activeTextEditor?.document);
  const hasConcreteProfile = Boolean(resolution.effectiveProfile);
  const hasTraceProfile = ['P3', 'P4', 'P5', 'P6', 'P7'].includes(profile);
  const hasVerilogProfile = ['P1', 'P4', 'P5', 'P6', 'P7'].includes(profile);
  const activeKind = rawActiveKind === 'verilog' && !hasVerilogProfile ? 'other' : rawActiveKind;
  void vscode.commands.executeCommand('setContext', 'co.profile', profile);
  void vscode.commands.executeCommand('setContext', 'co.hasConcreteProfile', hasConcreteProfile);
  void vscode.commands.executeCommand('setContext', 'co.hasTraceProfile', hasTraceProfile);
  void vscode.commands.executeCommand('setContext', 'co.hasVerilogProfile', hasVerilogProfile);
  void vscode.commands.executeCommand('setContext', 'co.activeCoKind', activeKind);
  void vscode.commands.executeCommand('setContext', 'co.verilogSignalVisible', activeKind === 'verilog');
}

export async function deactivate(): Promise<void> {
  await stopLanguageServer();
}

async function showToolchainReport(output: vscode.OutputChannel): Promise<ToolDetection[]> {
  output.appendLine('正在检查 CO 工具链...');
  const resource = vscode.window.activeTextEditor?.document.uri;
  const checks = await checkToolchain(output, resource, { promptForProfile: true });
  output.appendLine('');
  for (const check of checks) {
    output.appendLine(`${check.ok ? 'OK' : '缺失'} ${check.name}: ${check.detail}`);
    if (check.suggestion) {
      output.appendLine(`  建议: ${check.suggestion}`);
    }
  }

  const panel = vscode.window.createWebviewPanel('coToolchainReport', 'CO 工具链', vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  panel.webview.html = renderToolchainReport(checks);
  return checks;
}

async function selectProjectProfile(): Promise<void> {
  const profiles: ProjectProfile[] = ['auto', 'P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
  const resolution = getProfileResolution(vscode.window.activeTextEditor?.document.uri);
  const current = resolution.configuredProfile;
  const picked = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile,
      description: profile === current ? currentProfileDescription(profile, resolution) : profileDescription(profile),
      profile
    })),
    {
      title: '选择项目 Profile'
    }
  );
  if (!picked) {
    return;
  }
  await vscode.workspace.getConfiguration('co').update('project.profile', picked.profile, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`Profile 已设置为 ${picked.profile}`);
}

async function disableDiagnosticCode(languageId?: string, code?: string, documentUri?: string): Promise<void> {
  const normalizedLanguageId = typeof languageId === 'string' ? languageId.trim().toLowerCase() : '';
  const normalizedCode = diagnosticCodeToString(code);
  if (!normalizedLanguageId || !normalizedCode) {
    vscode.window.showErrorMessage('无法禁用此诊断，因为其代码无效');
    return;
  }
  const config = vscode.workspace.getConfiguration('co');
  if (typeof documentUri === 'string' && documentUri.trim()) {
    const key = diagnosticFileCodeKey(normalizedLanguageId, normalizedCode, documentUri);
    const current = config.get<string[]>('diagnostics.disabledFileCodes', defaultCoSettings.diagnostics.disabledFileCodes);
    const merged = [...new Set([...current.map((item) => item.trim()).filter(Boolean), key])].sort();
    await config.update('diagnostics.disabledFileCodes', merged, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`已在当前工作区中对该文件禁用 ${normalizedCode} 诊断`);
    return;
  }

  const key = diagnosticCodeKey(normalizedLanguageId, normalizedCode);
  const current = config.get<string[]>('diagnostics.disabledCodes', defaultCoSettings.diagnostics.disabledCodes);
  const merged = [...new Set([...current.map((item) => item.trim().toLowerCase()).filter(Boolean), key])].sort();
  await config.update('diagnostics.disabledCodes', merged, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`已在当前工作区中禁用 ${normalizedCode} 诊断`);
}

function updateStatus(statusBar: vscode.StatusBarItem, getToolchainStatus?: (resource?: vscode.Uri) => ToolDetection[] | undefined): void {
  const resource = vscode.window.activeTextEditor?.document.uri;
  const profileText = statusProfileText(resource);
  statusBar.text = `CO: ${profileText}`;
  statusBar.tooltip = 'BUAA CO Toolkit - 点击检查工具链';
  statusBar.show();

  if (getToolchainStatus) {
    const checks = getToolchainStatus(resource);
    if (checks && sameResource(resource, vscode.window.activeTextEditor?.document.uri)) {
      const toolStatus = checks
        .filter((check) => ['MARS', 'ISE fuse', 'Logisim'].includes(check.name))
        .map((check) => `${check.name} ${check.ok ? 'OK' : '✗'}`)
        .join(' | ');
      if (toolStatus) {
        statusBar.text = `CO: ${profileText} | ${toolStatus}`;
      }
    }
  }
}

function toolchainCacheKey(resource?: vscode.Uri): string {
  const folder = resource
    ? vscode.workspace.getWorkspaceFolder(resource)
    : vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.toString() ?? 'global';
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
      return '自动推断；无法推断时要求选择';
  }
}

function currentProfileDescription(profile: ProjectProfile, resolution: ReturnType<typeof getProfileResolution>): string {
  if (profile !== 'auto') {
    return '当前';
  }
  return resolution.effectiveProfile
    ? `当前，已推断为 ${resolution.effectiveProfile}`
    : '当前，无法推断时会要求选择';
}

function statusProfileText(resource?: vscode.Uri): string {
  const resolution = getProfileResolution(resource);
  if (resolution.effectiveProfile) {
    return resolution.source === 'inferred'
      ? `${resolution.effectiveProfile} (auto)`
      : resolution.effectiveProfile;
  }
  return '选择 Profile';
}

function renderToolchainReport(checks: ToolDetection[]): string {
  const rows = checks.map((check) => {
    const status = check.ok ? '正常' : '缺失';
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
  <h1>CO 工具链</h1>
  <table>
    <thead>
      <tr><th>工具</th><th>状态</th><th>路径 / 版本</th><th>建议</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
}
