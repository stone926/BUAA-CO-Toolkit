// @index entry — activate()入口，注册全部命令/UI/FileWatcher
import * as vscode from 'vscode';
import { languageFileGlob, languageIds } from './language/languageRegistry';
import {
  Commands,
  ALL_PROFILES,
  TRACE_CONTEXT_PROFILES,
  VERILOG_CONTEXT_PROFILES
} from './constants';
import {
  configurationTargetForResource,
  getProfileResolution,
  setProfileInferenceProvider
} from './config';
import {
  disableDiagnosticCodeCommand
} from './language/common/settings';
import { startLanguageServer, stopLanguageServer } from './languageClient';
import { registerLogisim } from './logisim';
import { registerMips } from './mips';
import { registerMipsAssemblyCommands } from './mipsCommands';
import { MipsRuntimeManager } from './mips/host/runtimeManager';
import { CoSidebarProvider } from './sidebar';
import { checkToolchain } from './toolchain';
import { AppServices, ProjectProfile, ToolDetection } from './types';
import { registerVerilog } from './verilog';
import { registerVerilogSignalView } from './verilogSignalView';
import { registerWaveform } from './waveform/waveform';
import { WorkspaceModuleRegistry } from './language/verilog/workspaceModuleRegistry';
import { runProjectWizard } from './wizard';
import { registerHazard } from './hazard';
import { registerCourseTest } from './courseTest';
import { buildProfileInferenceInput, clearProfileInferenceCache, onDidChangeProfileInferenceCache } from './profileInference';
import { activeKindForDocument, registerAdvancedTools } from './advancedTools';
import { getProfileName } from './courseConfig';
import { renderToolchainReport } from './webview/toolchainReport';
import { timeStartup, traceStartup } from './startupTrace';
import { migrateLegacySemanticColorRules } from './legacySemanticColorMigration';
import { disableDiagnosticCode } from './diagnosticSettings';
import {
  clearVerilogProjectDiscoveryCache,
  invalidateVerilogProjectDiscoveryCachesForUri
} from './verilog/verilogProject';

const verilogModuleRegistryStartupDelayMs = 1000;

