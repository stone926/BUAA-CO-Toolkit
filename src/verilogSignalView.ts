import * as vscode from 'vscode';
import { Range as LspRange } from 'vscode-languageserver/node';
import { parseVerilog } from './language/verilog/service';
import { analyzeSignalWiring, SignalWiringEntry, SignalWiringEntryKind } from './language/verilog/signalWiring';
import { coSettingsForUri, toTextDocument } from './verilog';
import { WorkspaceModuleRegistry } from './language/verilog/workspaceModuleRegistry';

const placeholderMessage = '将光标放在 Verilog 信号上以查看其连线';

interface WiringEntryNode {
  kind: 'entry';
  label: string;
  description: string;
  icon: string;
  uri: vscode.Uri;
  range: vscode.Range;
}

interface WiringGroupNode {
  kind: 'group';
  label: string;
  children: WiringEntryNode[];
}

type WiringNode = WiringGroupNode | WiringEntryNode;

class VerilogSignalWiringProvider implements vscode.TreeDataProvider<WiringNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: WiringNode[] = [];
  message: string | undefined = placeholderMessage;

  private cacheKey: string | undefined;
  private cacheParsed: ReturnType<typeof parseVerilog> | undefined;

  constructor(private readonly moduleRegistry: WorkspaceModuleRegistry) {}

  update(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): void {
    this.compute(editor);
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: WiringNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'co.signalGroup';
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    item.tooltip = `${node.label}\n${node.uri.fsPath}:${node.range.start.line + 1}`;
    item.command = {
      command: 'vscode.open',
      title: '打开',
      arguments: [node.uri, { selection: node.range, preview: true } as vscode.TextDocumentShowOptions]
    };
    return item;
  }

  getChildren(node?: WiringNode): WiringNode[] {
    if (!node) {
      return this.roots;
    }
    return node.kind === 'group' ? node.children : [];
  }

  private compute(editor: vscode.TextEditor | undefined): void {
    this.roots = [];
    if (!editor || editor.document.languageId !== 'verilog') {
      this.message = placeholderMessage;
      return;
    }
    const doc = editor.document;
    const parsed = this.parse(doc);
    const position = editor.selection.active;
    const report = analyzeSignalWiring(parsed, toTextDocument(doc), {
      line: position.line,
      character: position.character
    }, (name: string) => this.moduleRegistry.getModule(name));
    if (!report) {
      this.message = placeholderMessage;
      return;
    }

    // 构建 message：显示扫描状态
    const scanningSuffix = this.moduleRegistry.scanning ? ' · 正在解析项目结构...' : '';
    this.message = `信号 ${report.name} · 模块 ${report.moduleName}${scanningSuffix}`;

    const groups: WiringGroupNode[] = [];
    if (report.declaration) {
      groups.push({
        kind: 'group',
        label: '声明',
        children: [{
          kind: 'entry',
          label: report.declaration.detail,
          description: `:${report.declaration.range.start.line + 1}`,
          icon: 'symbol-variable',
          uri: doc.uri,
          range: toVscodeRange(report.declaration.range)
        }]
      });
    }
    groups.push({
      kind: 'group',
      label: `驱动 / 写 (${report.drivers.length})`,
      children: report.drivers.map((entry) => this.entryNode(doc, entry))
    });
    groups.push({
      kind: 'group',
      label: `读取 / 使用 (${report.readers.length})`,
      children: report.readers.map((entry) => this.entryNode(doc, entry))
    });
    if (report.unresolved.length) {
      const suffix = this.moduleRegistry.scanning ? ' · 解析中...' : ' · 未定义模块';
      groups.push({
        kind: 'group',
        label: `未解析连接 (${report.unresolved.length})${suffix}`,
        children: report.unresolved.map((entry) => this.entryNode(doc, entry))
      });
    }
    this.roots = groups;
  }

  private entryNode(doc: vscode.TextDocument, entry: SignalWiringEntry): WiringEntryNode {
    const range = toVscodeRange(entry.range);
    const lineText = doc.lineAt(range.start.line).text.trim();
    const portPrefix = entry.instanceName ? `${entry.instanceName}.${entry.portName ?? '?'} · ` : '';
    return {
      kind: 'entry',
      label: lineText || entry.kind,
      description: `${portPrefix}:${range.start.line + 1}`,
      icon: iconForEntry(entry.kind),
      uri: doc.uri,
      range
    };
  }

  private parse(doc: vscode.TextDocument): ReturnType<typeof parseVerilog> {
    const key = `${doc.uri.toString()}@${doc.version}`;
    if (this.cacheKey === key && this.cacheParsed) {
      return this.cacheParsed;
    }
    const parsed = parseVerilog(toTextDocument(doc), coSettingsForUri(doc.uri), false);
    this.cacheKey = key;
    this.cacheParsed = parsed;
    return parsed;
  }
}

export function registerVerilogSignalView(context: vscode.ExtensionContext, moduleRegistry: WorkspaceModuleRegistry): void {
  const provider = new VerilogSignalWiringProvider(moduleRegistry);
  const treeView = vscode.window.createTreeView('coVerilogSignal', { treeDataProvider: provider });
  context.subscriptions.push(treeView);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = (editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): void => {
    provider.update(editor);
    treeView.message = provider.message;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('co.verilog.inspectSignal', () => {
      void vscode.commands.executeCommand('setContext', 'co.verilogSignalVisible', true);
      refresh();
      void vscode.commands.executeCommand('coVerilogSignal.focus');
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor.document.languageId !== 'verilog') {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => refresh(event.textEditor), 150);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => refresh())
  );

  refresh();
}

function toVscodeRange(range: LspRange): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function iconForEntry(kind: SignalWiringEntryKind): string {
  switch (kind) {
    case 'assign':
      return 'arrow-small-right';
    case 'always':
      return 'sync';
    case 'instancePortDriver':
    case 'instancePortReader':
    case 'instancePort':
      return 'circuit-board';
    case 'instancePortUnresolved':
      return 'warning';
    case 'use':
      return 'eye';
    default:
      return 'symbol-variable';
  }
}
