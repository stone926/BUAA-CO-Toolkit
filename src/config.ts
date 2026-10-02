// @index config — co.*设置读取，分层取值+值域裁剪
import * as vscode from 'vscode';
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

export function config<T>(key: string, fallback: T, resource?: vscode.Uri): T {
  const value = vscode.workspace.getConfiguration('co', resource).get<T>(key);
  if (value !== undefined && value !== null) {
    return value;
  }
  return fallback;
}

export type ProfileInferenceProvider = (resource?: vscode.Uri) => Omit<ProfileResolverInput, 'configuredProfile' | 'configuredSource' | 'topModule'>;

let profileInferenceProvider: ProfileInferenceProvider | undefined;

export function setProfileInferenceProvider(provider: ProfileInferenceProvider | undefined): void {
  profileInferenceProvider = provider;
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

export function getConfiguredProjectProfile(resource?: vscode.Uri): ConfiguredProjectProfile {
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

export function getProfileResolution(resource?: vscode.Uri): ProfileResolution {
  const configured = getConfiguredProjectProfile(resource);
  if (isConcreteProjectProfile(configured.profile)) {
    return resolveProjectProfile({
      configuredProfile: configured.profile,
      configuredSource: configured.source
    });
  }
  return resolveProjectProfile({
    ...(profileInferenceProvider?.(resource) ?? {}),
    configuredProfile: configured.profile,
    configuredSource: configured.source,
    topModule: getTopModule(resource)
  });
}

export function getProfile(resource?: vscode.Uri): ProjectProfile {
  const resolution = getProfileResolution(resource);
  return resolution.effectiveProfile ?? resolution.configuredProfile;
}

export async function persistInferredProfile(resource?: vscode.Uri): Promise<ConcreteProjectProfile | undefined> {
  const resolution = getProfileResolution(resource);
  if (resolution.configuredProfile !== 'auto' || resolution.source !== 'inferred' || !resolution.effectiveProfile) {
    return resolution.effectiveProfile;
  }
  await vscode.workspace.getConfiguration('co', resource).update(
    'project.profile',
    resolution.effectiveProfile,
    configurationTargetForResource(resource)
  );
  return resolution.effectiveProfile;
}

export async function ensureConcreteProfile(resource?: vscode.Uri, detail?: string): Promise<ConcreteProjectProfile | undefined> {
  const resolution = getProfileResolution(resource);
  if (resolution.effectiveProfile) {
    await persistInferredProfile(resource);
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
  await vscode.workspace.getConfiguration('co', resource).update(
    'project.profile',
    picked.profile,
    configurationTargetForResource(resource)
  );
  vscode.window.showInformationMessage(`Profile 已设置为 ${picked.profile}`);
  return picked.profile;
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
  const configured = getConfiguredProjectProfile(resource).profile;
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

function inspectedValue<T>(key: string, resource?: vscode.Uri): T | undefined {
  const inspected = vscode.workspace.getConfiguration('co', resource).inspect<T>(key);
  return inspected?.workspaceFolderValue
    ?? inspected?.workspaceValue
    ?? inspected?.globalValue;
}

function normalizeProjectProfile(value: unknown): ProjectProfile | undefined {
  return value === 'auto' || isConcreteProjectProfile(value) ? value : undefined;
}
