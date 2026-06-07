import * as vscode from 'vscode';
import { ProjectProfile } from './projectProfile';
import {
  getProjectConfig,
  getProjectProfileFromConfig,
  getToolchainFromConfig,
  getSimulationFromConfig,
  getTestFromConfig,
  getMipsFromConfig
} from './projectConfig';

/**
 * 配置读取优先级：
 * 1. VSCode Settings (co.*)
 * 2. .co/config.json
 * 3. 默认值
 */

export function config<T>(key: string, fallback: T, resource?: vscode.Uri): T {
  const value = vscode.workspace.getConfiguration('co', resource).get<T>(key);
  if (value !== undefined && value !== null) {
    return value;
  }
  return fallback;
}

/**
 * 三层字符串配置读取：VSCode Settings → .co/config.json → 默认值。
 * 消除各 getter 中重复的 "读 VSCode → trim → 判断 → 读 config.json → 返回默认值" 模式。
 */
function layeredGetString(
  vsKey: string,
  configFallback: (() => string | undefined) | undefined,
  defaultValue: string,
  resource?: vscode.Uri
): string {
  const vsValue = inspectedValue<string>(vsKey, resource);
  if (vsValue && vsValue.trim()) {
    return vsValue.trim();
  }
  const configValue = configFallback?.();
  if (configValue) {
    return configValue;
  }
  return defaultValue;
}

export function getProfile(resource?: vscode.Uri): ProjectProfile {
  const vsProfile = vscode.workspace.getConfiguration('co', resource).get<ProjectProfile>('project.profile');
  if (vsProfile && vsProfile !== 'auto') {
    return vsProfile;
  }
  return getProjectProfileFromConfig(resource) ?? 'auto';
}

export function getTopModule(resource?: vscode.Uri): string {
  return layeredGetString('project.topModule', () => getSimulationFromConfig(resource)?.top, 'mips', resource);
}

export function getTestbench(resource?: vscode.Uri): string {
  return layeredGetString('project.testbench', () => getSimulationFromConfig(resource)?.testbench, 'mips_tb', resource);
}

export function getMachineCode(resource?: vscode.Uri): string {
  return layeredGetString('project.machineCode', () => getSimulationFromConfig(resource)?.machineCode, 'code.txt', resource);
}

export function getSimTime(resource?: vscode.Uri): string {
  return layeredGetString('project.simTime', () => getSimulationFromConfig(resource)?.time, '200us', resource);
}

export function getSimBackend(resource?: vscode.Uri): string {
  return layeredGetString('project.simBackend', () => getSimulationFromConfig(resource)?.backend, 'isim', resource);
}

export function useDelayedBranching(resource?: vscode.Uri): boolean {
  const mode = config<string>('mips.delayedBranching', 'profile', resource);
  if (mode === 'on') { return true; }
  if (mode === 'off') { return false; }
  const profile = getProfile(resource);
  return profile === 'P5' || profile === 'P6' || profile === 'P7';
}

export function getJava(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.java', () => getToolchainFromConfig(resource)?.java, 'java', resource);
}

export function getPython(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.python', () => getToolchainFromConfig(resource)?.python, 'python', resource);
}

export function getMarsJar(resource?: vscode.Uri): string {
  const profile = getProfile(resource);
  if (profile === 'P7') {
    const p7 = layeredGetString('toolchain.marsP7', () => getToolchainFromConfig(resource)?.marsP7, '', resource);
    if (p7) { return p7; }
  }
  return layeredGetString('toolchain.mars', () => getToolchainFromConfig(resource)?.mars, '', resource);
}

export function getLogisimJar(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.logisim', () => getToolchainFromConfig(resource)?.logisim, '', resource);
}

export function getIsePath(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.isePath', () => getToolchainFromConfig(resource)?.isePath, '', resource);
}

export function getHazardCalculator(resource?: vscode.Uri): string {
  return layeredGetString('toolchain.hazardCalculator', () => getToolchainFromConfig(resource)?.hazardCalculator, '', resource);
}

export function getTutorialRoot(resource?: vscode.Uri): string {
  return layeredGetString('course.tutorialRoot', undefined, '', resource);
}

export function getRunTimeout(resource?: vscode.Uri): number {
  return config<number>('run.timeoutMs', 120000, resource);
}

export function showCommandBeforeRun(resource?: vscode.Uri): boolean {
  return config<boolean>('run.showCommandBeforeRun', false, resource);
}

