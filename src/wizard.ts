import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ProjectProfile } from './types';
import { CoProjectConfig, saveProjectConfig } from './projectConfig';
import { getMarsJar, getLogisimJar, getIsePath, getJava } from './config';
import {
  getProfileDescription,
  getProfileDirectories,
  getProfileName,
  getProfileRequiredTools,
  getVerilogPorts as getCourseVerilogPorts
} from './courseConfig';
import { defaultCoSettings } from './language/common/settings';
import { buildTestbench, parseVerilog } from './language/verilog/service';

export async function runProjectWizard(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('请先打开一个工作区文件夹');
    return;
  }

  // Step 1: 选择 Profile
  const profiles: ProjectProfile[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
  const profilePick = await vscode.window.showQuickPick(
    profiles.map((p) => ({
      label: p,
      description: profileDescription(p),
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
      { label: '配置工具链', description: '设置 MARS、ISE、Logisim 等工具路径', value: true }
    ],
    {
      title: '配置工具链？',
      placeHolder: '是否现在配置工具链路径？'
    }
  );

  let toolchainConfig: CoProjectConfig['toolchain'] = {};

  if (configureToolchain?.value) {
    toolchainConfig = await configureToolchainPaths(profile);
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

  // Step 5: 创建项目
  const rootPath = workspaceFolder.uri.fsPath;
  try {
    await createProjectStructure(rootPath, profile, projectName, toolchainConfig);
    await updateProjectSettings(profile);
    vscode.window.showInformationMessage(`CO 项目 '${projectName}' (${profile}) 创建成功！`);
  } catch (error) {
    vscode.window.showErrorMessage(`创建项目失败: ${error}`);
  }
}

function profileDescription(profile: ProjectProfile): string {
  return getProfileName(profile) || getProfileDescription(profile);
}

async function configureToolchainPaths(profile: ProjectProfile): Promise<CoProjectConfig['toolchain']> {
  const toolchain: CoProjectConfig['toolchain'] = {};
  const requiredTools = new Set(getProfileRequiredTools(profile));

  if (requiredTools.has('java')) {
    const javaPath = await vscode.window.showInputBox({
      title: 'Java 路径',
      prompt: '输入 Java 可执行文件路径',
      value: getJava(),
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
      value: getMarsJar(),
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
      value: getMarsJar(),
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
      value: getLogisimJar(),
      placeHolder: 'E:/path/to/logisim.jar'
    });
    if (logisimPath) {
      toolchain.logisim = logisimPath;
    }
  }

  if (requiredTools.has('ise')) {
    const isePath = await vscode.window.showInputBox({
      title: 'ISE 路径',
      prompt: '输入 Xilinx ISE 安装目录',
      value: getIsePath(),
      placeHolder: 'D:/Xilinx/14.7/ISE_DS/ISE'
    });
    if (isePath) {
      toolchain.isePath = isePath;
    }
  }

  return toolchain;
}

async function createProjectStructure(
  rootPath: string,
  profile: ProjectProfile,
  projectName: string,
  toolchainConfig: CoProjectConfig['toolchain']
): Promise<void> {
  const dirs = getDirectoriesForProfile(profile);

  for (const dir of dirs) {
    const dirPath = path.join(rootPath, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  // 创建 .co/config.json
  const config: CoProjectConfig = {
    profile,
    toolchain: toolchainConfig,
    simulation: {
      backend: 'isim',
      top: isCpuVerilogProfile(profile) ? 'mips' : undefined,
      testbench: isCpuVerilogProfile(profile) ? 'mips_tb' : undefined,
      time: '200us',
      machineCode: 'code.txt'
    }
  };

  await saveProjectConfig(config);

  // 创建模板文件
  await createTemplateFiles(rootPath, profile);
}

function getDirectoriesForProfile(profile: ProjectProfile): string[] {
  return getProfileDirectories(profile);
}

async function createTemplateFiles(rootPath: string, profile: ProjectProfile): Promise<void> {
  switch (profile) {
    case 'P2':
      createMipsTemplate(rootPath);
      break;
    case 'P4':
    case 'P5':
    case 'P6':
    case 'P7':
      createVerilogTemplate(rootPath, profile);
      break;
  }
}

function createMipsTemplate(rootPath: string): void {
  const mainPath = path.join(rootPath, 'src', 'main.asm');
  if (!fs.existsSync(mainPath)) {
    const template = `# BUAA CO P2 MIPS Assembly
# Author: Your Name
# Date: ${new Date().toISOString().split('T')[0]}

.data
    # 数据段

.text
.globl main
main:
    # 你的代码

    # 退出程序
    li $v0, 10
    syscall
`;
    fs.writeFileSync(mainPath, template, 'utf8');
  }
}

function createVerilogTemplate(rootPath: string, profile: ProjectProfile): void {
  const topModule = 'mips';
  const topPath = path.join(rootPath, 'src', `${topModule}.v`);
  let topText: string;

  if (!fs.existsSync(topPath)) {
    const ports = getVerilogPorts(profile);
    topText = `// BUAA CO ${profile} Verilog
// Author: Your Name
// Date: ${new Date().toISOString().split('T')[0]}

module ${topModule}(
${ports}
);
    // 你的实现

endmodule
`;
    fs.writeFileSync(topPath, topText, 'utf8');
  } else {
    topText = fs.readFileSync(topPath, 'utf8');
  }

  // 创建 testbench
  const tbPath = path.join(rootPath, 'test', `${topModule}_tb.v`);
  if (!fs.existsSync(tbPath)) {
    const tbTemplate = buildWizardTestbench(topText, topPath, topModule, `${topModule}_tb`);
    fs.writeFileSync(tbPath, tbTemplate, 'utf8');
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

function isCpuVerilogProfile(profile: ProjectProfile): boolean {
  return profile === 'P4' || profile === 'P5' || profile === 'P6' || profile === 'P7';
}

function buildWizardTestbench(topText: string, topPath: string, topModule: string, tbName: string): string {
  const document = TextDocument.create(vscode.Uri.file(topPath).toString(), 'verilog', 1, topText);
  const parsed = parseVerilog(document, defaultCoSettings, false);
  const module = parsed.modules.find((candidate) => candidate.name === topModule) ?? parsed.modules[0];
  if (module) {
    return buildTestbench(module, tbName);
  }
  return `\`timescale 1ns / 1ps

module ${tbName};
    reg clk;
    reg reset;

    ${topModule} uut (
        .clk(clk),
        .reset(reset)
    );

    initial begin
        clk = 1'b0;
        forever #5 clk = ~clk;
    end

    initial begin
        reset = 1'b1;
        #20;
        reset = 1'b0;
        #200000;
        $finish;
    end
endmodule
`;
}

async function updateProjectSettings(profile: ProjectProfile): Promise<void> {
  const config = vscode.workspace.getConfiguration('co');
  await config.update('project.profile', profile, vscode.ConfigurationTarget.Workspace);
}
