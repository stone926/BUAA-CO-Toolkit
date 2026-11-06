// @index config — co.*设置读取，分层取值+值域裁剪
import * as vscode from 'vscode';
import * as path from 'path';
import { normalizeProjectOverrides, ProjectScope, resolveProjectOverride } from './projectSettings';
import { normalizePathKey } from './pathUtils';
import { activeProjectResource } from './configurationResource';
import { DELAYED_BRANCHING_PROFILES } from './constants';
import { configDefault } from './configDefaults';
import { OFFICIAL_MARS_MEMORY_CONFIGURATIONS } from './language/mips/legacyMarsPolicy';
import {
  ConcreteProjectProfile,
  ProjectProfile,
  concreteProjectProfiles,
  isConcreteProjectProfile
} from './projectProfile';
import {
  getLogisimTraceProfileConfig,
  getProfileDefaults,
  getProfileName,
  type ProfileDefaults
} from './courseConfig';
import {
  ProfileConfiguredSource,
  ProfileResolution,
  ProfileResolverInput,
  resolveProjectProfile
} from './profileResolver';

/**
 * 配置读取优先级：
 * 1. VSCode Settings (co.*)
 * 2. 默认值
 */

export function config<T>(key: string, fallback: T, resource = activeProjectResource()): T {
  if (key.startsWith('project.') && key !== 'project.overrides') {
    const override = projectOverrideForResource(resource);
    const field = key.slice('project.'.length) as keyof NonNullable<typeof override>;
    if (override?.[field] !== undefined) return override[field] as T;
  }
  const value = vscode.workspace.getConfiguration('co', resource).get<T>(key);
  if (value !== undefined && value !== null) {
    return value;
  }
  return fallback;
}

export type ProfileInferenceProvider = (resource?: vscode.Uri) => Omit<ProfileResolverInput, 'configuredProfile' | 'configuredSource' | 'topModule'>;

let profileInferenceProvider: ProfileInferenceProvider | undefined;
let profileInferenceReady: (() => Promise<void>) | undefined;

export function setProfileInferenceProvider(provider: ProfileInferenceProvider | undefined, whenReady?: () => Promise<void>): void {
  profileInferenceProvider = provider;
  profileInferenceReady = provider ? whenReady : undefined;
}

/** Write resource-scoped settings to the owning folder in multi-root workspaces. */
export function configurationTargetForResource(resource?: vscode.Uri): vscode.ConfigurationTarget {
  return resource && vscode.workspace.getWorkspaceFolder(resource)
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
}

/**
 * 字符串配置读取：VSCode Settings → 默认值。
 */
function layeredGetString(
  vsKey: string,
  defaultValue: string,
  resource?: vscode.Uri
): string {
  const override = projectOverrideForResource(resource ?? activeProjectResource());
  const field = vsKey.slice('project.'.length) as keyof NonNullable<typeof override>;
  const local = override?.[field];
  if (typeof local === 'string' && local.trim()) return local.trim();
  const vsValue = inspectedValue<string>(vsKey, resource);
  if (vsValue && vsValue.trim()) {
    return vsValue.trim();
  }
  return defaultValue;
}

export interface ConfiguredProjectProfile {
  profile: ProjectProfile;
  source: ProfileConfiguredSource;
}

export function getConfiguredProjectProfile(resource = activeProjectResource()): ConfiguredProjectProfile {
  const override = projectOverrideForResource(resource);
  if (override?.profile) return { profile: override.profile, source: 'project' };
  const inspected = vscode.workspace.getConfiguration('co', resource).inspect<ProjectProfile>('project.profile');
  const vsValue = normalizeProjectProfile(
    inspected?.workspaceFolderValue
    ?? inspected?.workspaceValue
    ?? inspected?.globalValue
  );
  if (isConcreteProjectProfile(vsValue)) {
    return { profile: vsValue, source: 'settings' };
  }
  if (vsValue === 'auto') {
    return { profile: 'auto', source: 'settings' };
  }
  return { profile: 'auto', source: 'default' };
}

export function getProfileResolution(resource = activeProjectResource()): ProfileResolution {
  const configured = getConfiguredProjectProfile(resource);
  if (configured.source === 'project' && isConcreteProjectProfile(configured.profile)) {
    return resolveProjectProfile({
      configuredProfile: configured.profile,
      configuredSource: configured.source
    });
  }
  return resolveProjectProfile({
    ...(profileInferenceProvider?.(resource) ?? {}),
    configuredProfile: configured.profile,
    configuredSource: configured.source,
    topModule: layeredGetString('project.topModule', configDefault<string>('project.topModule'), resource)
  });
}

export function getProfile(resource?: vscode.Uri): ProjectProfile {
  const resolution = getProfileResolution(resource);
  return resolution.effectiveProfile ?? resolution.configuredProfile;
}

