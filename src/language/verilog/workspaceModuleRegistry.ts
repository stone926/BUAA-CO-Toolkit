import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseModules } from './moduleParser';
import { VerilogModule } from './model';

/**
 * 扩展宿主侧的工作空间模块注册表。
 * 后台扫描工作空间文件夹中所有 .v 文件，提取模块声明信息（模块名、端口名及方向）。
 * 供 sidebar 连线分析等跨文件模块查找使用。
 */
export class WorkspaceModuleRegistry {
  private readonly modules = new Map<string, VerilogModule[]>();
  private _scanning = true;
  private _disposed = false;

  /** 是否正在执行初始扫描 */
  get scanning(): boolean {
    return this._scanning;
  }

  /** 按名称查找模块（返回第一个匹配）。跨文件查找的核心入口。 */
  getModule(name: string): VerilogModule | undefined {
    return this.getModules(name)[0];
  }

  /** 按名称获取所有同名模块 */
  getModules(name: string): VerilogModule[] {
    return sortedModules(this.modules.get(name) ?? []);
  }

  /** 获取当前注册表中所有模块 */
  allModules(): VerilogModule[] {
    return sortedModules([...this.modules.values()].flat());
  }

  /** 按谓词查找模块，保持与 getModules 一致的稳定排序 */
  findModules(predicate: (module: VerilogModule) => boolean): VerilogModule[] {
    return this.allModules().filter(predicate);
  }

  /** 公开的单文件更新入口。用于生成用户 TB 后立即刷新索引。 */
  updateUri(uri: vscode.Uri): void {
    if (uri.scheme !== 'file' || !uri.fsPath.toLowerCase().endsWith('.v') || shouldSkipPath(uri.fsPath)) {
      return;
    }
    this.indexFile(uri.fsPath);
  }

  /** 公开的文件移除入口。用于文件系统删除事件清理旧模块记录。 */
  removeUri(uri: vscode.Uri): void {
    this.removeDocument(uri.toString());
  }

  /** 启动后台扫描 */
  activate(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      this._scanning = false;
      return;
    }

    // 立即解析所有已打开的 Verilog 文档
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === 'verilog') {
        this.indexDocument(doc);
      }
    }

    // 后台异步扫描所有工作空间文件夹中的 .v 文件
    const allFolders = folders.map((f) => f.uri.fsPath);
    this.scanFoldersAsync(allFolders);
  }

  /** 当文件保存或变更时更新该文件的模块信息 */
  updateDocument(document: vscode.TextDocument): void {
    if (document.languageId !== 'verilog') {
      return;
    }
    // 先移除旧条目
    this.removeDocument(document.uri.toString());
    this.indexDocument(document);
  }

  /** 移除某个文件的所有模块 */
  removeDocument(uri: string): void {
    for (const [name, list] of this.modules) {
      const filtered = list.filter((m) => m.uri !== uri);
      if (filtered.length) {
        this.modules.set(name, filtered);
      } else {
        this.modules.delete(name);
      }
    }
  }

  dispose(): void {
    this._disposed = true;
    this.modules.clear();
    this._scanning = false;
  }

  private indexDocument(document: vscode.TextDocument): void {
    try {
      const text = document.getText();
      const parsed = parseModules(
        TextDocument.create(document.uri.toString(), 'verilog', document.version, text),
        text
      );
      this.addModules(parsed);
    } catch {
      // 解析失败则跳过该文件
    }
  }

  private indexFile(filePath: string): void {
    if (this._disposed) {
      return;
    }
    const uri = vscode.Uri.file(filePath).toString();
    if (!fs.existsSync(filePath)) {
      this.removeDocument(uri);
      return;
    }
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const parsed = parseModules(
        TextDocument.create(uri, 'verilog', 0, text),
        text
      );
      // 清除该文件的旧条目后再添加
      this.removeDocument(uri);
      this.addModules(parsed);
    } catch {
      // 读取失败或解析失败则跳过
    }
  }

  private addModules(modules: VerilogModule[]): void {
    for (const mod of modules) {
      const list = this.modules.get(mod.name) ?? [];
      list.push(mod);
      this.modules.set(mod.name, list);
    }
  }

  private async scanFoldersAsync(folders: string[]): Promise<void> {
    this._scanning = true;
    // 收集已解析文件的 URI 集合
    const indexedUris = new Set<string>();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === 'verilog') {
        indexedUris.add(doc.uri.toString());
      }
    }

    // 收集所有 .v 文件
    const files = this.collectVerilogFiles(folders);
    // 过滤已解析的，分批异步处理以避免阻塞 UI
    const remaining = files.filter((f) => !indexedUris.has(vscode.Uri.file(f).toString()));

    for (let i = 0; i < remaining.length; i += 20) {
      if (this._disposed) {
        break;
      }
      const batch = remaining.slice(i, i + 20);
      for (const file of batch) {
        this.indexFile(file);
      }
      // 每批处理后让出事件循环
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this._scanning = false;
  }

  private collectVerilogFiles(folders: string[]): string[] {
    const files: string[] = [];
    const stack = [...folders];
    while (stack.length) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !shouldSkipDirectory(entry.name)) {
          stack.push(path.join(current, entry.name));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.v')) {
          files.push(path.join(current, entry.name));
        }
      }
    }
    return files;
  }
}

function shouldSkipDirectory(name: string): boolean {
  return (
    name === '.git' ||
    name === '.co' ||
    name === '.vscode' ||
    name === '.vscode-test' ||
    name === 'node_modules' ||
    name === 'out' ||
    name === 'dist' ||
    name === 'build' ||
    name === 'coverage'
  );
}

function shouldSkipPath(filePath: string): boolean {
  return filePath.split(/[\\/]+/).some(shouldSkipDirectory);
}

function sortedModules(modules: VerilogModule[]): VerilogModule[] {
  return [...modules].sort((left, right) => moduleRank(left) - moduleRank(right) || left.uri.localeCompare(right.uri) || left.name.localeCompare(right.name));
}

function moduleRank(module: VerilogModule): number {
  const active = vscode.window.activeTextEditor?.document.uri.toString();
  if (active && module.uri === active) {
    return 0;
  }
  if (vscode.workspace.textDocuments.some((doc) => doc.uri.toString() === module.uri)) {
    return 10;
  }
  return 20;
}
