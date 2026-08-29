// @index config — co.*设置读取，分层取值+值域裁剪+Python探测缓存
import * as vscode from 'vscode';
import { DELAYED_BRANCHING_PROFILES } from './constants';
import { configDefault, configDefaultArray } from './configDefaults';
import {
  ConcreteProjectProfile,
  ProjectProfile,
  concreteProjectProfiles,
  isConcreteProjectProfile
} from './projectProfile';
import { getLogisimTraceProfileConfig, getProfileName } from './courseConfig';
import { commandResponds, defaultPythonCommand, firstWorkingCommand, pythonCandidates } from './python';
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
  await vscode.workspace.getConfiguration('co', resource).update('project.profile', resolution.effectiveProfile, vscode.ConfigurationTarget.Workspace);
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
  await vscode.workspace.getConfiguration('co').update('project.profile', picked.profile, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`Profile 已设置为 ${picked.profile}`);
  return picked.profile;
}

export function getTopModule(resource?: vscode.Uri): string {
  return layeredGetString('project.topModule', configDefault<string>('project.topModule'), resource);
}

export function getTestbench(resource?: vscode.Uri): string {
  return layeredGetString('project.testbench', configDefault<string>('project.testbench'), resource);
}

export function getMachineCode(resource?: vscode.Uri): string {
  return layeredGetString('project.machineCode', configDefault<string>('project.machineCode'), resource);
}

export function getSimTime(resource?: vscode.Uri): string {
  return layeredGetString('project.simTime', configDefault<string>('project.simTime'), resource);
}

export function getSimBackend(resource?: vscode.Uri): string {
  return layeredGetString('project.simBackend', configDefault<string>('project.simBackend'), resource);
}

export type MipsEngineMode = 'auto' | 'builtin' | 'mars' | 'verify-both';

const mipsEngineModes = new Set<MipsEngineMode>(['auto', 'builtin', 'mars', 'verify-both']);

/**
 * P3-P7 课程汇编器与架构 Oracle 的引擎选择。
 *
 * 配置按 resource 读取，以正确支持 multi-root workspace；旧版或手写 settings
 * 中的非法值统一回退到 auto，避免把不受支持的 provider id 带入运行路径。
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

/**
 * 用户显式配置的 Python 命令（VSCode 设置）。未显式配置时返回
 * undefined，交给 {@link resolvePython} 按平台探测兜底。
 */
export function getConfiguredPython(resource?: vscode.Uri): string | undefined {
  const vsValue = inspectedValue<string>('toolchain.python', resource)?.trim();
  if (vsValue) {
    return vsValue;
  }
  return undefined;
}

/**
 * 同步获取 Python 命令：显式配置优先，否则用平台默认（非 Windows 为 python3）。
 * 用于侧边栏展示等同步场景；执行 Python 工具前应优先用 {@link resolvePython} 探测。
 */
export function getPython(resource?: vscode.Uri): string {
  return getConfiguredPython(resource) ?? defaultPythonCommand();
}

const resolvedPythonCache = new Map<string, string>();

/**
 * 解析实际可用的 Python 命令：
 * 1. 用户显式配置时原样返回（尊重用户意图，不探测）；
 * 2. 否则按平台候选顺序探测，返回首个可用命令并缓存（成功才缓存，失败不缓存以便后续重试）；
 * 3. 全部不可用时回退到平台默认命令，让后续错误信息可读。
 */
export async function resolvePython(resource?: vscode.Uri): Promise<string> {
  const configured = getConfiguredPython(resource);
  if (configured) {
    return configured;
  }
  const candidates = pythonCandidates();
  const key = candidates.join('|');
  const cached = resolvedPythonCache.get(key);
  if (cached) {
    return cached;
  }
  const found = await firstWorkingCommand(candidates, commandResponds);
  if (found) {
    resolvedPythonCache.set(key, found);
    return found;
  }
  return defaultPythonCommand();
}

export function getMarsJar(resource?: vscode.Uri): string {
  const profile = getProfile(resource);
  if (profile === 'P7') {
    const p7 = layeredGetString('toolchain.marsP7', configDefault<string>('toolchain.marsP7'), resource);
    if (p7) { return p7; }
  }
  return layeredGetString('toolchain.mars', configDefault<string>('toolchain.mars'), resource);
}

export function getLogisimJar(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.logisim', configDefault<string>('toolchain.logisim'), resource);
}

export function getIsePath(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.isePath', configDefault<string>('toolchain.isePath'), resource);
}

export function getHazardCalculator(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.hazardCalculator', configDefault<string>('toolchain.hazardCalculator'), resource);
}

export function getRunTimeout(resource?: vscode.Uri): number {
  return config<number>('run.timeoutMs', configDefault<number>('run.timeoutMs'), resource);
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
  const configured = configuredMemoryConfiguration(resource);
  if (configured) {
    return configured;
  }
  return getProfile(resource) === 'P7' ? 'CompactLargeText' : 'FixedCompactLargeText';
}

function configuredMemoryConfiguration(resource?: vscode.Uri): string | undefined {
  const vsValue = inspectedValue<string>('mips.memoryConfiguration', resource)?.trim();
  if (vsValue && vsValue.toLowerCase() !== 'auto') {
    return vsValue;
  }
  return undefined;
}

export function getMipsExtraArgs(resource?: vscode.Uri): string[] {
  return layeredGetArray('mips.extraArgs', configDefaultArray('mips.extraArgs'), resource);
}

export function getGeneratorArgs(resource?: vscode.Uri): string[] {
  return layeredGetArray('test.generatorArgs', [], resource);
}

export function getGeneratedAsmLimit(resource?: vscode.Uri): number {
  const configured = inspectedValue<number>('test.generatedAsmLimit', resource);
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return 100;
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

function layeredGetArray(
  vsKey: string,
  defaultValue: string[],
  resource?: vscode.Uri
): string[] {
  const configured = inspectedValue<string[]>(vsKey, resource);
  if (Array.isArray(configured)) {
    return configured.map((item) => String(item)).filter(Boolean);
  }
  return [...defaultValue];
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
