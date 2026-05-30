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
  // 优先从 VSCode Settings 读取
  const value = vscode.workspace.getConfiguration('co', resource).get<T>(key);
  if (value !== undefined && value !== null) {
    return value;
  }
  return fallback;
}

export function getProfile(resource?: vscode.Uri): ProjectProfile {
  // 优先从 VSCode Settings 读取
  const vsProfile = vscode.workspace.getConfiguration('co', resource).get<ProjectProfile>('project.profile');
  if (vsProfile && vsProfile !== 'auto') {
    return vsProfile;
  }

  // 其次从 .co/config.json 读取
  const configProfile = getProjectProfileFromConfig(resource);
  if (configProfile) {
    return configProfile;
  }

  return 'auto';
}

export function getTopModule(resource?: vscode.Uri): string {
  // 优先从 VSCode Settings 读取
  const vsValue = vscode.workspace.getConfiguration('co', resource).get<string>('project.topModule');
  if (vsValue && vsValue.trim()) {
    return vsValue.trim();
  }

  // 其次从 .co/config.json 读取
  const simConfig = getSimulationFromConfig(resource);
  if (simConfig?.top) {
    return simConfig.top;
  }

  return 'mips';
}

export function getTestbench(resource?: vscode.Uri): string {
  // 优先从 VSCode Settings 读取
  const vsValue = vscode.workspace.getConfiguration('co', resource).get<string>('project.testbench');
  if (vsValue && vsValue.trim()) {
    return vsValue.trim();
  }

  // 其次从 .co/config.json 读取
  const simConfig = getSimulationFromConfig(resource);
  if (simConfig?.testbench) {
    return simConfig.testbench;
  }

  return 'mips_tb';
}

export function getMachineCode(resource?: vscode.Uri): string {
  // 优先从 VSCode Settings 读取
  const vsValue = vscode.workspace.getConfiguration('co', resource).get<string>('project.machineCode');
  if (vsValue && vsValue.trim()) {
    return vsValue.trim();
  }

  // 其次从 .co/config.json 读取
  const simConfig = getSimulationFromConfig(resource);
  if (simConfig?.machineCode) {
    return simConfig.machineCode;
  }

  return 'code.txt';
}

export function getSimTime(resource?: vscode.Uri): string {
  // 优先从 VSCode Settings 读取
  const vsValue = vscode.workspace.getConfiguration('co', resource).get<string>('project.simTime');
  if (vsValue && vsValue.trim()) {
    return vsValue.trim();
  }

  // 其次从 .co/config.json 读取
  const simConfig = getSimulationFromConfig(resource);
  if (simConfig?.time) {
    return simConfig.time;
  }

  return '200us';
}

export function getSimBackend(resource?: vscode.Uri): string {
  // 优先从 VSCode Settings 读取（如果存在的话）
  const vsValue = vscode.workspace.getConfiguration('co', resource).get<string>('project.simBackend');
  if (vsValue && vsValue.trim()) {
    return vsValue.trim();
  }

  // 其次从 .co/config.json 读取
  const simConfig = getSimulationFromConfig(resource);
  if (simConfig?.backend) {
    return simConfig.backend;
  }

  return 'isim';
}

export function useDelayedBranching(resource?: vscode.Uri): boolean {
  const mode = config<string>('mips.delayedBranching', 'profile', resource);
  if (mode === 'on') {
    return true;
  }
  if (mode === 'off') {
    return false;
  }
  const profile = getProfile(resource);
  return profile === 'P5' || profile === 'P6' || profile === 'P7';
}

export function getJava(resource?: vscode.Uri): string {
  // 优先从 VSCode Settings 读取
  const vsValue = vscode.workspace.getConfiguration('co', resource).get<string>('toolchain.java');
  if (vsValue && vsValue.trim()) {
    return vsValue.trim();
  }

  // 其次从 .co/config.json 读取
  const toolConfig = getToolchainFromConfig(resource);
  if (toolConfig?.java) {
    return toolConfig.java;
  }

  return 'java';
}

export function getMarsJar(resource?: vscode.Uri): string {
  const profile = getProfile(resource);

  // P7 优先使用 P7 专用 MARS
  if (profile === 'P7') {
    // 优先从 VSCode Settings 读取
    const p7Jar = config<string>('toolchain.marsP7', '', resource).trim();
    if (p7Jar) {
      return p7Jar;
    }

    // 其次从 .co/config.json 读取
    const toolConfig = getToolchainFromConfig(resource);
    if (toolConfig?.marsP7) {
      return toolConfig.marsP7;
    }
  }

  // 优先从 VSCode Settings 读取
  const vsValue = vscode.workspace.getConfiguration('co', resource).get<string>('toolchain.mars');
  if (vsValue && vsValue.trim()) {
    return vsValue.trim();
  }

  // 其次从 .co/config.json 读取
  const toolConfig = getToolchainFromConfig(resource);
  if (toolConfig?.mars) {
    return toolConfig.mars;
  }

  return '';
}

export function getLogisimJar(resource?: vscode.Uri): string {
  // 优先从 VSCode Settings 读取
  const vsValue = vscode.workspace.getConfiguration('co', resource).get<string>('toolchain.logisim');
  if (vsValue && vsValue.trim()) {
    return vsValue.trim();
  }

  // 其次从 .co/config.json 读取
  const toolConfig = getToolchainFromConfig(resource);
  if (toolConfig?.logisim) {
    return toolConfig.logisim;
  }

  return '';
}

export function getIsePath(resource?: vscode.Uri): string {
  // 优先从 VSCode Settings 读取
  const vsValue = vscode.workspace.getConfiguration('co', resource).get<string>('toolchain.isePath');
  if (vsValue && vsValue.trim()) {
    return vsValue.trim();
  }

  // 其次从 .co/config.json 读取
  const toolConfig = getToolchainFromConfig(resource);
  if (toolConfig?.isePath) {
    return toolConfig.isePath;
  }

  return '';
}

export function getHazardCalculator(resource?: vscode.Uri): string {
  // 优先从 VSCode Settings 读取（如果存在的话）
  const vsValue = vscode.workspace.getConfiguration('co', resource).get<string>('toolchain.hazardCalculator');
  if (vsValue && vsValue.trim()) {
    return vsValue.trim();
  }

  // 其次从 .co/config.json 读取
  const toolConfig = getToolchainFromConfig(resource);
  if (toolConfig?.hazardCalculator) {
    return toolConfig.hazardCalculator;
  }

  return '';
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
