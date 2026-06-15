import * as vscode from 'vscode';
import {
  ConcreteProjectProfile,
  ProjectProfile,
  concreteProjectProfiles,
  isConcreteProjectProfile
} from './projectProfile';
import { getProfileName } from './courseConfig';
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
  return layeredGetString('project.topModule', 'mips', resource);
}

export function getTestbench(resource?: vscode.Uri): string {
  return layeredGetString('project.testbench', 'mips_tb', resource);
}

export function getMachineCode(resource?: vscode.Uri): string {
  return layeredGetString('project.machineCode', 'code.txt', resource);
}

export function getSimTime(resource?: vscode.Uri): string {
  return layeredGetString('project.simTime', '200us', resource);
}

export function getSimBackend(resource?: vscode.Uri): string {
  return layeredGetString('project.simBackend', 'isim', resource);
}

export function useDelayedBranching(resource?: vscode.Uri): boolean {
  const mode = config<string>('mips.delayedBranching', 'profile', resource);
  if (mode === 'on') { return true; }
  if (mode === 'off') { return false; }
  const profile = getProfile(resource);
  return profile === 'P5' || profile === 'P6' || profile === 'P7';
}

export function getJava(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.java', 'java', resource);
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
    const p7 = layeredGetString('toolchain.marsP7', '', resource);
    if (p7) { return p7; }
  }
  return layeredGetString('toolchain.mars', '', resource);
}

export function getLogisimJar(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.logisim', '', resource);
}

export function getIsePath(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.isePath', '', resource);
}

export function getHazardCalculator(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.hazardCalculator', '', resource);
}

export function getTutorialRoot(resource?: vscode.Uri): string {
  return layeredGetString('course.tutorialRoot', '', resource);
}

export function getRunTimeout(resource?: vscode.Uri): number {
  return config<number>('run.timeoutMs', 120000, resource);
}

export function showCommandBeforeRun(resource?: vscode.Uri): boolean {
  return config<boolean>('run.showCommandBeforeRun', false, resource);
}

/**
 * 是否在运行外部工具时自动弹出「输出」面板。默认关闭：输出仍会静默写入通道，
 * 用户可手动打开输出面板查看，避免侧边栏操作频繁抢占编辑器下方空间。
 */
export function shouldRevealOutput(resource?: vscode.Uri): boolean {
  return config<boolean>('run.revealOutput', false, resource);
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
  return layeredGetArray('mips.extraArgs', [], resource);
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

export function useBuiltinTestGenerator(resource?: vscode.Uri): boolean {
  const configured = inspectedValue<boolean>('test.builtinGenerator.enabled', resource);
  if (typeof configured === 'boolean') {
    return configured;
  }
  return true;
}

export function getBuiltinGeneratorInstructions(resource?: vscode.Uri): string {
  return layeredGetString(
    'test.builtinGenerator.instructions',
    '',
    resource
  );
}

export function getBuiltinGeneratorInstructionCount(resource?: vscode.Uri): number {
  const configured = inspectedValue<number>('test.builtinGenerator.instructionCount', resource);
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return 4000;
}

export function getBuiltinGeneratorP7InstructionCount(resource?: vscode.Uri): number {
  const configured = inspectedValue<number>('test.builtinGenerator.p7InstructionCount', resource);
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.floor(configured), 1118);
  }
  return 1118;
}

export function getContinuousIntervalMs(resource?: vscode.Uri): number {
  return positiveIntegerConfig('test.continuousIntervalMs', 1000, resource);
}

export function getContinuousMaxIterations(resource?: vscode.Uri): number {
  return nonNegativeIntegerConfig('test.continuousMaxIterations', 0, resource);
}

export function getContinuousStopOnFailure(resource?: vscode.Uri): boolean {
  return config<boolean>('test.continuousStopOnFailure', true, resource);
}

export function getLogisimTraceMainCircuit(resource?: vscode.Uri): string {
  return layeredGetString(
    'test.logisim.mainCircuit',
    'main',
    resource
  );
}

export function getLogisimTraceColumns(resource?: vscode.Uri): Record<string, number> | undefined {
  const configured = inspectedValue<Record<string, unknown>>('test.logisim.traceColumns', resource);
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    return undefined;
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(configured)) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      result[key.trim().toLowerCase()] = value;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * P7 自动对拍是否注入外部中断（macroscopic_pc == target_pc 触发）。
 * 关闭时退化为纯异常/正常数据通路对拍（完全确定性）。
 */
export function getP7InterruptEnabled(resource?: vscode.Uri): boolean {
  const configured = inspectedValue<boolean>('test.p7.interrupt', resource);
  if (typeof configured === 'boolean') {
    return configured;
  }
  return true;
}

export type P7StressMode = 'anchor' | 'probe' | 'hybrid' | 'off';

export function getP7StressMode(resource?: vscode.Uri): P7StressMode {
  const normalize = (value: unknown): P7StressMode | undefined => {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'anchor' || normalized === 'probe' || normalized === 'hybrid' || normalized === 'off'
      ? normalized
      : undefined;
  };
  return normalize(inspectedValue<string>('test.p7.stressMode', resource))
    ?? 'anchor';
}

export function getP7TimerInterruptEnabled(resource?: vscode.Uri): boolean {
  const configured = inspectedValue<boolean>('test.p7.timerInterrupt', resource);
  if (typeof configured === 'boolean') {
    return configured;
  }
  return false;
}

export function getP7ExternalInterruptIntensity(resource?: vscode.Uri): number {
  return p7UnitIntervalConfig('test.p7.externalInterruptIntensity', 0.25, resource);
}

export function getP7TimerIntensity(resource?: vscode.Uri): number {
  return p7UnitIntervalConfig('test.p7.timerIntensity', 0.2, resource);
}

export function getP7ProbeScenarioCount(resource?: vscode.Uri): number {
  const normalize = (value: number): number => Math.min(64, Math.max(1, Math.floor(value)));
  const configured = inspectedValue<number>('test.p7.probeScenarioCount', resource);
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return normalize(configured);
  }
  return 32;
}

/**
 * P7 生成器主动制造内部异常（AdEL/AdES/Syscall/RI/Ov）的比例，范围 [0, 1]。
 */
export function getP7ExceptionRate(resource?: vscode.Uri): number {
  const configured = inspectedValue<number>('test.p7.exceptionRate', resource);
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) {
    return Math.min(1, configured);
  }
  return 0.08;
}

export function getP7ExceptionTypes(resource?: vscode.Uri): string[] {
  return layeredGetArray(
    'test.p7.exceptionTypes',
    ['AdEL', 'AdES', 'Syscall', 'RI', 'Ov'],
    resource
  );
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

function positiveIntegerConfig(key: string, fallback: number, resource?: vscode.Uri): number {
  const value = config<number>(key, fallback, resource);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeIntegerConfig(key: string, fallback: number, resource?: vscode.Uri): number {
  const value = config<number>(key, fallback, resource);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function p7UnitIntervalConfig(
  key: string,
  fallback: number,
  resource?: vscode.Uri
): number {
  const configured = inspectedValue<number>(key, resource);
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) {
    return Math.min(1, configured);
  }
  return fallback;
}
