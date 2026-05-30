import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectProfile } from './types';
import { CoProjectConfig, saveProjectConfig } from './projectConfig';
import { getMarsJar, getLogisimJar, getIsePath, getJava } from './config';

export async function runProjectWizard(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('请先打开一个工作区文件夹。');
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
      title: '选择 BUAA CO 项目 Profile',
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
        return '项目名称只能包含字母、数字、连字符和下划线。';
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
    vscode.window.showInformationMessage(`BUAA CO 项目 '${projectName}' (${profile}) 创建成功！`);
  } catch (error) {
    vscode.window.showErrorMessage(`创建项目失败: ${error}`);
  }
}

function profileDescription(profile: ProjectProfile): string {
  switch (profile) {
    case 'P0':
      return '初识 Logisim';
    case 'P1':
      return '初识 Verilog';
    case 'P2':
      return '初识 ASM';
    case 'P3':
      return 'Logisim 单周期 CPU';
    case 'P4':
      return 'Verilog 单周期 CPU';
    case 'P5':
      return 'Verilog 五级流水线（阻塞+转发）';
    case 'P6':
      return '流水线 + 乘除法 + 外置存储器';
    case 'P7':
      return 'MIPS 微系统（异常+外设）';
    default:
      return '';
  }
}

async function configureToolchainPaths(profile: ProjectProfile): Promise<CoProjectConfig['toolchain']> {
  const toolchain: CoProjectConfig['toolchain'] = {};

  // Java 路径
  const javaPath = await vscode.window.showInputBox({
    title: 'Java 路径',
    prompt: '输入 Java 可执行文件路径',
    value: getJava(),
    placeHolder: 'java'
  });
  if (javaPath) {
    toolchain.java = javaPath;
  }

  // MARS 路径（P2-P7 需要）
  if (profile >= 'P2') {
    const marsPath = await vscode.window.showInputBox({
      title: 'MARS 路径',
      prompt: '输入 Mars.jar 文件路径',
      value: getMarsJar(),
      placeHolder: 'E:/path/to/Mars4_5.jar'
    });
    if (marsPath) {
      toolchain.mars = marsPath;
    }

    // P7 专用 MARS
    if (profile === 'P7') {
      const marsP7Path = await vscode.window.showInputBox({
        title: 'P7 MARS 路径',
        prompt: '输入 P7 专用 Mars jar 路径',
        placeHolder: 'E:/path/to/Mars_p7.jar'
      });
      if (marsP7Path) {
        toolchain.marsP7 = marsP7Path;
      }
    }
  }

  // Logisim 路径（P0/P1/P3 需要）
  if (profile === 'P0' || profile === 'P1' || profile === 'P3') {
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

  // ISE 路径（P4-P7 需要）
  if (profile >= 'P4') {
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
      top: profile >= 'P4' ? 'mips' : undefined,
      testbench: profile >= 'P4' ? 'mips_tb' : undefined,
      time: '200us',
      machineCode: 'code.txt'
    }
  };

  await saveProjectConfig(config);

  // 创建模板文件
  await createTemplateFiles(rootPath, profile);
}

function getDirectoriesForProfile(profile: ProjectProfile): string[] {
  const common = ['.co'];

  switch (profile) {
    case 'P0':
    case 'P1':
    case 'P3':
      return [...common, 'logisim', 'test'];
    case 'P2':
      return [...common, 'src', 'test', 'data'];
    case 'P4':
    case 'P5':
    case 'P6':
    case 'P7':
      return [...common, 'src', 'test', 'sim', 'data'];
    default:
      return common;
  }
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

  if (!fs.existsSync(topPath)) {
    const ports = getVerilogPorts(profile);
    const template = `// BUAA CO ${profile} Verilog
// Author: Your Name
// Date: ${new Date().toISOString().split('T')[0]}

module ${topModule}(
${ports}
);
    // 你的实现

endmodule
`;
    fs.writeFileSync(topPath, template, 'utf8');
  }

  // 创建 testbench
  const tbPath = path.join(rootPath, 'test', `${topModule}_tb.v`);
  if (!fs.existsSync(tbPath)) {
    const tbTemplate = `// Testbench for ${topModule}
\`timescale 1ns/1ps

module ${topModule}_tb;
    reg clk;
    reg reset;

    ${topModule} uut(
        .clk(clk),
        .reset(reset)
    );

    initial begin
        clk = 0;
        forever #5 clk = ~clk;
    end

    initial begin
        reset = 1;
        #20;
        reset = 0;
        #1000;
        \$finish;
    end

    initial begin
        \$dumpfile("wave.vcd");
        \$dumpvars(0, ${topModule}_tb);
    end
endmodule
`;
    fs.writeFileSync(tbPath, tbTemplate, 'utf8');
  }
}

function getVerilogPorts(profile: ProjectProfile): string {
  const ports: string[] = [
    '    input clk',
    '    input reset'
  ];

  if (profile >= 'P5') {
    ports.push('    output [31:0] macroscopicPC');
  }

  if (profile === 'P7') {
    ports.push('    input interrupt');
    ports.push('    output [31:0] m_int_addr');
    ports.push('    output [3:0] m_int_byteen');
  }

  return ports.join(',\n');
}

async function updateProjectSettings(profile: ProjectProfile): Promise<void> {
  const config = vscode.workspace.getConfiguration('co');
  await config.update('project.profile', profile, vscode.ConfigurationTarget.Workspace);
}
