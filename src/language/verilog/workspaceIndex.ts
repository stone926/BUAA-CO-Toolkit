import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceFolder } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { CoSettings } from '../common/settings';
import { parseVerilog } from './parser';
import { VerilogModule } from './model';

export class VerilogWorkspaceIndex {
  private readonly modules = new Map<string, VerilogModule>();

  async rebuild(workspaceFolders: WorkspaceFolder[] | null | undefined, settings: CoSettings): Promise<void> {
    this.modules.clear();
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
    for (const [name, module] of this.modules) {
      if (module.uri === document.uri) {
        this.modules.delete(name);
      }
    }
    const parsed = parseVerilog(document, settings, false);
    for (const module of parsed.modules) {
      this.modules.set(module.name, module);
    }
  }

  remove(uri: string): void {
    for (const [name, module] of this.modules) {
      if (module.uri === uri) {
        this.modules.delete(name);
      }
    }
  }

  getModule(name: string): VerilogModule | undefined {
    return this.modules.get(name);
  }

  allModules(): VerilogModule[] {
    return [...this.modules.values()];
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

