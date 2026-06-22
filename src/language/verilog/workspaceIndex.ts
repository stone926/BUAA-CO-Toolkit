import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceFolder } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { rangesEqual } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { getCachedStrippedText, getCachedVerilogParse, clearCachedVerilogParse } from './parseCache';
import { VerilogInclude, VerilogMacro, VerilogMacroUse, VerilogModule } from './model';
import { VerilogCstDocument } from './cst';
import { VerilogSemanticModel, VerilogSemanticSymbol, VerilogSemanticSymbolKind } from './semanticModel';
import { yieldEventLoop } from '../../nodeFs';

export interface VerilogIndexedFile {
  uri: string;
  text: string;
  /** 去除注释和字符串后的文本，避免下游重复计算 */
  strippedText: string;
  modules: VerilogModule[];
  macros: VerilogMacro[];
  macroUses: VerilogMacroUse[];
  includes: VerilogInclude[];
  cst: VerilogCstDocument;
  semantic: VerilogSemanticModel;
}

export class VerilogWorkspaceIndex {
  private readonly files = new Map<string, VerilogIndexedFile>();
  private readonly modules = new Map<string, VerilogModule[]>();
  private readonly macros = new Map<string, VerilogMacro[]>();
  private readonly maxFiles: number;
  private fileListCache: VerilogIndexedFile[] | undefined;
  private moduleListCache: VerilogModule[] | undefined;
  private macroListCache: VerilogMacro[] | undefined;
  private caseInsensitiveModuleCache = new Map<string, VerilogModule | undefined>();
  private caseInsensitiveInstanceCache = new Map<string, boolean>();
  private rebuildSequence = 0;

  constructor(options: { maxFiles?: number } = {}) {
    this.maxFiles = options.maxFiles ?? 5000;
  }

  async rebuild(workspaceFolders: WorkspaceFolder[] | null | undefined, settings: CoSettings): Promise<void> {
    const sequence = ++this.rebuildSequence;
    this.clear();
    if (!workspaceFolders?.length) {
      return;
    }
    for (const folder of workspaceFolders) {
      const folderPath = URI.parse(folder.uri).fsPath;
      for await (const file of scanVerilogFiles(folderPath, this.maxFiles - this.files.size)) {
        if (sequence !== this.rebuildSequence) {
          return;
        }
        if (this.files.size >= this.maxFiles) {
          return;
        }
        await this.updateFileFromDiskAsync(URI.file(file).toString(), settings, sequence);
      }
    }
  }

  updateFile(uri: string, settings: CoSettings): void {
    this.rebuildSequence++;
    this.updateFileFromDisk(uri, settings);
  }

  async updateFileAsync(uri: string, settings: CoSettings): Promise<void> {
    this.rebuildSequence++;
    await this.updateFileFromDiskAsync(uri, settings);
  }

  updateDocument(document: TextDocument, settings: CoSettings): void {
    this.rebuildSequence++;
    this.updateDocumentIndexed(document, settings);
  }

  private updateFileFromDisk(uri: string, settings: CoSettings): void {
    if (!isVerilogUri(uri)) {
      return;
    }
    try {
      const filePath = URI.parse(uri).fsPath;
      if (!fs.existsSync(filePath)) {
        this.removeIndexed(uri);
        return;
      }
      const text = fs.readFileSync(filePath, 'utf8');
      this.updateFileText(uri, text, settings);
    } catch {
      // 单文件解析失败不影响整体索引
      this.removeIndexed(uri);
    }
  }

  private async updateFileFromDiskAsync(uri: string, settings: CoSettings, rebuildSequence?: number): Promise<void> {
    if (!isVerilogUri(uri)) {
      return;
    }
    try {
      const filePath = URI.parse(uri).fsPath;
      const text = await fs.promises.readFile(filePath, 'utf8');
      if (rebuildSequence !== undefined && rebuildSequence !== this.rebuildSequence) {
        return;
      }
      this.updateFileText(uri, text, settings);
    } catch {
      // 单文件读取或解析失败不影响整体索引
      if (rebuildSequence === undefined || rebuildSequence === this.rebuildSequence) {
        this.removeIndexed(uri);
      }
    }
  }

  private updateDocumentIndexed(document: TextDocument, settings: CoSettings): void {
    if (document.languageId !== 'verilog') {
      return;
    }
    this.removeIndexed(document.uri);
    const parsed = getCachedVerilogParse(document, settings, false);
    const file: VerilogIndexedFile = {
      uri: document.uri,
      text: document.getText(),
      strippedText: getCachedStrippedText(document, settings),
      modules: parsed.modules,
      macros: parsed.macros,
      macroUses: parsed.macroUses,
      includes: parsed.includes,
      cst: parsed.cst,
      semantic: parsed.semantic
    };
    this.files.set(document.uri, file);
    for (const module of parsed.modules) {
      const list = this.modules.get(module.name) ?? [];
      list.push(module);
      this.modules.set(module.name, list);
    }
    for (const macro of parsed.macros) {
      const list = this.macros.get(macro.name) ?? [];
      list.push(macro);
      this.macros.set(macro.name, list);
    }
    this.invalidateCaches();
  }

  private updateFileText(uri: string, text: string, settings: CoSettings): void {
    const document = TextDocument.create(uri, 'verilog', 0, text);
    this.updateDocumentIndexed(document, settings);
  }

  remove(uri: string): void {
    this.rebuildSequence++;
    this.removeIndexed(uri);
  }

