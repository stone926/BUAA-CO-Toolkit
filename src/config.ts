import * as vscode from 'vscode';
import { ProjectProfile } from './projectProfile';
import {
  getProjectConfig,
  getProjectProfileFromConfig,
  getToolchainFromConfig,
  getSimulationFromConfig
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
  const vsValue = vscode.workspace.getConfiguration('co', resource).get<string>(vsKey);
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

export function getRunTimeout(resource?: vscode.Uri): number {
  return config<number>('run.timeoutMs', 120000, resource);
}

export function showCommandBeforeRun(resource?: vscode.Uri): boolean {
  return config<boolean>('run.showCommandBeforeRun', false, resource);
}

export function getMemoryConfiguration(resource?: vscode.Uri): string {
  return config<string>('mips.memoryConfiguration', 'CompactDataAtZero', resource).trim() || 'CompactDataAtZero';
}
