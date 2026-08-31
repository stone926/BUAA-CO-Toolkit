import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CONCRETE_PROFILES } from './constants';
import { ProjectProfile } from './types';
import { getMarsJar, getMarsP7Jar, getLogisimJar, getJava, getMipsEngine } from './config';
import {
  getProfileDefaults,
  getProfileDirectories,
  getProfileName,
  getVerilogPorts as getCourseVerilogPorts
} from './courseConfig';
import { defaultCoSettings } from './language/common/settings';
import { buildTestbench, parseVerilog } from './language/verilog/service';
import { renderResourceTemplate } from './templates/templateRegistry';
import { pathExists } from './fsUtil';
import { getEffectiveRequiredTools } from './toolchainPolicy';
import {
  buildWizardSettingUpdates,
  inspectWizardToolchainLegacyScopes,
  WizardToolchainSettings
} from './wizardSettings';

export async function runProjectWizard(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('请先打开一个工作区文件夹');
    return;
  }

  // Step 1: 选择 Profile
  const profiles: ProjectProfile[] = [...CONCRETE_PROFILES];
  const profilePick = await vscode.window.showQuickPick(
    profiles.map((p) => ({
      label: p,
      description: getProfileName(p),
      profile: p
    })),
    {
      title: '选择项目 Profile',
      placeHolder: '选择你的实验项目类型'
    }
  );

  if (!profilePick) {
    return;
  }

  const profile = profilePick.profile;

  // Step 2: 项目名称
  const projectName = await vscode.window.showInputBox({
    title: '项目名称',
    prompt: '输入项目名称',
    value: `co-${profile.toLowerCase()}`,
    validateInput: (value) => {
      if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
        return '项目名称只能包含字母、数字、连字符和下划线';
      }
      return undefined;
    }
  });

  if (!projectName) {
    return;
  }

  // Step 3: 工具链配置（可选）
  const configureToolchain = await vscode.window.showQuickPick(
    [
      { label: '跳过', description: '使用现有配置或稍后手动配置', value: false },
      { label: '配置工具链', description: '按当前 Profile 设置所需外部工具路径', value: true }
    ],
    {
      title: '配置工具链？',
      placeHolder: '是否现在配置工具链路径？'
    }
  );

  let toolchainConfig: WizardToolchainSettings = {};

  if (configureToolchain?.value) {
    toolchainConfig = await configureToolchainPaths(profile, workspaceFolder.uri);
  }

  // Step 4: 创建目录结构
  const createStructure = await vscode.window.showQuickPick(
    [
      { label: '是', description: '创建目录结构和模板文件', value: true },
      { label: '否', description: '只更新项目设置', value: false }
    ],
    {
      title: '创建项目结构？',
      placeHolder: '是否创建推荐的目录结构？'
    }
  );

  if (!createStructure) {
    return;
  }

  const rootPath = workspaceFolder.uri.fsPath;
  try {
    if (createStructure.value) {
      await createProjectStructure(rootPath, profile);
    }
    await updateProjectSettings(profile, toolchainConfig, workspaceFolder.uri);
    vscode.window.showInformationMessage(createStructure.value
      ? `CO 项目 '${projectName}' (${profile}) 创建成功！`
      : `CO 项目 '${projectName}' (${profile}) 设置已更新`);
  } catch (error) {
    vscode.window.showErrorMessage(`创建项目失败: ${error}`);
  }
}

export async function configureToolchainPaths(profile: ProjectProfile, resource: vscode.Uri): Promise<WizardToolchainSettings> {
  const toolchain: WizardToolchainSettings = {};
  const requiredTools = new Set(getEffectiveRequiredTools(profile, getMipsEngine(resource)));

  if (requiredTools.has('java')) {
    const javaPath = await vscode.window.showInputBox({
      title: 'Java 路径',
      prompt: '输入 Java 可执行文件路径',
      value: getJava(resource),
      placeHolder: 'java'
    });
    if (javaPath) {
      toolchain.java = javaPath;
    }
  }

  if (requiredTools.has('mars')) {
    const marsPath = await vscode.window.showInputBox({
      title: 'MARS 路径',
      prompt: '输入 Mars.jar 文件路径',
      value: getMarsJar(resource),
      placeHolder: 'E:/path/to/Mars4_5.jar'
    });
    if (marsPath) {
      toolchain.mars = marsPath;
    }
  }

  if (requiredTools.has('marsP7')) {
    const marsP7Path = await vscode.window.showInputBox({
      title: 'P7 MARS 路径',
      prompt: '输入 P7 专用 Mars jar 路径',
      value: getMarsP7Jar(resource),
      placeHolder: 'E:/path/to/Mars_p7.jar'
    });
    if (marsP7Path) {
      toolchain.marsP7 = marsP7Path;
    }
  }

  if (requiredTools.has('logisim')) {
    const logisimPath = await vscode.window.showInputBox({
      title: 'Logisim 路径',
      prompt: '输入 logisim.jar 文件路径',
      value: getLogisimJar(resource),
      placeHolder: 'E:/path/to/logisim.jar'
    });
    if (logisimPath) {
      toolchain.logisim = logisimPath;
    }
  }

  return toolchain;
}

