import * as fs from 'fs';
import * as path from 'path';
import { Location, WorkspaceFolder } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { rangesEqual } from '../common/lsp';
import { CoSettings, defaultCoSettings } from '../common/settings';
import { getCachedStrippedText, getCachedVerilogParse, clearCachedVerilogParse } from './parseCache';
import { VerilogInclude, VerilogMacro, VerilogMacroUse, VerilogModule, VerilogPortConnection } from './model';
import { VerilogSemanticModel, VerilogSemanticSymbol, VerilogSemanticSymbolKind } from './semanticModel';
import { yieldEventLoop } from '../../nodeFs';
import { extractVerilogDisplayFormats } from './displayFormats';

export type VerilogConnectionListKind = 'ports' | 'parameters';

export interface VerilogIndexedFile {
  uri: string;
  text: string;
  textKey: string;
  /** 去除注释和字符串后的文本，避免下游重复计算 */
  strippedText: string;
  modules: VerilogModule[];
  macros: VerilogMacro[];
  macroUses: VerilogMacroUse[];
  includes: VerilogInclude[];
  displayFormats: string[];
  semantic: VerilogSemanticModel;
}

export class VerilogWorkspaceIndex {
  private readonly files = new Map<string, VerilogIndexedFile>();
  private readonly modules = new Map<string, VerilogModule[]>();
  private readonly macros = new Map<string, VerilogMacro[]>();
  private readonly moduleReferenceIndex = new Map<string, Location[]>();
  private readonly interfaceConnectionReferenceIndex = new Map<string, Location[]>();
  private readonly macroUseReferenceIndex = new Map<string, Location[]>();
  private readonly macroDefinitionIndex = new Map<string, Location[]>();
  private readonly referenceIndexKeysByUri = new Map<string, Array<{ index: Map<string, Location[]>; key: string }>>();
  private readonly maxFiles: number;
  private readonly openDocumentUris = new Set<string>();
  private fileListCache: VerilogIndexedFile[] | undefined;
  private moduleListCache: VerilogModule[] | undefined;
  private macroListCache: VerilogMacro[] | undefined;
  private displayFormatListCache: string[] | undefined;
  private caseInsensitiveModuleCache = new Map<string, VerilogModule | undefined>();
  private caseInsensitiveInstanceCache = new Map<string, boolean>();
  private rebuildSequence = 0;
  private revision = 0;
  private workspaceComplete: boolean;

  constructor(options: { maxFiles?: number; workspaceComplete?: boolean } = {}) {
    this.maxFiles = options.maxFiles ?? 5000;
    this.workspaceComplete = options.workspaceComplete ?? true;
  }

  get version(): number {
    return this.revision;
  }

  get complete(): boolean {
    return this.workspaceComplete;
  }

  async rebuild(workspaceFolders: WorkspaceFolder[] | null | undefined, settings: CoSettings): Promise<void> {
    const sequence = ++this.rebuildSequence;
    this.setWorkspaceComplete(false);
    this.clear();
    if (!workspaceFolders?.length) {
      this.markRebuildComplete(sequence);
      return;
    }
    for (const folder of workspaceFolders) {
      const folderPath = URI.parse(folder.uri).fsPath;
      for await (const file of scanVerilogFiles(folderPath, this.maxFiles - this.files.size)) {
        if (sequence !== this.rebuildSequence) {
          return;
        }
        if (this.files.size >= this.maxFiles) {
          this.markRebuildComplete(sequence);
          return;
        }
        await this.updateFileFromDiskAsync(URI.file(file).toString(), settings, {
          rebuildSequence: sequence,
          skipOpenDocuments: true
        });
      }
    }
    this.markRebuildComplete(sequence);
  }

  updateFile(uri: string, settings: CoSettings): void {
    this.updateFileFromDisk(uri, settings);
  }