export function activate(context: vscode.ExtensionContext): void {
  const finishActivateTrace = timeStartup('extension.activate');
  const output = vscode.window.createOutputChannel('BUAA CO Toolkit');
  traceStartup('extension.activate begin', output);
  startLanguageServer(context, output);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = Commands.CheckToolchain;
  context.subscriptions.push(output, statusBar);

  const mipsRuntime = new MipsRuntimeManager();

  const services: AppServices = {
    output,
    statusBar,
    extensionRoot: context.extensionUri.fsPath,
    mipsRuntime
  };

  void migrateLegacySemanticColorRules(context, output);

  // Register sidebar
  const sidebarProvider = new CoSidebarProvider();
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
    vscode.commands.registerCommand(Commands.SidebarRefresh, () => scheduleRefreshProjectUi())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(disableDiagnosticCodeCommand, disableDiagnosticCode)
  );

  // 工作空间模块注册表：后台解析所有 .v/.vh 文件，供 sidebar 连线分析跨文件查找模块
  const moduleRegistry = new WorkspaceModuleRegistry({
    initialScanDelayMs: verilogModuleRegistryStartupDelayMs
  });
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
      if (doc.languageId === languageIds.verilog) {
        moduleRegistry.updateDocument(doc);
      }
    })
  );
  const verilogWatcher = vscode.workspace.createFileSystemWatcher(languageFileGlob([languageIds.verilog]));
  context.subscriptions.push(
    verilogWatcher,
    verilogWatcher.onDidCreate((uri) => {
      invalidateVerilogProjectDiscovery(uri);
      clearProfileInferenceCache();
      invalidateToolchainCache();
      void moduleRegistry.updateUriAsync(uri);
    }),
    verilogWatcher.onDidChange((uri) => {
      invalidateVerilogProjectDiscovery(uri);
      invalidateToolchainCache();
      // The registry compares content after the async read, so save echoes are
      // skipped while external edits to an open file are still indexed.
      void moduleRegistry.updateUriAsync(uri);
    }),
    verilogWatcher.onDidDelete((uri) => {
      invalidateVerilogProjectDiscovery(uri);
      clearProfileInferenceCache();
      invalidateToolchainCache();
      moduleRegistry.removeUri(uri);
    })
  );
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    // Folder changes are infrequent. A full in-memory clear also covers a root
    // removed, edited while detached, then re-added at the same path.
    clearVerilogProjectDiscoveryCache();
  }));
  const profileWatcher = vscode.workspace.createFileSystemWatcher(languageFileGlob([languageIds.mips, languageIds.logisim]));
  context.subscriptions.push(
    profileWatcher,
    profileWatcher.onDidCreate(() => {
      clearProfileInferenceCache();
      invalidateToolchainCache();
      scheduleRefreshProjectUi();
    }),
    profileWatcher.onDidChange(() => {
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
  registerMipsAssemblyCommands(context, services);
  // Lazy worker host: construction only; the worker starts on first builtin
  // assemble/execute and is shared by every provider through AppServices.
  context.subscriptions.push(mipsRuntime);
  registerVerilog(context, services, moduleRegistry);
  registerVerilogSignalView(context, moduleRegistry);
  registerWaveform(context, services, moduleRegistry);
  registerLogisim(context, services);
  registerHazard(context, services);
  registerCourseTest(context, services);
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

  function invalidateVerilogProjectDiscovery(uri: vscode.Uri): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      clearVerilogProjectDiscoveryCache();
      return;
    }
    invalidateVerilogProjectDiscoveryCachesForUri(folders, uri);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.CheckToolchain, async () => {
      const resource = vscode.window.activeTextEditor?.document.uri;
      const checks = await showToolchainReport(output, services.extensionRoot);
      toolchainCache.set(toolchainCacheKey(resource), { checks, timestamp: Date.now() });
      scheduleRefreshProjectUi(resource);
    }),
    vscode.commands.registerCommand(Commands.SelectProjectProfile, () => selectProjectProfile()),
    vscode.commands.registerCommand(Commands.ProjectWizard, () => runProjectWizard()),
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
  finishActivateTrace();
}

function updateCoContext(resource?: vscode.Uri): void {
  const resolution = getProfileResolution(resource);
  const profile = resolution.effectiveProfile ?? resolution.configuredProfile;
  const rawActiveKind = activeKindForDocument(vscode.window.activeTextEditor?.document);
  const hasConcreteProfile = Boolean(resolution.effectiveProfile);
  const hasTraceProfile = TRACE_CONTEXT_PROFILES.has(profile);
  const hasVerilogProfile = VERILOG_CONTEXT_PROFILES.has(profile);
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

async function showToolchainReport(output: vscode.OutputChannel, extensionRoot?: string): Promise<ToolDetection[]> {
  output.appendLine('正在检查 CO 工具链...');
  const resource = vscode.window.activeTextEditor?.document.uri;
  const checks = await checkToolchain(output, resource, { promptForProfile: true, extensionRoot });
  output.appendLine('');
  for (const check of checks) {
    output.appendLine(`${check.ok ? 'OK' : '缺失'} ${check.name}: ${check.detail}`);
    if (check.suggestion) {
      output.appendLine(`  建议: ${check.suggestion}`);
    }
  }

  const panel = vscode.window.createWebviewPanel('coToolchainReport', 'CO 工具链', vscode.ViewColumn.Beside, {
    enableScripts: false,
    enableFindWidget: true
  });
  panel.webview.html = renderToolchainReport(checks);
  return checks;
}

async function selectProjectProfile(): Promise<void> {
  const profiles: ProjectProfile[] = [...ALL_PROFILES];
  const resource = vscode.window.activeTextEditor?.document.uri;
  const resolution = getProfileResolution(resource);
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
  await vscode.workspace.getConfiguration('co', resource).update(
    'project.profile',
    picked.profile,
    configurationTargetForResource(resource)
  );
  vscode.window.showInformationMessage(`Profile 已设置为 ${picked.profile}`);
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
        .filter((check) => ['Verilog simulator', 'Logisim'].includes(check.name))
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
  return profile === 'auto' ? '自动推断；无法推断时要求选择' : getProfileName(profile);
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