export function getMemoryConfiguration(resource?: vscode.Uri): string {
  const configured = configuredMemoryConfiguration(resource);
  if (configured) {
    return configured;
  }
  return getProfile(resource) === 'P7' ? 'CompactDataAtZero' : 'FixedCompactLargeText';
}

function configuredMemoryConfiguration(resource?: vscode.Uri): string | undefined {
  const vsValue = inspectedValue<string>('mips.memoryConfiguration', resource)?.trim();
  if (vsValue && vsValue.toLowerCase() !== 'auto') {
    return vsValue;
  }
  const configValue = getMipsFromConfig(resource)?.memoryConfiguration?.trim();
  if (configValue && configValue.toLowerCase() !== 'auto') {
    return configValue;
  }
  return undefined;
}

export function getMipsExtraArgs(resource?: vscode.Uri): string[] {
  return layeredGetArray('mips.extraArgs', () => getMipsFromConfig(resource)?.extraArgs, [], resource);
}

export function getGeneratorArgs(resource?: vscode.Uri): string[] {
  return layeredGetArray('test.generatorArgs', () => getTestFromConfig(resource)?.generatorArgs, [], resource);
}

export function getGeneratedAsmLimit(resource?: vscode.Uri): number {
  const configured = inspectedValue<number>('test.generatedAsmLimit', resource);
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  const projectValue = getTestFromConfig(resource)?.generatedAsmLimit;
  if (typeof projectValue === 'number' && Number.isFinite(projectValue) && projectValue > 0) {
    return Math.floor(projectValue);
  }
  return 100;
}

export function useBuiltinTestGenerator(resource?: vscode.Uri): boolean {
  const configured = inspectedValue<boolean>('test.builtinGenerator.enabled', resource);
  if (typeof configured === 'boolean') {
    return configured;
  }
  const projectValue = getTestFromConfig(resource)?.builtinGenerator?.enabled;
  if (typeof projectValue === 'boolean') {
    return projectValue;
  }
  return true;
}

export function getBuiltinGeneratorInstructions(resource?: vscode.Uri): string {
  return layeredGetString(
    'test.builtinGenerator.instructions',
    () => getTestFromConfig(resource)?.builtinGenerator?.instructions,
    '',
    resource
  );
}

export function getBuiltinGeneratorInstructionCount(resource?: vscode.Uri): number {
  const configured = inspectedValue<number>('test.builtinGenerator.instructionCount', resource);
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  const projectValue = getTestFromConfig(resource)?.builtinGenerator?.instructionCount;
  if (typeof projectValue === 'number' && Number.isFinite(projectValue) && projectValue > 0) {
    return Math.floor(projectValue);
  }
  return 1000;
}

export function getBuiltinGeneratorP7InstructionCount(resource?: vscode.Uri): number {
  const configured = inspectedValue<number>('test.builtinGenerator.p7InstructionCount', resource);
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.floor(configured), 1118);
  }
  const projectValue = getTestFromConfig(resource)?.builtinGenerator?.p7InstructionCount;
  if (typeof projectValue === 'number' && Number.isFinite(projectValue) && projectValue > 0) {
    return Math.min(Math.floor(projectValue), 1118);
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

function layeredGetArray(
  vsKey: string,
  configFallback: (() => string[] | undefined) | undefined,
  defaultValue: string[],
  resource?: vscode.Uri
): string[] {
  const configured = inspectedValue<string[]>(vsKey, resource);
  if (Array.isArray(configured)) {
    return configured.map((item) => String(item)).filter(Boolean);
  }
  const configValue = configFallback?.();
  if (Array.isArray(configValue)) {
    return configValue.map((item) => String(item)).filter(Boolean);
  }
  return [...defaultValue];
}

function inspectedValue<T>(key: string, resource?: vscode.Uri): T | undefined {
  const inspected = vscode.workspace.getConfiguration('co', resource).inspect<T>(key);
  return inspected?.workspaceFolderValue
    ?? inspected?.workspaceValue
    ?? inspected?.globalValue;
}

function positiveIntegerConfig(key: string, fallback: number, resource?: vscode.Uri): number {
  const value = config<number>(key, fallback, resource);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeIntegerConfig(key: string, fallback: number, resource?: vscode.Uri): number {
  const value = config<number>(key, fallback, resource);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
