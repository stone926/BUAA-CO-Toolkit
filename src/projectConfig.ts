import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectProfile } from './types';

/**
 * .co/config.json 的完整结构
 */
export interface CoProjectConfig {
  profile?: ProjectProfile;
  toolchain?: {
    mars?: string;
    marsP7?: string;
    isePath?: string;
    logisim?: string;
    java?: string;
    hazardCalculator?: string;
  };
  simulation?: {
    backend?: 'isim' | 'icarus';
    top?: string;
    testbench?: string;
    time?: string;
    machineCode?: string;
  };
}

/**
 * 缓存：每个工作区目录一个配置
 */
const configCache = new Map<string, CoProjectConfig | undefined>();

/**
 * 清除配置缓存
 */
export function clearProjectConfigCache(): void {
  configCache.clear();
}

/**
 * 获取 .co/config.json 的路径
 */
function getConfigPath(workspaceFolder?: vscode.WorkspaceFolder): string | undefined {
  if (!workspaceFolder) {
    return undefined;
  }
  return path.join(workspaceFolder.uri.fsPath, '.co', 'config.json');
}

/**
 * 获取当前活动文件所在工作区的 .co/config.json
 */
export function getProjectConfig(resource?: vscode.Uri): CoProjectConfig | undefined {
  const workspaceFolder = resource
    ? vscode.workspace.getWorkspaceFolder(resource)
    : vscode.workspace.workspaceFolders?.[0];

  if (!workspaceFolder) {
    return undefined;
  }

  const configPath = getConfigPath(workspaceFolder);
  if (!configPath) {
    return undefined;
  }

  // 检查缓存
  const cached = configCache.get(configPath);
  if (cached !== undefined) {
    return cached;
  }

  // 读取配置
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(content) as CoProjectConfig;
      configCache.set(configPath, config);
      return config;
    }
  } catch (error) {
    console.error(`Failed to read .co/config.json: ${error}`);
  }

  configCache.set(configPath, undefined);
  return undefined;
}

/**
 * 从 .co/config.json 获取 profile
 */
export function getProjectProfileFromConfig(resource?: vscode.Uri): ProjectProfile | undefined {
  return getProjectConfig(resource)?.profile;
}

/**
 * 从 .co/config.json 获取工具链配置
 */
export function getToolchainFromConfig(resource?: vscode.Uri): CoProjectConfig['toolchain'] {
  return getProjectConfig(resource)?.toolchain;
}

/**
 * 从 .co/config.json 获取仿真配置
 */
export function getSimulationFromConfig(resource?: vscode.Uri): CoProjectConfig['simulation'] {
  return getProjectConfig(resource)?.simulation;
}

/**
 * 保存配置到 .co/config.json
 */
export async function saveProjectConfig(config: CoProjectConfig, resource?: vscode.Uri): Promise<void> {
  const workspaceFolder = resource
    ? vscode.workspace.getWorkspaceFolder(resource)
    : vscode.workspace.workspaceFolders?.[0];

  if (!workspaceFolder) {
    throw new Error('No workspace folder found');
  }

  const configDir = path.join(workspaceFolder.uri.fsPath, '.co');
  const configPath = path.join(configDir, 'config.json');

  // 确保目录存在
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // 读取现有配置并合并
  let existingConfig: CoProjectConfig = {};
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      existingConfig = JSON.parse(content) as CoProjectConfig;
    }
  } catch {
    // 忽略读取错误，使用空配置
  }

  // 合并配置
  const mergedConfig: CoProjectConfig = {
    ...existingConfig,
    ...config,
    toolchain: {
      ...existingConfig.toolchain,
      ...config.toolchain
    },
    simulation: {
      ...existingConfig.simulation,
      ...config.simulation
    }
  };

  // 写入文件
  fs.writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2), 'utf8');

  // 更新缓存
  configCache.set(configPath, mergedConfig);
}
