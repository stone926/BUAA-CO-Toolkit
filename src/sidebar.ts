import * as path from 'path';
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
import { getProfileRequiredTools } from './courseConfig';
import {
  getProfileTutorialLink,
  getToolTutorialLinksForProfile
} from './courseLinks';
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

    const tutorialChildren = this.createTutorialItems(profile);
    sections.push({
      header: this.createHeader('课程教程'),
      children: tutorialChildren
    });

    // Toolchain section
    const toolChildren: SidebarItem[] = [];
    const requiredTools = new Set(getProfileRequiredTools(profile).map((tool) => tool.toLowerCase()));
    const showAllTools = profile === 'auto' || requiredTools.size === 0;
    if (showAllTools || requiredTools.has('java')) {
      toolChildren.push(this.createToolItem('Java', getJava(resource), 'co.checkToolchain'));
    }
    if (showAllTools) {
      toolChildren.push(this.createToolItem('Python', getPython(resource), 'co.checkToolchain'));
    }
    if (showAllTools || requiredTools.has('mars') || requiredTools.has('marsp7')) {
      toolChildren.push(this.createToolItem('MARS', getMarsJar(resource), 'co.checkToolchain'));
    }
    if (showAllTools || requiredTools.has('logisim')) {
      toolChildren.push(this.createToolItem('Logisim', getLogisimJar(resource), 'co.checkToolchain'));
    }
    if (showAllTools || requiredTools.has('ise')) {
      const ise = getIsePath(resource);
      toolChildren.push(this.createToolItem('ISE', ise || '未配置', 'co.checkToolchain'));
    }
    const hazardDir = getHazardCalculator(resource);
    if (hazardDir) {
      toolChildren.push(this.createToolItem('Hazard 工具', hazardDir, 'co.checkToolchain'));
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
      this.createCommandItem('刷新侧边栏', 'co.sidebar.refresh', 'refresh')
    ];
    const activeDocument = vscode.window.activeTextEditor?.document;
    const language = activeDocument?.languageId;
    const isLogisimCircuit = activeDocument ? this.isLogisimCircuitFile(activeDocument.uri) : false;
    if (this.shouldShowMipsActions(profile, language)) {
      actionChildren.push(
      this.createCommandItem('ASM 运行', 'co.mips.runCurrentFile', 'play'),
      this.createCommandItem('ASM 带输入运行', 'co.mips.runWithStdinFile', 'terminal'),
      this.createCommandItem('ASM 终端运行', 'co.mips.runInTerminal', 'terminal-powershell'),
        this.createCommandItem('ASM 导出文本段', 'co.mips.dumpText', 'dump')
      );
      if (profile === 'P7' || profile === 'auto') {
        actionChildren.push(this.createCommandItem('ASM 导出内核段', 'co.mips.dumpKernelText', 'dump'));
      }
    }
    if (this.shouldShowAsmGenerationActions(profile)) {
      actionChildren.push(
        this.createCommandItem('生成 ASM 测试点', 'co.test.generateAsmTests', 'file-code'),
        this.createCommandItem('生成并导出机器码', 'co.test.generateAndDumpAsmTests', 'dump')
      );
    }
    if (this.shouldShowTraceTestActions(profile)) {
      actionChildren.push(
      this.createCommandItem('手动选择输出对拍', 'co.test.compareTraceFiles', 'compare-changes'),
      this.createCommandItem('最近输出对拍', 'co.test.compareLatestOutputs', 'diff'),
      this.createCommandItem('单 ASM 测试', 'co.test.runFullTest', 'run-all'),
      this.createCommandItem('多 ASM 批量测试', 'co.test.runBatchTraceTests', 'list-selection'),
      this.createCommandItem('生成并批量测试', 'co.test.runGeneratedTraceTests', 'beaker'),
      this.createCommandItem('持续生成测试', 'co.test.startContinuousGeneratedTraceTests', 'sync'),
      this.createCommandItem('停止持续测试', 'co.test.stopContinuousTests', 'debug-stop'),
        this.createCommandItem('打开批量测试报告', 'co.test.openBatchTraceReport', 'preview')
      );
    }
    if (this.shouldShowLogisimActions(profile, language, isLogisimCircuit)) {
      actionChildren.push(
        this.createCommandItem('准备 Logisim 用例', 'co.test.prepareLogisimCases', 'file-submodule'),
        this.createCommandItem('生成 Logisim 用例', 'co.test.prepareGeneratedLogisimCases', 'files'),
        this.createCommandItem('Logisim ROM', 'co.logisim.generateRom', 'file-binary'),
        this.createCommandItem('Logisim 注入 ROM', 'co.logisim.injectRomIntoCircuit', 'circuit-board'),
        this.createCommandItem('Logisim Logging 转 CSV', 'co.logisim.convertLogToCsv', 'table'),
        this.createCommandItem('打开 Logisim 电路', 'co.logisim.openCurrentCircuit', 'circuit-board')
      );
    }
    if (this.shouldShowVerilogActions(profile, language)) {
      actionChildren.push(
      this.createCommandItem('Verilog Testbench', 'co.verilog.generateTestbench', 'file-code'),
      this.createCommandItem('Verilog ISE 工程', 'co.verilog.generateIseProject', 'project'),
        this.createCommandItem('Verilog 运行 ISim', 'co.verilog.runIsim', 'run')
      );
    }
    if (profile === 'P5' || profile === 'P6' || profile === 'P7') {
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

  private createTutorialItems(profile: ProjectProfile): SidebarItem[] {
    const items: SidebarItem[] = [
      this.createCommandItem('课程教程首页', 'co.course.openTutorial', 'book')
    ];
    const profileLink = getProfileTutorialLink(profile);
    if (profileLink) {
      items.push(this.createTutorialLinkItem(`${profile} 教程`, profileLink, 'symbol-class'));
    }
    for (const link of getToolTutorialLinksForProfile(profile)) {
      items.push(this.createTutorialLinkItem(link.title, link, 'link-external'));
    }
    return items;
  }

  private createTutorialLinkItem(label: string, link: { title: string; path: string; description?: string }, icon: string): SidebarItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'tutorial';
    item.tooltip = link.description ?? link.title;
    item.command = {
      command: 'co.course.openTutorialLink',
      title: label,
      arguments: [link]
    };
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }

  private shouldShowMipsActions(profile: ProjectProfile, language?: string): boolean {
    return language === 'mipsasm' || profile === 'auto' || ['P2', 'P4', 'P5', 'P6', 'P7'].includes(profile);
  }

  private shouldShowVerilogActions(profile: ProjectProfile, language?: string): boolean {
    return language === 'verilog' || profile === 'auto' || ['P1', 'P4', 'P5', 'P6', 'P7'].includes(profile);
  }

  private shouldShowLogisimActions(profile: ProjectProfile, language: string | undefined, isLogisimCircuit: boolean): boolean {
    return isLogisimCircuit || language === 'logisim-circ' || profile === 'auto' || profile === 'P0' || profile === 'P3';
  }

  private shouldShowTraceTestActions(profile: ProjectProfile): boolean {
    return profile === 'auto' || ['P4', 'P5', 'P6'].includes(profile);
  }

  private shouldShowAsmGenerationActions(profile: ProjectProfile): boolean {
    return profile === 'auto' || ['P3', 'P4', 'P5', 'P6', 'P7'].includes(profile);
  }

  private isLogisimCircuitFile(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && path.extname(uri.fsPath).toLowerCase() === '.circ';
  }
}
