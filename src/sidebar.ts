import * as vscode from 'vscode';
import {
  getProfile,
  getTopModule,
  getTestbench,
  getMachineCode,
  getSimTime,
  getSimBackend,
  getJava,
  getMarsJar,
  getLogisimJar,
  getIsePath,
  getHazardCalculator
} from './config';
import { getProjectConfig } from './projectConfig';
import { ProjectProfile } from './types';

export type SidebarItem = vscode.TreeItem & { contextValue?: string };

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
      return this.getRootItems();
    }
    return [];
  }

  private getRootItems(): SidebarItem[] {
    const items: SidebarItem[] = [];
    const resource = vscode.window.activeTextEditor?.document.uri;
    const profile = getProfile(resource);
    const coConfig = getProjectConfig(resource);
    const hasCoConfig = coConfig !== undefined;

    // Project section
    items.push(this.createHeader('项目配置'));
    items.push(this.createInfoItem(
      'Profile',
      profile,
      'co.selectProjectProfile',
      '点击切换 Profile',
      hasCoConfig && coConfig?.profile === profile ? '.co' : 'settings'
    ));
    items.push(this.createInfoItem(
      '顶层模块',
      getTopModule(resource),
      undefined,
      'co.project.topModule 或 .co/config.json'
    ));
    items.push(this.createInfoItem(
      'Testbench',
      getTestbench(resource),
      undefined,
      'co.project.testbench 或 .co/config.json'
    ));
    items.push(this.createInfoItem(
      '机器码文件',
      getMachineCode(resource),
      undefined,
      'co.project.machineCode 或 .co/config.json'
    ));
    items.push(this.createInfoItem(
      '仿真时长',
      getSimTime(resource),
      undefined,
      'co.project.simTime 或 .co/config.json'
    ));
    items.push(this.createInfoItem(
      '仿真后端',
      getSimBackend(resource),
      undefined,
      '.co/config.json: simulation.backend'
    ));

    // Toolchain section
    items.push(this.createHeader('工具链'));
    const java = getJava(resource);
    items.push(this.createToolItem('Java', java, 'co.checkToolchain'));
    const mars = getMarsJar(resource);
    items.push(this.createToolItem('MARS', mars, 'co.checkToolchain'));
    const logisim = getLogisimJar(resource);
    items.push(this.createToolItem('Logisim', logisim, 'co.checkToolchain'));
    const ise = getIsePath(resource);
    items.push(this.createToolItem('ISE', ise || '未配置', 'co.checkToolchain'));
    const hazard = getHazardCalculator(resource);
    if (hazard) {
      items.push(this.createToolItem('Hazard Calc', hazard, 'co.checkToolchain'));
    }

    // Config source info
    if (hasCoConfig) {
      items.push(this.createHeader('配置来源'));
      items.push(this.createInfoItem('.co/config.json', '已加载', undefined, '项目级配置文件'));
    }

    // Actions section
    items.push(this.createHeader('操作'));
    items.push(this.createCommandItem('项目向导', 'co.projectWizard', 'new-folder'));
    items.push(this.createCommandItem('检查工具链', 'co.checkToolchain', 'check-all'));
    items.push(this.createCommandItem('选择 Profile', 'co.selectProjectProfile', 'settings-gear'));
    items.push(this.createCommandItem('刷新侧边栏', 'co.sidebar.refresh', 'refresh'));
    items.push(this.createCommandItem('MIPS 运行', 'co.mips.runCurrentFile', 'play'));
    items.push(this.createCommandItem('MIPS 导出文本段', 'co.mips.dumpText', 'dump'));
    items.push(this.createCommandItem('Verilog Testbench', 'co.verilog.generateTestbench', 'file-code'));
    items.push(this.createCommandItem('Verilog ISE 工程', 'co.verilog.generateIseProject', 'project'));
    items.push(this.createCommandItem('Logisim ROM', 'co.logisim.generateRom', 'file-binary'));

    return items;
  }

  private createHeader(label: string): SidebarItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'header';
    item.iconPath = new vscode.ThemeIcon('symbol-namespace');
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
