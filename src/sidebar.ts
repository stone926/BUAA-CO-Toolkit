import * as vscode from 'vscode';
import {
  getProfile,
  getTopModule,
  getTestbench,
  getMachineCode,
  getSimTime,
  getSimBackend,
  getJava,
  getPython,
  getMarsJar,
  getLogisimJar,
  getIsePath,
  getHazardCalculator
} from './config';
import { getProjectConfig } from './projectConfig';
import { ProjectProfile } from './types';

export type SidebarItem = vscode.TreeItem & { contextValue?: string };

interface SidebarSection {
  header: SidebarItem;
  children: SidebarItem[];
}

export class CoSidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SidebarItem): SidebarItem {
    return element;
  }

  getChildren(element?: SidebarItem): SidebarItem[] {
    if (!element) {
      return this.buildSections().map((section) => section.header);
    }
    const section = this.buildSections().find((s) => s.header.label === element.label);
    return section?.children ?? [];
  }

  private buildSections(): SidebarSection[] {
    const resource = vscode.window.activeTextEditor?.document.uri;
    const profile = getProfile(resource);
    const coConfig = getProjectConfig(resource);
    const hasCoConfig = coConfig !== undefined;

    const sections: SidebarSection[] = [];

    // Project section
    sections.push({
      header: this.createHeader('项目配置'),
      children: [
        this.createInfoItem(
          'Profile',
          profile,
          'co.selectProjectProfile',
          '点击切换 Profile',
          hasCoConfig && coConfig?.profile === profile ? '.co' : 'settings'
        ),
        this.createInfoItem(
          '顶层模块',
          getTopModule(resource),
          undefined,
          'co.project.topModule 或 .co/config.json'
        ),
        this.createInfoItem(
          'Testbench',
          getTestbench(resource),
          undefined,
          'co.project.testbench 或 .co/config.json'
        ),
        this.createInfoItem(
          '机器码文件',
          getMachineCode(resource),
          undefined,
          'co.project.machineCode 或 .co/config.json'
        ),
        this.createInfoItem(
          '仿真时长',
          getSimTime(resource),
          undefined,
          'co.project.simTime 或 .co/config.json'
        ),
        this.createInfoItem(
          '仿真后端',
          getSimBackend(resource),
          undefined,
          '.co/config.json: simulation.backend'
        )
      ]
    });

    // Toolchain section
    const toolChildren: SidebarItem[] = [];
    const java = getJava(resource);
    toolChildren.push(this.createToolItem('Java', java, 'co.checkToolchain'));
    toolChildren.push(this.createToolItem('Python', getPython(resource), 'co.checkToolchain'));
    const mars = getMarsJar(resource);
    toolChildren.push(this.createToolItem('MARS', mars, 'co.checkToolchain'));
    const logisim = getLogisimJar(resource);
    toolChildren.push(this.createToolItem('Logisim', logisim, 'co.checkToolchain'));
    const ise = getIsePath(resource);
    toolChildren.push(this.createToolItem('ISE', ise || '未配置', 'co.checkToolchain'));
    const hazard = getHazardCalculator(resource);
    if (hazard) {
      toolChildren.push(this.createToolItem('Hazard Calc', hazard, 'co.checkToolchain'));
    }
    sections.push({
      header: this.createHeader('工具链'),
      children: toolChildren
    });

    // Config source info
    if (hasCoConfig) {
      sections.push({
        header: this.createHeader('配置来源'),
        children: [
          this.createInfoItem('.co/config.json', '已加载', undefined, '项目级配置文件')
        ]
      });
    }

    // Actions section
    const actionChildren: SidebarItem[] = [
      this.createCommandItem('项目向导', 'co.projectWizard', 'new-folder'),
      this.createCommandItem('检查工具链', 'co.checkToolchain', 'check-all'),
      this.createCommandItem('选择 Profile', 'co.selectProjectProfile', 'settings-gear'),
      this.createCommandItem('刷新侧边栏', 'co.sidebar.refresh', 'refresh'),
      this.createCommandItem('MIPS 运行', 'co.mips.runCurrentFile', 'play'),
      this.createCommandItem('MIPS 带输入运行', 'co.mips.runWithStdinFile', 'terminal'),
      this.createCommandItem('MIPS 终端运行', 'co.mips.runInTerminal', 'terminal-powershell'),
      this.createCommandItem('MIPS 导出文本段', 'co.mips.dumpText', 'dump'),
      this.createCommandItem('Trace 文件对拍', 'co.test.compareTraceFiles', 'compare-changes'),
      this.createCommandItem('最近输出对拍', 'co.test.compareLatestOutputs', 'diff'),
      this.createCommandItem('完整 Trace 测试', 'co.test.runFullTest', 'run-all'),
      this.createCommandItem('批量 Trace 测试', 'co.test.runBatchTraceTests', 'list-selection'),
      this.createCommandItem('生成并批量测试', 'co.test.runGeneratedTraceTests', 'beaker'),
      this.createCommandItem('连续生成测试', 'co.test.startContinuousGeneratedTraceTests', 'sync'),
      this.createCommandItem('停止连续测试', 'co.test.stopContinuousTests', 'debug-stop'),
      this.createCommandItem('准备 Logisim 用例', 'co.test.prepareLogisimCases', 'file-submodule'),
      this.createCommandItem('生成 Logisim 用例', 'co.test.prepareGeneratedLogisimCases', 'files'),
      this.createCommandItem('打开批量报告', 'co.test.openBatchTraceReport', 'preview'),
      this.createCommandItem('Verilog Testbench', 'co.verilog.generateTestbench', 'file-code'),
      this.createCommandItem('Verilog ISE 工程', 'co.verilog.generateIseProject', 'project'),
      this.createCommandItem('Logisim ROM', 'co.logisim.generateRom', 'file-binary'),
      this.createCommandItem('Logisim 注入 ROM', 'co.logisim.injectRomIntoCircuit', 'circuit-board')
    ];
    if (profile === 'P5' || profile === 'P6') {
      actionChildren.push(this.createCommandItem('Hazard 分析', 'co.hazard.analyzeCurrentMachineCode', 'pulse'));
      actionChildren.push(this.createCommandItem('打开 Hazard 报告', 'co.hazard.openReport', 'json'));
    }
    sections.push({
      header: this.createHeader('操作'),
      children: actionChildren
    });

    return sections;
  }

  private createHeader(label: string): SidebarItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.contextValue = 'header';
    item.iconPath = new vscode.ThemeIcon('folder');
    return item;
  }

  private createInfoItem(
    label: string,
    value: string,
    command?: string,
    tooltip?: string,
    source?: string
  ): SidebarItem {
    const sourceLabel = source ? ` [${source}]` : '';
    const item = new vscode.TreeItem(`${label}: ${value}${sourceLabel}`, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'info';
    item.tooltip = tooltip ?? value;
    if (command) {
      item.command = {
        command,
        title: label,
        arguments: []
      };
    }
    return item;
  }

  private createToolItem(name: string, path: string, command: string): SidebarItem {
    const configured = path && path !== '未配置';
    const item = new vscode.TreeItem(
      `${name}: ${configured ? '✓' : '✗'}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.contextValue = 'tool';
    item.tooltip = configured ? path : `${name} 未配置 - 点击检查工具链`;
    item.iconPath = new vscode.ThemeIcon(configured ? 'check' : 'warning');
    item.command = {
      command,
      title: '检查工具链',
      arguments: []
    };
    return item;
  }

  private createCommandItem(label: string, command: string, icon: string): SidebarItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'action';
    item.command = {
      command,
      title: label,
      arguments: []
    };
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }
}