export async function ensureConcreteProfile(resource = activeProjectResource(), detail?: string): Promise<ConcreteProjectProfile | undefined> {
  await profileInferenceReady?.();
  const resolution = getProfileResolution(resource);
  if (resolution.effectiveProfile) {
    // An inferred stage belongs to this source set, not the whole workspace.
    return resolution.effectiveProfile;
  }
  const picked = await vscode.window.showQuickPick(
    concreteProjectProfiles.map((profile) => ({
      label: profile,
      description: getProfileName(profile),
      profile
    })),
    {
      title: '选择项目 Profile',
      placeHolder: detail ?? '无法自动推断当前项目 Profile，请手动选择'
    }
  );
  if (!picked) {
    return undefined;
  }
  return await setProjectProfile(picked.profile, resource) ? picked.profile : undefined;
}

export function getProjectScopes(resource = activeProjectResource()): readonly ProjectScope[] {
  if (!resource) return [];
  const known = profileInferenceProvider?.(resource)?.projectScopes;
  if (known?.length) return known;
  const folder = vscode.workspace.getWorkspaceFolder(resource);
  if (!folder) return [];
  const rootPath = path.extname(resource.fsPath) ? path.dirname(resource.fsPath) : resource.fsPath;
  return [{ name: path.basename(rootPath), rootPath, workspacePath: folder.uri.fsPath, isolated: true }];
}

function projectOverrideForResource(resource: vscode.Uri | undefined) {
  if (!resource) return undefined;
  const folder = vscode.workspace.getWorkspaceFolder?.(resource);
  if (!folder) return undefined;
  return resolveProjectOverride(vscode.workspace.getConfiguration('co', resource).get('project.overrides'), resource.fsPath, folder.uri.fsPath, profileInferenceProvider?.(resource)?.projectScopes);
}

/** Manual choices target a project anchor; a workspace folder is only a container. */
export async function setProjectProfile(profile: ProjectProfile, resource = activeProjectResource()): Promise<boolean> {
  await profileInferenceReady?.();
  const scopes = getProjectScopes(resource);
  if (!scopes.length) {
    void vscode.window.showErrorMessage('请先打开目标项目的源码文件，再选择项目 Profile。');
    return false;
  }
  const scope = scopes.length === 1 ? scopes[0] : await vscode.window.showQuickPick(
    scopes.map((entry) => ({ label: entry.name, description: entry.rootPath, scope: entry })),
    { title: '此文件由多个项目共享，请选择要修改的项目' }
  ).then((entry) => entry?.scope);
  if (!scope || !resource) return false;
  const relative = path.relative(scope.workspacePath, scope.rootPath).replace(/\\/g, '/') || '.';
  const configuration = vscode.workspace.getConfiguration('co', resource);
  const current = normalizeProjectOverrides(configuration.get('project.overrides'));
  const key = Object.keys(current).find((entry) => normalizePathKey(path.resolve(scope.workspacePath, entry)) === normalizePathKey(scope.rootPath)) ?? relative;
  await configuration.update('project.overrides', { ...current, [key]: { ...current[key], profile } }, configurationTargetForResource(resource));
  void vscode.window.showInformationMessage(`项目 ${scope.name} 的 Profile 已设置为 ${profile}`);
  return true;
}

export function getTopModule(resource?: vscode.Uri): string {
  return layeredGetString(
    'project.topModule',
    configuredProfileDefault('topModule', configDefault<string>('project.topModule'), resource),
    resource
  );
}

export function getTestbench(resource?: vscode.Uri): string {
  return layeredGetString(
    'project.testbench',
    configuredProfileDefault('testbench', configDefault<string>('project.testbench'), resource),
    resource
  );
}

export function getMachineCode(resource?: vscode.Uri): string {
  return layeredGetString(
    'project.machineCode',
    configuredProfileDefault('machineCode', configDefault<string>('project.machineCode'), resource),
    resource
  );
}

export function getSimTime(resource?: vscode.Uri): string {
  return layeredGetString(
    'project.simTime',
    configuredProfileDefault('simTime', configDefault<string>('project.simTime'), resource),
    resource
  );
}

/**
 * A concrete Profile is the user's course-level intent, so its resource catalog
 * supplies project defaults without making the wizard persist four redundant
 * settings. Explicit values at any VS Code scope still win in layeredGetString.
 */