  async updateFileAsync(uri: string, settings: CoSettings): Promise<void> {
    await this.updateFileFromDiskAsync(uri, settings);
  }

  updateDocument(document: TextDocument, settings: CoSettings): void {
    this.openDocumentUris.add(document.uri);
    this.updateDocumentIndexed(document, settings);
  }

  async closeDocument(uri: string, settings: CoSettings): Promise<void> {
    this.openDocumentUris.delete(uri);
    if (!isVerilogUri(uri)) {
      this.removeIndexed(uri);
      return;
    }
    await this.updateFileAsync(uri, settings);
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

  private async updateFileFromDiskAsync(
    uri: string,
    settings: CoSettings,
    options: { rebuildSequence?: number; skipOpenDocuments?: boolean } = {}
  ): Promise<void> {
    if (!isVerilogUri(uri)) {
      return;
    }
    if (options.skipOpenDocuments && this.openDocumentUris.has(uri)) {
      return;
    }
    try {
      const filePath = URI.parse(uri).fsPath;
      const text = await fs.promises.readFile(filePath, 'utf8');
      if (options.rebuildSequence !== undefined && options.rebuildSequence !== this.rebuildSequence) {
        return;
      }
      if (options.skipOpenDocuments && this.openDocumentUris.has(uri)) {
        return;
      }
      this.updateFileText(uri, text, settings);
    } catch {
      // 单文件读取或解析失败不影响整体索引
      if (options.rebuildSequence === undefined || options.rebuildSequence === this.rebuildSequence) {
        this.removeIndexed(uri);
      }
    }
  }

  private updateDocumentIndexed(document: TextDocument, _settings: CoSettings): void {
    if (document.languageId !== 'verilog') {
      return;
    }
    const text = document.getText();
    const key = textKey(text);
    const existing = this.files.get(document.uri);
    if (existing && existing.textKey === key && existing.text === text) {
      return;
    }
    this.removeIndexed(document.uri);
    const parsed = getCachedVerilogParse(document, defaultCoSettings, false);
    const file: VerilogIndexedFile = {
      uri: document.uri,
      text,
      textKey: key,
      strippedText: getCachedStrippedText(document, defaultCoSettings),
      modules: parsed.modules,
      macros: parsed.macros,
      macroUses: parsed.macroUses,
      includes: parsed.includes,
      displayFormats: extractVerilogDisplayFormats(text),
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
    this.addReferenceIndexEntries(file);
    this.invalidateCaches();
  }

  private updateFileText(uri: string, text: string, settings: CoSettings): void {
    const document = TextDocument.create(uri, 'verilog', 0, text);
    this.updateDocumentIndexed(document, settings);
  }

  remove(uri: string): void {
    this.openDocumentUris.delete(uri);
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
    this.removeReferenceIndexEntries(uri);
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

  indexedDisplayFormats(): readonly string[] {
    this.displayFormatListCache ??= this.indexedFiles().flatMap((file) => file.displayFormats);
    return this.displayFormatListCache;
  }

  moduleReferenceLocations(moduleName: string): readonly Location[] {
    return this.moduleReferenceIndex.get(moduleName) ?? [];
  }

  interfaceConnectionLocations(
    moduleName: string,
    connectionName: string,
    listKind: VerilogConnectionListKind
  ): readonly Location[] {
    return this.interfaceConnectionReferenceIndex.get(interfaceConnectionKey(moduleName, connectionName, listKind)) ?? [];
  }

  macroUseLocations(name: string): readonly Location[] {
    return this.macroUseReferenceIndex.get(name) ?? [];
  }

  macroDefinitionLocations(name: string): readonly Location[] {
    return this.macroDefinitionIndex.get(name) ?? [];
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
    this.revision++;
    this.fileListCache = undefined;
    this.moduleListCache = undefined;
    this.macroListCache = undefined;
    this.displayFormatListCache = undefined;
    this.caseInsensitiveModuleCache.clear();
    this.caseInsensitiveInstanceCache.clear();
  }

  private markRebuildComplete(sequence: number): void {
    if (sequence === this.rebuildSequence) {
      this.setWorkspaceComplete(true);
    }
  }

  private setWorkspaceComplete(value: boolean): void {
    if (this.workspaceComplete === value) {
      return;
    }
    this.workspaceComplete = value;
    this.invalidateCaches();
  }

  private clear(): void {
    this.files.clear();
    this.modules.clear();
    this.macros.clear();
    this.moduleReferenceIndex.clear();
    this.interfaceConnectionReferenceIndex.clear();
    this.macroUseReferenceIndex.clear();
    this.macroDefinitionIndex.clear();
    this.referenceIndexKeysByUri.clear();
    this.invalidateCaches();
  }

  private addReferenceIndexEntries(file: VerilogIndexedFile): void {
    for (const macro of file.macros) {
      this.addIndexedLocation(this.macroDefinitionIndex, macro.name, Location.create(file.uri, macro.selectionRange), file.uri);
    }
    for (const macroUse of file.macroUses) {
      this.addIndexedLocation(this.macroUseReferenceIndex, macroUse.name, Location.create(file.uri, macroUse.selectionRange), file.uri);
    }
    for (const module of file.modules) {
      for (const instance of module.instances) {
        this.addIndexedLocation(this.moduleReferenceIndex, instance.moduleName, Location.create(file.uri, instance.moduleSelectionRange), file.uri);
        this.addConnectionReferences(file.uri, instance.moduleName, instance.portConnections, 'ports');
        this.addConnectionReferences(file.uri, instance.moduleName, instance.parameterConnections, 'parameters');
      }
    }
  }

  private addConnectionReferences(
    uri: string,
    moduleName: string,
    connections: readonly VerilogPortConnection[],
    listKind: VerilogConnectionListKind
  ): void {
    for (const connection of connections) {
      if (connection.name && connection.nameRange) {
        this.addIndexedLocation(
          this.interfaceConnectionReferenceIndex,
          interfaceConnectionKey(moduleName, connection.name, listKind),
          Location.create(uri, connection.nameRange),
          uri
        );
      }
    }
  }

  private addIndexedLocation(index: Map<string, Location[]>, key: string, location: Location, uri: string): void {
    const locations = index.get(key) ?? [];
    locations.push(location);
    index.set(key, locations);
    const keys = this.referenceIndexKeysByUri.get(uri) ?? [];
    keys.push({ index, key });
    this.referenceIndexKeysByUri.set(uri, keys);
  }

  private removeReferenceIndexEntries(uri: string): void {
    const keys = this.referenceIndexKeysByUri.get(uri);
    if (!keys) {
      return;
    }
    this.referenceIndexKeysByUri.delete(uri);
    const seen = new Set<string>();
    for (const { index, key } of keys) {
      const seenKey = `${mapIdentity(index)}\u0000${key}`;
      if (seen.has(seenKey)) {
        continue;
      }
      seen.add(seenKey);
      removeLocationsByUri(index, key, uri);
    }
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

function removeLocationsByUri(map: Map<string, Location[]>, key: string, uri: string): void {
  removeByUri(map, key, uri, (location) => location.uri);
}

function interfaceConnectionKey(moduleName: string, connectionName: string, listKind: VerilogConnectionListKind): string {
  return `${moduleName}\u0000${listKind}\u0000${connectionName}`;
}

function mapIdentity(map: Map<string, Location[]>): string {
  return String(mapIdentityIds.get(map) ?? assignMapIdentity(map));
}

const mapIdentityIds = new WeakMap<Map<string, Location[]>, number>();
let nextMapIdentity = 1;

function assignMapIdentity(map: Map<string, Location[]>): number {
  const id = nextMapIdentity++;
  mapIdentityIds.set(map, id);
  return id;
}

function textKey(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${hash >>> 0}`;
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
