import { Commands } from './constants';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getProfile,
  getTopModule,
  getTestbench,
  getMachineCode,
  getSimTime,
  getJava,
  getPython,
  getMarsJar,
  getLogisimJar,
  getIsePath,
  getHazardCalculator,
  getMipsEngine
} from './config';
import {
  buildSidebarModel,
  SidebarActiveFileModel,
  SidebarNodeModel,
  SidebarToolModel
} from './sidebarModel';
import { ProjectProfile } from './types';
import { workspaceFolderForOrFirst } from './fsUtil';
import { getEffectiveRequiredTools } from './toolchainPolicy';

export type SidebarItem = vscode.TreeItem & { children?: SidebarItem[]; contextValue?: string };

export class CoSidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SidebarItem): SidebarItem {
    return element;
  }

  getChildren(element?: SidebarItem): SidebarItem[] {
    if (element) {
      return element.children ?? [];
    }
    return this.buildTree();
  }

  private buildTree(): SidebarItem[] {
    return buildSidebarModel(this.buildModelContext()).map((node) => this.createTreeItem(node));
  }

  private buildModelContext() {
    const activeDocument = this.currentTextDocument();
    const resource = activeDocument?.uri;
    const profile = getProfile(resource);
    const folder = workspaceFolderForOrFirst(resource);

    return {
      profile,
      workspaceName: folder?.name,
      workspacePath: folder?.uri.fsPath,
      configSource: 'VS Code settings' as const,
      topModule: getTopModule(resource),
      testbench: getTestbench(resource),
      machineCode: getMachineCode(resource),
      simTime: getSimTime(resource),
      verilogBackend: 'Icarus Verilog（内置）',
      iseConfigured: Boolean(getIsePath(resource).trim()),
      activeFile: this.activeFileModel(activeDocument),
      tools: this.createToolModels(profile, resource)
    };
  }

  private currentTextDocument(): vscode.TextDocument | undefined {
    const active = vscode.window.activeTextEditor?.document;
    if (active?.uri.scheme === 'file') {
      return active;
    }
    return vscode.window.visibleTextEditors
      .map((editor) => editor.document)
      .find((document) => document.uri.scheme === 'file') ?? active;
  }

  private createTreeItem(node: SidebarNodeModel): SidebarItem {
    const children = node.children?.map((child) => this.createTreeItem(child)) ?? [];
    const state = children.length
      ? node.expanded === false
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, state) as SidebarItem;
    item.id = node.id;
    item.contextValue = node.contextValue ?? node.kind;
    item.description = node.description;
    item.tooltip = node.tooltip;
    if (node.icon) {
      item.iconPath = new vscode.ThemeIcon(node.icon);
    }
    if (node.command) {
      item.command = {
        command: node.command.command,
        title: node.command.title ?? node.label,
        arguments: node.command.arguments ?? []
      };
    }
    item.children = children;
    return item;
  }

  private activeFileModel(document: vscode.TextDocument | undefined): SidebarActiveFileModel | undefined {
    if (!document || document.uri.scheme !== 'file') {
      return undefined;
    }
    return {
      languageId: document.languageId,
      fsPath: document.uri.fsPath,
      basename: path.basename(document.uri.fsPath),
      isLogisimCircuit: this.isLogisimCircuitFile(document.uri)
    };
  }

  private createToolModels(profile: ProjectProfile, resource?: vscode.Uri): SidebarToolModel[] {
    const tools: SidebarToolModel[] = [];
    const requiredTools = new Set(
      getEffectiveRequiredTools(profile, getMipsEngine(resource)).map((tool) => tool.toLowerCase())
    );
    const showAllTools = profile !== 'auto' && requiredTools.size === 0;
    if (showAllTools || requiredTools.has('java')) {
      tools.push(this.createToolModel('java', 'Java', getJava(resource)));
    }
    if (showAllTools) {
      tools.push(this.createToolModel('python', 'Python', getPython(resource)));
    }
    if (showAllTools || requiredTools.has('mars') || requiredTools.has('marsp7')) {
      tools.push(this.createToolModel('mars', 'MARS', getMarsJar(resource)));
    }
    if (showAllTools || requiredTools.has('logisim')) {
      tools.push(this.createToolModel('logisim', 'Logisim', getLogisimJar(resource)));
    }
    if (showAllTools || requiredTools.has('verilogsimulator')) {
      tools.push(this.createToolModel('verilogSimulator', 'Verilog simulator', 'Icarus Verilog（内置）'));
    }
    const hazardDir = getHazardCalculator(resource);
    if (hazardDir) {
      tools.push(this.createToolModel('hazard', 'Hazard 工具', hazardDir));
    }
    return tools;
  }

  private createToolModel(id: string, name: string, value: string | undefined): SidebarToolModel {
    const normalized = value?.trim() ?? '';
    return {
      id,
      name,
      value: normalized || '未配置',
      configured: Boolean(normalized)
    };
  }

  private isLogisimCircuitFile(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && path.extname(uri.fsPath).toLowerCase() === '.circ';
  }
}