function configuredProfileDefault(
  key: keyof ProfileDefaults,
  fallback: string,
  resource?: vscode.Uri
): string {
  const configured = getProfileResolution(resource).effectiveProfile;
  if (!isConcreteProjectProfile(configured)) {
    return fallback;
  }
  const value = getProfileDefaults(configured)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export type MipsEngineMode = 'auto' | 'builtin' | 'mars' | 'verify-both';

const mipsEngineModes = new Set<MipsEngineMode>(['auto', 'builtin']);

/**
 * P3-P7 课程汇编器与架构 Oracle 的引擎选择。
 *
 * 配置按 resource 读取，以正确支持 multi-root workspace；旧版或手写 settings
 * 中的旧 mars/verify-both 和非法值统一回退到 auto。
 */
export function getMipsEngine(resource?: vscode.Uri): MipsEngineMode {
  const configured = inspectedValue<unknown>('mips.engine', resource);
  const normalized = typeof configured === 'string' ? configured.trim().toLowerCase() : '';
  if (mipsEngineModes.has(normalized as MipsEngineMode)) {
    return normalized as MipsEngineMode;
  }
  return configDefault<MipsEngineMode>('mips.engine');
}

export function useDelayedBranching(resource?: vscode.Uri): boolean {
  const mode = config<string>('mips.delayedBranching', configDefault<string>('mips.delayedBranching'), resource);
  if (mode === 'on') { return true; }
  if (mode === 'off') { return false; }
  const profile = getProfile(resource);
  return DELAYED_BRANCHING_PROFILES.has(profile);
}

export function getJava(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.java', configDefault<string>('toolchain.java'), resource);
}

export function getMarsJar(resource?: vscode.Uri): string {
  // Kept as a migration shim for historical replay/settings readers. Runtime
  // MIPS work no longer consumes a user-configured MARS jar.
  void resource;
  return '';
}

/** Historical setting reader; execution never uses this retired P7 override. */
export function getMarsP7Jar(resource?: vscode.Uri): string {
  void resource;
  return '';
}

export function getLogisimJar(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.logisim', configDefault<string>('toolchain.logisim'), resource);
}

export function getRunTimeout(resource?: vscode.Uri): number {
  const fallback = configDefault<number>('run.timeoutMs');
  const configured = config<number>('run.timeoutMs', fallback, resource);
  // Older installations used 0 for unlimited runs. Use the current operation budget
  // for that retired value (and malformed settings), instead of rejecting every launch.
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 0x7fffffff
    ? configured : fallback;
}

export function showCommandBeforeRun(resource?: vscode.Uri): boolean {
  return config<boolean>('run.showCommandBeforeRun', configDefault<boolean>('run.showCommandBeforeRun'), resource);
}

/**
 * 是否在运行外部工具时自动弹出「输出」面板。默认关闭：输出仍会静默写入通道，
 * 用户可手动打开输出面板查看，避免侧边栏操作频繁抢占编辑器下方空间。
 */
export function shouldRevealOutput(resource?: vscode.Uri): boolean {
  return config<boolean>('run.revealOutput', configDefault<boolean>('run.revealOutput'), resource);
}

export function getMemoryConfiguration(resource?: vscode.Uri): string {
  const configured = inspectedValue<unknown>('mips.memoryConfiguration', resource);
  const normalized = typeof configured === 'string' ? configured.trim().toLowerCase() : '';
  return OFFICIAL_MARS_MEMORY_CONFIGURATIONS.find((value) => value.toLowerCase() === normalized) ?? 'Default';
}

export function getMipsExtraArgs(resource?: vscode.Uri): string[] {
  void resource;
  return [];
}

/** The sole public automatic-test customization. The old key is migration-only. */
/** Snapshot once at session start; malformed settings never create an unbounded pool. */
export function getAutomaticTestConcurrency(resource?: vscode.Uri): number {
  const fallback = configDefault<number>('test.concurrency');
  const value = config<unknown>('test.concurrency', fallback, resource);
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(8, Math.floor(value))) : fallback;
}

export function getAutomaticTestInstructions(resource?: vscode.Uri): string {
  const current = inspectedValue<string>('test.instructions', resource);
  if (typeof current === 'string') {
    return current.trim();
  }
  const legacy = inspectedValue<string>('test.builtinGenerator.instructions', resource)?.trim();
  return legacy || configDefault<string>('test.instructions');
}

export function getLogisimTraceMainCircuit(_resource?: vscode.Uri): string {
  return getLogisimTraceProfileConfig('P3')?.defaultCircuit ?? 'main';
}

export function getLogisimTraceColumns(_resource?: vscode.Uri): Record<string, number> | undefined {
  return undefined;
}

function inspectedValue<T>(key: string, resource = activeProjectResource()): T | undefined {
  const inspected = vscode.workspace.getConfiguration('co', resource).inspect<T>(key);
  return inspected?.workspaceFolderValue
    ?? inspected?.workspaceValue
    ?? inspected?.globalValue;
}

function normalizeProjectProfile(value: unknown): ProjectProfile | undefined {
  return value === 'auto' || isConcreteProjectProfile(value) ? value : undefined;
}
