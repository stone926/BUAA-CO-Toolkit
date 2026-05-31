import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceFolder } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { CoSettings } from '../common/settings';
import { stripCommentsAndStrings } from './parser';
import { getCachedVerilogParse } from './parseCache';
import { VerilogInclude, VerilogMacro, VerilogMacroUse, VerilogModule } from './model';

export interface VerilogIndexedFile {
  uri: string;
  text: string;
  /** 去除注释和字符串后的文本，避免下游重复计算 */
  strippedText: string;
  modules: VerilogModule[];
  macros: VerilogMacro[];
  macroUses: VerilogMacroUse[];
  includes: VerilogInclude[];
}

export class VerilogWorkspaceIndex {
  private readonly files = new Map<string, VerilogIndexedFile>();
  private readonly modules = new Map<string, VerilogModule[]>();
  private readonly macros = new Map<string, VerilogMacro[]>();

  async rebuild(workspaceFolders: WorkspaceFolder[] | null | undefined, settings: CoSettings): Promise<void> {
    this.files.clear();
    this.modules.clear();
    this.macros.clear();
    if (!workspaceFolders?.length) {
      return;
    }
    for (const folder of workspaceFolders) {
      const folderPath = URI.parse(folder.uri).fsPath;
      for (const file of scanVerilogFiles(folderPath)) {
        const text = fs.readFileSync(file, 'utf8');
        const uri = URI.file(file).toString();
        const document = TextDocument.create(uri, 'verilog', 0, text);
        this.updateDocument(document, settings);
      }
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
      strippedText: stripCommentsAndStrings(document.getText()),
      modules: parsed.modules,
      macros: parsed.macros,
      macroUses: parsed.macroUses,
      includes: parsed.includes
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
  }

  remove(uri: string): void {
    const existing = this.files.get(uri);
    if (!existing) {
      return;
    }
    this.files.delete(uri);
    for (const module of existing.modules) {
      removeByUri(this.modules, module.name, uri, (item) => item.uri);
    }
    for (const macro of existing.macros) {
      removeByUri(this.macros, macro.name, uri, () => uri);
    }
  }

  getModule(name: string): VerilogModule | undefined {
    return this.modules.get(name)?.[0];
  }

  getModules(name: string): VerilogModule[] {
    return this.modules.get(name) ?? [];
  }

  allModules(): VerilogModule[] {
    return [...this.modules.values()].flat();
  }

  getMacro(name: string): VerilogMacro | undefined {
    return this.macros.get(name)?.[0];
  }

  getMacros(name: string): VerilogMacro[] {
    return this.macros.get(name) ?? [];
  }

  allMacros(): VerilogMacro[] {
    return [...this.macros.values()].flat();
  }

  allFiles(): VerilogIndexedFile[] {
    return [...this.files.values()];
  }

  getFile(uri: string): VerilogIndexedFile | undefined {
    return this.files.get(uri);
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

function scanVerilogFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
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
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'out') {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.v')) {
        files.push(fullPath);
      }
    }
  }
  return files;
}