  private removeIndexed(uri: string): void {
    const existing = this.files.get(uri);
    if (!existing) {
      clearCachedVerilogParse(uri);
      return;
    }
    clearCachedVerilogParse(uri);
    this.files.delete(uri);
    for (const module of existing.modules) {
      removeByUri(this.modules, module.name, uri, (item) => item.uri);
    }
    for (const macro of existing.macros) {
      removeByUri(this.macros, macro.name, uri, () => uri);
    }
    this.invalidateCaches();
  }

  getModule(name: string): VerilogModule | undefined {
    return this.modules.get(name)?.[0];
  }

  getModules(name: string): VerilogModule[] {
    return this.modules.get(name) ?? [];
  }

  allModules(): VerilogModule[] {
    return [...this.indexedModules()];
  }

  getMacro(name: string): VerilogMacro | undefined {
    return this.macros.get(name)?.[0];
  }

  getMacros(name: string): VerilogMacro[] {
    return this.macros.get(name) ?? [];
  }

  allMacros(): VerilogMacro[] {
    return [...this.indexedMacros()];
  }

  allFiles(): VerilogIndexedFile[] {
    return [...this.indexedFiles()];
  }

  allSymbols(): VerilogSemanticSymbol[] {
    return this.indexedFiles().flatMap((file) => file.semantic.symbols);
  }

  getFile(uri: string): VerilogIndexedFile | undefined {
    return this.files.get(uri);
  }

  getSemantic(uri: string): VerilogSemanticModel | undefined {
    return this.files.get(uri)?.semantic;
  }

  getModuleSemantic(module: VerilogModule): VerilogSemanticModel | undefined {
    return this.getSemantic(module.uri);
  }

  getModuleSymbols(module: VerilogModule): VerilogSemanticSymbol[] {
    const semantic = this.getModuleSemantic(module);
    if (!semantic) {
      return [];
    }
    return semantic.symbols.filter((symbol) => sameModuleIdentity(symbol.module, module));
  }

  findModuleSymbol(
    module: VerilogModule,
    name: string,
    kinds?: readonly VerilogSemanticSymbolKind[]
  ): VerilogSemanticSymbol | undefined {
    const kindSet = kinds ? new Set(kinds) : undefined;
    return this.getModuleSymbols(module).find((symbol) =>
      symbol.name === name &&
      (!kindSet || kindSet.has(symbol.kind))
    );
  }

  indexedFiles(): readonly VerilogIndexedFile[] {
    this.fileListCache ??= [...this.files.values()];
    return this.fileListCache;
  }

  indexedModules(): readonly VerilogModule[] {
    this.moduleListCache ??= [...this.modules.values()].flat();
    return this.moduleListCache;
  }

  indexedMacros(): readonly VerilogMacro[] {
    this.macroListCache ??= [...this.macros.values()].flat();
    return this.macroListCache;
  }

  findModuleCaseInsensitive(name: string): VerilogModule | undefined {
    const lower = name.toLowerCase();
    if (this.caseInsensitiveModuleCache.has(lower)) {
      return this.caseInsensitiveModuleCache.get(lower);
    }
    const module = this.indexedModules().find((candidate) => candidate.name.toLowerCase() === lower);
    this.caseInsensitiveModuleCache.set(lower, module);
    return module;
  }

  hasInstanceOfModuleCaseInsensitive(moduleName: string): boolean {
    const lower = moduleName.toLowerCase();
    const cached = this.caseInsensitiveInstanceCache.get(lower);
    if (cached !== undefined) {
      return cached;
    }
    const found = this.indexedModules().some((module) =>
      module.instances.some((instance) => instance.moduleName.toLowerCase() === lower)
    );
    this.caseInsensitiveInstanceCache.set(lower, found);
    return found;
  }

  private invalidateCaches(): void {
    this.fileListCache = undefined;
    this.moduleListCache = undefined;
    this.macroListCache = undefined;
    this.caseInsensitiveModuleCache.clear();
    this.caseInsensitiveInstanceCache.clear();
  }

  private clear(): void {
    this.files.clear();
    this.modules.clear();
    this.macros.clear();
    this.invalidateCaches();
  }
}

function removeByUri<T>(map: Map<string, T[]>, key: string, uri: string, getUri: (item: T) => string): void {
  const list = map.get(key);
  if (!list) {
    return;
  }
  const filtered = list.filter((item) => getUri(item) !== uri);
  if (filtered.length) {
    map.set(key, filtered);
  } else {
    map.delete(key);
  }
}

function sameModuleIdentity(left: VerilogModule | undefined, right: VerilogModule): boolean {
  if (!left) {
    return false;
  }
  return left === right ||
    (left.uri === right.uri && left.name === right.name && rangesEqual(left.selectionRange, right.selectionRange));
}

async function* scanVerilogFiles(root: string, limit: number): AsyncGenerator<string> {
  if (limit <= 0) {
    return;
  }
  let files = 0;
  const stack = [root];
  while (stack.length && files < limit) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      // 无法读取的目录不参与工作区索引
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && shouldSkipDirectory(entry.name)) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.v')) {
        yield fullPath;
        files++;
        if (files >= limit) {
          break;
        }
      }
    }
    await yieldEventLoop();
  }
}

function shouldSkipDirectory(name: string): boolean {
  return name === '.git' ||
    name === '.co' ||
    name === '.vscode' ||
    name === '.vscode-test' ||
    name === 'node_modules' ||
    name === 'out' ||
    name === 'dist' ||
    name === 'build' ||
    name === 'coverage';
}

export function isVerilogUri(uri: string): boolean {
  try {
    return URI.parse(uri).fsPath.toLowerCase().endsWith('.v');
  } catch {
    // URI 格式异常时按非 Verilog 文件处理
    return false;
  }
}
