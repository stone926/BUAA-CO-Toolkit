import * as vscode from 'vscode';
import { ProjectProfile } from './projectProfile';

export function config<T>(key: string, fallback: T, resource?: vscode.Uri): T {
  const value = vscode.workspace.getConfiguration('co', resource).get<T>(key);
  return value === undefined || value === null ? fallback : value;
}

export function getProfile(resource?: vscode.Uri): ProjectProfile {
  return config<ProjectProfile>('project.profile', 'auto', resource);
}

export function getTopModule(resource?: vscode.Uri): string {
  return config<string>('project.topModule', 'mips', resource).trim() || 'mips';
}

export function getTestbench(resource?: vscode.Uri): string {
  return config<string>('project.testbench', 'mips_tb', resource).trim() || 'mips_tb';
}

export function getMachineCode(resource?: vscode.Uri): string {
  return config<string>('project.machineCode', 'code.txt', resource).trim() || 'code.txt';
}

export function getSimTime(resource?: vscode.Uri): string {
  return config<string>('project.simTime', '200us', resource).trim() || '200us';
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
  return config<string>('toolchain.java', 'java', resource).trim() || 'java';
}

export function getMarsJar(resource?: vscode.Uri): string {
  const profile = getProfile(resource);
  if (profile === 'P7') {
    const p7Jar = config<string>('toolchain.marsP7', '', resource).trim();
    if (p7Jar) {
      return p7Jar;
    }
  }
  return config<string>('toolchain.mars', '', resource).trim();
}

export function getLogisimJar(resource?: vscode.Uri): string {
  return config<string>('toolchain.logisim', '', resource).trim();
}

export function getIsePath(resource?: vscode.Uri): string {
  return config<string>('toolchain.isePath', '', resource).trim();
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
