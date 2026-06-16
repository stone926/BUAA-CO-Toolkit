import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceFolder } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { CoSettings } from '../common/settings';
import { getCachedStrippedText, getCachedVerilogParse, clearCachedVerilogParse } from './parseCache';
import { VerilogInclude, VerilogMacro, VerilogMacroUse, VerilogModule } from './model';
import { VerilogCstDocument } from './cst';
import { VerilogSemanticModel } from './semanticModel';

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

  constructor(options: { maxFiles?: number } = {}) {
    this.maxFiles = options.maxFiles ?? 5000;
  }

  async rebuild(workspaceFolders: WorkspaceFolder[] | null | undefined, settings: CoSettings): Promise<void> {
    this.files.clear();
    this.modules.clear();
    this.macros.clear();
    this.invalidateCaches();
    if (!workspaceFolders?.length) {
      return;
    }
    for (const folder of workspaceFolders) {
      const folderPath = URI.parse(folder.uri).fsPath;
      for (const file of scanVerilogFiles(folderPath, this.maxFiles - this.files.size)) {
        if (this.files.size >= this.maxFiles) {
          return;
        }
        this.updateFile(URI.file(file).toString(), settings);
      }
    }
  }

  updateFile(uri: string, settings: CoSettings): void {
    if (!isVerilogUri(uri)) {
      return;
    }
    try {
      const filePath = URI.parse(uri).fsPath;
      if (!fs.existsSync(filePath)) {
        this.remove(uri);
        return;
      }
      const text = fs.readFileSync(filePath, 'utf8');
      const document = TextDocument.create(uri, 'verilog', 0, text);
      this.updateDocument(document, settings);
    } catch {
      // 单文件解析失败不影响整体索引
      this.remove(uri);
    }
  }

  updateDocument(document: TextDocument, settings: CoSettings): void {
    if (document.languageId !== 'verilog') {
      return;
    }
    this.remove(document.uri);
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

  remove(uri: string): void {
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

  getFile(uri: string): VerilogIndexedFile | undefined {
    return this.files.get(uri);
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

function scanVerilogFiles(root: string, limit: number): string[] {
  const files: string[] = [];
  if (limit <= 0) {
    return files;
  }
  const stack = [root];
  while (stack.length && files.length < limit) {
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
      if (entry.isDirectory() && shouldSkipDirectory(entry.name)) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.v')) {
        files.push(fullPath);
        if (files.length >= limit) {
          break;
        }
      }
    }
  }
  return files;
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
    return false;
  }
}