async function createProjectStructure(
  rootPath: string,
  profile: ProjectProfile
): Promise<void> {
  const dirs = getDirectoriesForProfile(profile);

  for (const dir of dirs) {
    const dirPath = path.join(rootPath, dir);
    await fs.promises.mkdir(dirPath, { recursive: true });
  }

  await createTemplateFiles(rootPath, profile);
}

function getDirectoriesForProfile(profile: ProjectProfile): string[] {
  return getProfileDirectories(profile);
}

async function createTemplateFiles(rootPath: string, profile: ProjectProfile): Promise<void> {
  switch (profile) {
    case 'P2':
      await createMipsTemplate(rootPath);
      break;
    case 'P1':
    case 'P4':
    case 'P5':
    case 'P6':
    case 'P7':
      await createVerilogTemplate(rootPath, profile);
      break;
  }
}

async function createMipsTemplate(rootPath: string): Promise<void> {
  const mainPath = path.join(rootPath, 'src', 'main.asm');
  if (!await pathExists(mainPath)) {
    const template = renderResourceTemplate('wizard/p2_main.asm', { date: currentDateStamp() });
    await fs.promises.writeFile(mainPath, template, 'utf8');
  }
}

async function createVerilogTemplate(rootPath: string, profile: ProjectProfile): Promise<void> {
  const topModule = defaultTopModuleForProfile(profile) ?? 'main';
  const topPath = path.join(rootPath, 'src', `${topModule}.v`);
  let topText: string;

  if (!await pathExists(topPath)) {
    const ports = getVerilogPorts(profile);
    topText = renderResourceTemplate('wizard/verilog_top.v', {
      date: currentDateStamp(),
      ports,
      profile,
      topModule
    });
    await fs.promises.writeFile(topPath, topText, 'utf8');
  } else {
    topText = await fs.promises.readFile(topPath, 'utf8');
  }

  // 创建 testbench
  const tbPath = path.join(rootPath, 'test', `${topModule}_tb.v`);
  if (!await pathExists(tbPath)) {
    const tbTemplate = buildWizardTestbench(topText, topPath, topModule, `${topModule}_tb`, profile);
    await fs.promises.writeFile(tbPath, tbTemplate, 'utf8');
  }
}

function getVerilogPorts(profile: ProjectProfile): string {
  const ports = getCourseVerilogPorts(profile);
  if (ports.length) {
    return ports.map((port) => {
      const width = port.width === 1 ? '' : ` [${port.width - 1}:0]`;
      return `    ${port.direction}${width} ${port.name}`;
    }).join(',\n');
  }

  return [
    '    input clk',
    '    input reset'
  ].join(',\n');
}

function defaultTopModuleForProfile(profile: ProjectProfile): string | undefined {
  return getProfileDefaults(profile).topModule;
}

function buildWizardTestbench(topText: string, topPath: string, topModule: string, tbName: string, profile: ProjectProfile): string {
  const document = TextDocument.create(vscode.Uri.file(topPath).toString(), 'verilog', 1, topText);
  const parsed = parseVerilog(document, defaultCoSettings, false);
  const module = parsed.modules.find((candidate) => candidate.name === topModule) ?? parsed.modules[0];
  if (module) {
    return buildTestbench(module, tbName, { profile });
  }
  return renderResourceTemplate('wizard/basic_testbench.v', { tbName, topModule });
}

function currentDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function updateProjectSettings(
  profile: ProjectProfile,
  toolchainConfig: WizardToolchainSettings,
  resource?: vscode.Uri
): Promise<void> {
  const config = vscode.workspace.getConfiguration('co', resource);
  const baseUpdates = buildWizardSettingUpdates(profile, toolchainConfig, Boolean(resource));
  const legacyScopes = inspectWizardToolchainLegacyScopes(
    baseUpdates,
    Boolean(resource),
    (key) => config.inspect<string>(key)
  );

  for (const update of buildWizardSettingUpdates(profile, toolchainConfig, Boolean(resource), legacyScopes)) {
    const target = update.target === 'global'
      ? vscode.ConfigurationTarget.Global
      : update.target === 'workspaceFolder'
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : vscode.ConfigurationTarget.Workspace;
    await config.update(update.key, update.value, target);
  }
}
