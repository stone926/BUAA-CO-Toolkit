import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  config,
  getIsePath,
  getProfile,
  getSimTime,
  getTestbench,
  getTopModule
} from './config';
import { ensureDirectory, workspaceFolderFor, writeTextFile } from './fsUtil';
import { runTool } from './process';
import { findFuse } from './toolchain';
import { AppServices, ProjectProfile } from './types';

type VerilogDeclKind = 'input' | 'output' | 'inout' | 'wire' | 'reg' | 'logic' | 'integer' | 'parameter' | 'localparam' | 'genvar';

interface VerilogDecl {
  name: string;
  kind: VerilogDeclKind;
  width?: string;
  range: vscode.Range;
  selectionRange: vscode.Range;
  direction?: 'input' | 'output' | 'inout';
}

interface VerilogInstance {
  moduleName: string;
  instanceName: string;
  range: vscode.Range;
  selectionRange: vscode.Range;
}

interface VerilogModule {
  name: string;
  ports: VerilogDecl[];
  declarations: Map<string, VerilogDecl>;
  instances: VerilogInstance[];
  range: vscode.Range;
  selectionRange: vscode.Range;
  headerEnd: vscode.Position;
  uri: vscode.Uri;
  bodyText: string;
}

interface VerilogMacro {
  name: string;
  range: vscode.Range;
  selectionRange: vscode.Range;
}

interface VerilogParseResult {
  modules: VerilogModule[];
  macros: VerilogMacro[];
  diagnostics: vscode.Diagnostic[];
}

const verilogKeywords = new Set([
  'always',
  'and',
  'assign',
  'begin',
  'case',
  'casex',
  'casez',
  'default',
  'defparam',
  'else',
  'end',
  'endcase',
  'endfunction',
  'endgenerate',
  'endmodule',
  'endtask',
  'for',
  'forever',
  'function',
  'generate',
  'genvar',
  'if',
  'initial',
  'inout',
  'input',
  'integer',
  'localparam',
  'module',
  'negedge',
  'or',
  'output',
  'parameter',
  'posedge',
  'reg',
  'repeat',
  'signed',
  'task',
  'wire',
  'while',
  'logic'
]);

const systemTasks = new Set([
  'display',
  'monitor',
  'finish',
  'stop',
  'readmemh',
  'readmemb',
  'dumpfile',
  'dumpvars',
  'fsdbDumpfile',
  'fsdbDumpvars',
  'time'
]);

const expectedPorts: Record<string, Record<string, string | undefined>> = {
  P4: {
    clk: undefined,
    reset: undefined
  },
  P5: {
    clk: undefined,
    reset: undefined
  },
  P6: {
    clk: undefined,
    reset: undefined,
    i_inst_rdata: '[31:0]',
    m_data_rdata: '[31:0]',
    i_inst_addr: '[31:0]',
    m_data_addr: '[31:0]',
    m_data_wdata: '[31:0]',
    m_data_byteen: '[3:0]',
    m_inst_addr: '[31:0]',
    w_grf_we: undefined,
    w_grf_addr: '[4:0]',
    w_grf_wdata: '[31:0]',
    w_inst_addr: '[31:0]'
  },
  P7: {
    clk: undefined,
    reset: undefined,
    interrupt: undefined,
    macroscopic_pc: '[31:0]',
    i_inst_addr: '[31:0]',
    i_inst_rdata: '[31:0]',
    m_data_addr: '[31:0]',
    m_data_rdata: '[31:0]',
    m_data_wdata: '[31:0]',
    m_data_byteen: '[3:0]',
    m_int_addr: '[31:0]',
    m_int_byteen: '[3:0]',
    m_inst_addr: '[31:0]',
    w_grf_we: undefined,
    w_grf_addr: '[4:0]',
    w_grf_wdata: '[31:0]',
    w_inst_addr: '[31:0]'
  }
};

class VerilogWorkspaceIndex {
  private modules = new Map<string, VerilogModule>();

  async rebuild(): Promise<void> {
    this.modules.clear();
    const files = await vscode.workspace.findFiles('**/*.v', '**/{node_modules,out,.git}/**', 5000);
    for (const uri of files) {
      const document = await vscode.workspace.openTextDocument(uri);
      this.updateDocument(document);
    }
  }

  updateDocument(document: vscode.TextDocument): void {
    if (document.languageId !== 'verilog') {
      return;
    }
    for (const [name, module] of this.modules) {
      if (module.uri.toString() === document.uri.toString()) {
        this.modules.delete(name);
      }
    }
    const parsed = parseVerilog(document, false);
    for (const module of parsed.modules) {
      this.modules.set(module.name, module);
    }
  }

  remove(uri: vscode.Uri): void {
    for (const [name, module] of this.modules) {
      if (module.uri.toString() === uri.toString()) {
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

export function registerVerilog(context: vscode.ExtensionContext, services: AppServices): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('buaa-co-verilog');
  const index = new VerilogWorkspaceIndex();
  context.subscriptions.push(diagnostics);

  const refresh = (document: vscode.TextDocument) => {
    if (document.languageId === 'verilog') {
      index.updateDocument(document);
      diagnostics.set(document.uri, parseVerilog(document, true).diagnostics);
    }
  };

  void index.rebuild().then(() => {
    for (const document of vscode.workspace.textDocuments) {
      refresh(document);
    }
  });

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
      index.remove(document.uri);
    }),
    vscode.languages.registerCompletionItemProvider({ language: 'verilog' }, new VerilogCompletionProvider(index), '.', '`'),
    vscode.languages.registerHoverProvider({ language: 'verilog' }, new VerilogHoverProvider(index)),
    vscode.languages.registerDefinitionProvider({ language: 'verilog' }, new VerilogDefinitionProvider(index)),
    vscode.languages.registerDocumentSymbolProvider({ language: 'verilog' }, new VerilogDocumentSymbolProvider()),
    vscode.languages.registerCodeActionsProvider({ language: 'verilog' }, new VerilogCodeActionProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    }),
    vscode.commands.registerCommand('co.verilog.generateTestbench', () => generateTestbench(index)),
    vscode.commands.registerCommand('co.verilog.generateIseProject', () => generateIseProject(services)),
    vscode.commands.registerCommand('co.verilog.runIsim', () => runIsim(services))
  );
}

class VerilogCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly index: VerilogWorkspaceIndex) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const currentModule = moduleAtPosition(parseVerilog(document, false).modules, position);
    if (currentModule) {
      for (const decl of currentModule.declarations.values()) {
        const item = new vscode.CompletionItem(decl.name, vscode.CompletionItemKind.Variable);
        item.detail = declDetail(decl);
        items.push(item);
      }
      for (const instance of currentModule.instances) {
        const item = new vscode.CompletionItem(instance.instanceName, vscode.CompletionItemKind.Reference);
        item.detail = `Instance of ${instance.moduleName}`;
        items.push(item);
      }
    }

    for (const module of this.index.allModules()) {
      const item = new vscode.CompletionItem(module.name, vscode.CompletionItemKind.Class);
      item.detail = 'Verilog module';
      item.documentation = new vscode.MarkdownString(module.ports.map((port) => `${port.direction ?? port.kind} ${port.width ?? ''} ${port.name}`.trim()).join('\n'));
      items.push(item);
    }

    for (const keyword of verilogKeywords) {
      items.push(new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword));
    }

    items.push(snippetItem('always_ff', 'always @(posedge ${1:clk}) begin\n    ${0}\nend', 'Clocked always block'));
    items.push(snippetItem('always_comb', 'always @(*) begin\n    ${0}\nend', 'Combinational always block'));
    items.push(snippetItem('display_p5_grf', '$display("%d@%h: $%d <= %h", $time, ${1:WPC}, ${2:Waddr}, ${3:WData});', 'BUAA CO P5 GRF display'));
    return items;
  }
}

class VerilogHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: VerilogWorkspaceIndex) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!wordRange) {
      return undefined;
    }
    const word = document.getText(wordRange);
    const parsed = parseVerilog(document, false);
    const currentModule = moduleAtPosition(parsed.modules, position);
    if (currentModule) {
      const decl = currentModule.declarations.get(word);
      if (decl) {
        return new vscode.Hover(`\`${declDetail(decl)}\``, wordRange);
      }
      const instance = currentModule.instances.find((item) => item.instanceName === word);
      if (instance) {
        return new vscode.Hover(`Instance \`${instance.instanceName}\` of module \`${instance.moduleName}\`.`, wordRange);
      }
    }
    const module = this.index.getModule(word) ?? parsed.modules.find((item) => item.name === word);
    if (module) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**module ${module.name}**\n\n`);
      if (module.ports.length) {
        md.appendCodeblock(module.ports.map((port) => `${port.direction ?? port.kind} ${port.width ?? ''} ${port.name}`.trim()).join('\n'), 'verilog');
      }
      return new vscode.Hover(md, wordRange);
    }
    return undefined;
  }
}

class VerilogDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly index: VerilogWorkspaceIndex) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!wordRange) {
      return undefined;
    }
    const word = document.getText(wordRange);
    const parsed = parseVerilog(document, false);
    const currentModule = moduleAtPosition(parsed.modules, position);
    if (currentModule) {
      const decl = currentModule.declarations.get(word);
      if (decl) {
        return new vscode.Location(document.uri, decl.selectionRange);
      }
      const instance = currentModule.instances.find((item) => item.instanceName === word);
      if (instance) {
        return new vscode.Location(document.uri, instance.selectionRange);
      }
    }
    const module = this.index.getModule(word) ?? parsed.modules.find((item) => item.name === word);
    if (module) {
      return new vscode.Location(module.uri, module.selectionRange);
    }
    return undefined;
  }
}

class VerilogDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    return parseVerilog(document, false).modules.map((module) => {
      const symbol = new vscode.DocumentSymbol(module.name, 'module', vscode.SymbolKind.Module, module.range, module.selectionRange);
      for (const port of module.ports) {
        symbol.children.push(new vscode.DocumentSymbol(port.name, declDetail(port), vscode.SymbolKind.Field, port.range, port.selectionRange));
      }
      for (const decl of module.declarations.values()) {
        if (module.ports.some((port) => port.name === decl.name)) {
          continue;
        }
        symbol.children.push(new vscode.DocumentSymbol(decl.name, declDetail(decl), vscode.SymbolKind.Variable, decl.range, decl.selectionRange));
      }
      for (const instance of module.instances) {
        symbol.children.push(new vscode.DocumentSymbol(instance.instanceName, instance.moduleName, vscode.SymbolKind.Object, instance.range, instance.selectionRange));
      }
      return symbol;
    });
  }
}

class VerilogCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const implicit = context.diagnostics.find((diagnostic) => typeof diagnostic.code === 'string' && diagnostic.code.startsWith('implicit-net:'));
    if (implicit && typeof implicit.code === 'string') {
      const name = implicit.code.slice('implicit-net:'.length);
      const parsed = parseVerilog(document, false);
      const module = moduleAtPosition(parsed.modules, range.start) ?? parsed.modules[0];
      if (module) {
        actions.push(makeDeclareWireAction(document, module, name));
      }
    }

    const defaultNettype = context.diagnostics.find((diagnostic) => diagnostic.code === 'default-nettype-none');
    if (defaultNettype) {
      const action = new vscode.CodeAction('Add `default_nettype none', vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.insert(document.uri, new vscode.Position(0, 0), '`default_nettype none\n');
      actions.push(action);
    }

    return actions;
  }
}

export function parseVerilog(document: vscode.TextDocument, includeDiagnostics: boolean): VerilogParseResult {
  const text = document.getText();
  const modules = parseModules(document, text);
  const macros = parseMacros(document, text);
  const diagnostics = includeDiagnostics ? collectVerilogDiagnostics(document, text, modules) : [];
  return {
    modules,
    macros,
    diagnostics
  };
}

async function generateTestbench(index: VerilogWorkspaceIndex): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'verilog') {
    vscode.window.showErrorMessage('Open a Verilog file first.');
    return;
  }
  const parsed = parseVerilog(editor.document, false);
  const target = moduleAtPosition(parsed.modules, editor.selection.active) ?? parsed.modules[0];
  if (!target) {
    vscode.window.showErrorMessage('No Verilog module found in the current file.');
    return;
  }
  index.updateDocument(editor.document);
  const configuredTb = getTestbench(editor.document.uri);
  const tbName = target.name === getTopModule(editor.document.uri) ? configuredTb : `${target.name}_tb`;
  const tbUri = vscode.Uri.file(path.join(path.dirname(editor.document.uri.fsPath), `${tbName}.v`));
  if (fs.existsSync(tbUri.fsPath)) {
    const choice = await vscode.window.showWarningMessage(`${path.basename(tbUri.fsPath)} already exists.`, 'Open', 'Overwrite');
    if (choice === 'Open') {
      await vscode.window.showTextDocument(tbUri);
      return;
    }
    if (choice !== 'Overwrite') {
      return;
    }
  }
  await writeTextFile(tbUri, buildTestbench(target, tbName));
  await vscode.window.showTextDocument(tbUri);
}

async function generateIseProject(services: AppServices): Promise<{ prj: vscode.Uri; tcl: vscode.Uri; outDir: vscode.Uri } | undefined> {
  const folder = workspaceFolderFor(vscode.window.activeTextEditor?.document.uri);
  if (!folder) {
    vscode.window.showErrorMessage('Open a workspace folder before generating ISE files.');
    return undefined;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const top = getTestbench(activeUri);
  const simTime = getSimTime(activeUri);
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.v'), '**/{node_modules,out,.git}/**', 5000);
  if (!files.length) {
    vscode.window.showErrorMessage('No Verilog files found in the workspace.');
    return undefined;
  }

  const outDir = vscode.Uri.file(path.join(folder.uri.fsPath, '.co', 'isim'));
  await ensureDirectory(outDir);
  const prj = vscode.Uri.file(path.join(outDir.fsPath, `${top}.prj`));
  const tcl = vscode.Uri.file(path.join(outDir.fsPath, `${top}.tcl`));
  const prjText = files
    .map((uri) => `Verilog work "${uri.fsPath.replace(/\\/g, '/')}"`)
    .sort()
    .join('\n') + '\n';
  const tclText = `run ${simTime};\nexit\n`;
  await writeTextFile(prj, prjText);
  await writeTextFile(tcl, tclText);
  services.output.appendLine(`Generated ${prj.fsPath}`);
  services.output.appendLine(`Generated ${tcl.fsPath}`);
  vscode.window.showInformationMessage('Generated ISE PRJ/TCL files.');
  return { prj, tcl, outDir };
}

async function runIsim(services: AppServices): Promise<void> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const isePath = getIsePath(activeUri);
  if (!isePath) {
    vscode.window.showErrorMessage('ISE path is not configured. Set co.toolchain.isePath.');
    return;
  }
  const fuse = findFuse(isePath);
  if (!fs.existsSync(fuse)) {
    vscode.window.showErrorMessage(`Cannot find fuse executable: ${fuse}`);
    return;
  }
  const generated = await generateIseProject(services);
  if (!generated) {
    return;
  }
  const top = getTestbench(activeUri);
  const exeName = process.platform === 'win32' ? `${top}.exe` : top;
  services.output.show(true);
  const fuseResult = await runTool(fuse, ['-nodebug', '-prj', path.basename(generated.prj.fsPath), '-o', exeName, top], {
    cwd: generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: {
      XILINX: isePath
    }
  });
  if (!fuseResult.ok) {
    vscode.window.showErrorMessage('ISim compile failed. Check the BUAA CO output panel.');
    return;
  }
  const exePath = path.join(generated.outDir.fsPath, exeName);
  const simResult = await runTool(exePath, ['-nolog', '-tclbatch', path.basename(generated.tcl.fsPath)], {
    cwd: generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: {
      XILINX: isePath
    }
  });
  if (simResult.ok) {
    const out = vscode.Uri.file(path.join(generated.outDir.fsPath, `${top}.sim.out`));
    await writeTextFile(out, simResult.stdout);
    vscode.window.showInformationMessage('ISim run completed.');
  } else {
    vscode.window.showErrorMessage('ISim run failed. Check the BUAA CO output panel.');
  }
}

function parseModules(document: vscode.TextDocument, text: string): VerilogModule[] {
  const modules: VerilogModule[] = [];
  const moduleRegex = /\bmodule\s+([A-Za-z_]\w*)\s*(?:#\s*\(([\s\S]*?)\)\s*)?\(([\s\S]*?)\)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = moduleRegex.exec(text))) {
    const name = match[1];
    const header = match[3] ?? '';
    const bodyStartOffset = match.index + match[0].length;
    const endOffset = findEndmodule(text, bodyStartOffset);
    const range = new vscode.Range(document.positionAt(match.index), document.positionAt(endOffset));
    const nameOffset = match.index + match[0].indexOf(name);
    const selectionRange = new vscode.Range(document.positionAt(nameOffset), document.positionAt(nameOffset + name.length));
    const bodyText = text.slice(bodyStartOffset, endOffset);
    const module: VerilogModule = {
      name,
      ports: [],
      declarations: new Map(),
      instances: [],
      range,
      selectionRange,
      headerEnd: document.positionAt(bodyStartOffset),
      uri: document.uri,
      bodyText
    };
    for (const port of parseHeaderPorts(document, text, header, match.index)) {
      module.ports.push(port);
      module.declarations.set(port.name, port);
    }
    for (const decl of parseDeclarations(document, text, bodyStartOffset, endOffset)) {
      const existing = module.declarations.get(decl.name);
      if (existing && (decl.kind === 'input' || decl.kind === 'output' || decl.kind === 'inout')) {
        const merged = {
          ...existing,
          ...decl,
          direction: decl.kind
        };
        module.declarations.set(decl.name, merged);
        const portIndex = module.ports.findIndex((port) => port.name === decl.name);
        if (portIndex >= 0) {
          module.ports[portIndex] = merged;
        }
      } else {
        module.declarations.set(decl.name, decl);
        if (decl.kind === 'input' || decl.kind === 'output' || decl.kind === 'inout') {
          module.ports.push({
            ...decl,
            direction: decl.kind
          });
        }
      }
    }
    module.instances = parseInstances(document, text, bodyStartOffset, endOffset, module.name);
    modules.push(module);
  }
  return modules;
}

function parseMacros(document: vscode.TextDocument, text: string): VerilogMacro[] {
  const macros: VerilogMacro[] = [];
  const macroRegex = /^\s*`define\s+([A-Za-z_]\w*)/gm;
  let match: RegExpExecArray | null;
  while ((match = macroRegex.exec(text))) {
    const offset = match.index + match[0].indexOf(match[1]);
    macros.push({
      name: match[1],
      range: document.lineAt(document.positionAt(offset).line).range,
      selectionRange: new vscode.Range(document.positionAt(offset), document.positionAt(offset + match[1].length))
    });
  }
  return macros;
}

function parseHeaderPorts(document: vscode.TextDocument, fullText: string, header: string, moduleStart: number): VerilogDecl[] {
  const ports: VerilogDecl[] = [];
  const parts = splitTopLevelCommas(header);
  let inheritedDirection: 'input' | 'output' | 'inout' | undefined;
  let inheritedWidth: string | undefined;
  for (const part of parts) {
    const trimmed = part.trim();
    const directionMatch = trimmed.match(/^(input|output|inout)\b/);
    const widthMatch = trimmed.match(/\[[^\]]+\]/);
    const port = parseDeclFragment(document, fullText, part, moduleStart, true);
    if (port) {
      if (!port.direction && inheritedDirection) {
        port.direction = inheritedDirection;
        port.kind = inheritedDirection;
      }
      if (!port.width && inheritedWidth) {
        port.width = inheritedWidth;
      }
      ports.push(port);
    }
    if (directionMatch) {
      inheritedDirection = directionMatch[1] as 'input' | 'output' | 'inout';
    }
    if (widthMatch) {
      inheritedWidth = normalizeWidth(widthMatch[0]);
    } else if (directionMatch) {
      inheritedWidth = undefined;
    }
  }
  return ports;
}

function parseDeclarations(document: vscode.TextDocument, fullText: string, startOffset: number, endOffset: number): VerilogDecl[] {
  const text = fullText.slice(startOffset, endOffset);
  const declarations: VerilogDecl[] = [];
  const declRegex = /\b(input|output|inout|wire|reg|logic|integer|parameter|localparam|genvar)\b\s*(?:(?:reg|wire|logic)\s+)?(?:signed\s+)?(\[[^\]]+\]\s*)?([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = declRegex.exec(text))) {
    const kind = match[1] as VerilogDeclKind;
    const width = normalizeWidth(match[2]);
    const names = splitTopLevelCommas(match[3]);
    for (const rawName of names) {
      const nameMatch = rawName.trim().match(/^([A-Za-z_]\w*)/);
      if (!nameMatch) {
        continue;
      }
      const name = nameMatch[1];
      const absoluteNameOffset = startOffset + match.index + match[0].indexOf(rawName) + rawName.indexOf(name);
      declarations.push({
        name,
        kind,
        width,
        direction: kind === 'input' || kind === 'output' || kind === 'inout' ? kind : undefined,
        range: new vscode.Range(document.positionAt(startOffset + match.index), document.positionAt(startOffset + match.index + match[0].length)),
        selectionRange: new vscode.Range(document.positionAt(absoluteNameOffset), document.positionAt(absoluteNameOffset + name.length))
      });
    }
  }
  return declarations;
}

function parseDeclFragment(document: vscode.TextDocument, fullText: string, fragment: string, moduleStart: number, headerOnly: boolean): VerilogDecl | undefined {
  const trimmed = fragment.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^(?:(input|output|inout)\s+)?(?:(reg|wire|logic)\s+)?(?:signed\s+)?(\[[^\]]+\]\s*)?([A-Za-z_]\w*)$/);
  if (!match) {
    const nameOnly = trimmed.match(/^([A-Za-z_]\w*)$/);
    if (!nameOnly) {
      return undefined;
    }
    const offset = fullText.indexOf(nameOnly[1], moduleStart);
    return {
      name: nameOnly[1],
      kind: 'wire',
      range: new vscode.Range(document.positionAt(offset), document.positionAt(offset + nameOnly[1].length)),
      selectionRange: new vscode.Range(document.positionAt(offset), document.positionAt(offset + nameOnly[1].length))
    };
  }
  const direction = match[1] as 'input' | 'output' | 'inout' | undefined;
  const kind = (direction ?? match[2] ?? 'wire') as VerilogDeclKind;
  const name = match[4];
  const offset = fullText.indexOf(name, moduleStart);
  return {
    name,
    kind,
    direction,
    width: normalizeWidth(match[3]),
    range: new vscode.Range(document.positionAt(offset), document.positionAt(offset + fragment.length)),
    selectionRange: new vscode.Range(document.positionAt(offset), document.positionAt(offset + name.length))
  };
}

function parseInstances(document: vscode.TextDocument, fullText: string, startOffset: number, endOffset: number, currentModuleName: string): VerilogInstance[] {
  const text = stripCommentsAndStrings(fullText.slice(startOffset, endOffset));
  const instances: VerilogInstance[] = [];
  const instanceRegex = /\b([A-Za-z_]\w*)\s*(?:#\s*\([^;]*?\)\s*)?([A-Za-z_]\w*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = instanceRegex.exec(text))) {
    const moduleName = match[1];
    const instanceName = match[2];
    if (moduleName === currentModuleName || verilogKeywords.has(moduleName) || systemTasks.has(moduleName)) {
      continue;
    }
    const instanceOffset = startOffset + match.index + match[0].indexOf(instanceName);
    instances.push({
      moduleName,
      instanceName,
      range: new vscode.Range(document.positionAt(startOffset + match.index), document.positionAt(startOffset + match.index + match[0].length)),
      selectionRange: new vscode.Range(document.positionAt(instanceOffset), document.positionAt(instanceOffset + instanceName.length))
    });
  }
  return instances;
}

function collectVerilogDiagnostics(document: vscode.TextDocument, text: string, modules: VerilogModule[]): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  if (config<boolean>('verilog.lint.courseRules', true, document.uri)) {
    collectCourseDiagnostics(document, text, modules, diagnostics);
    collectAssignmentDiagnostics(document, text, modules, diagnostics);
  }
  collectImplicitNetDiagnostics(document, text, modules, diagnostics);
  return diagnostics;
}

function collectCourseDiagnostics(document: vscode.TextDocument, text: string, modules: VerilogModule[], diagnostics: vscode.Diagnostic[]): void {
  const profile = getProfile(document.uri);
  const topName = getTopModule(document.uri);
  const top = modules.find((module) => module.name === topName);

  if ((profile === 'P4' || profile === 'P5' || profile === 'P6' || profile === 'P7') && !top) {
    diagnostics.push(makeDiagnostic(new vscode.Range(0, 0, 0, Math.max(1, document.lineAt(0).text.length)), `Top module '${topName}' was not found.`, vscode.DiagnosticSeverity.Warning, 'missing-top'));
  }

  if (top && (profile === 'P4' || profile === 'P5' || profile === 'P6' || profile === 'P7')) {
    checkExpectedPorts(top, profile, diagnostics);
  }

  if (profile === 'P6') {
    const displayRegex = /\$display\b/g;
    let match: RegExpExecArray | null;
    while ((match = displayRegex.exec(text))) {
      diagnostics.push(makeDiagnostic(rangeAtOffset(document, match.index, '$display'.length), 'P6 top-level design should not contain $display; the testbench should monitor external outputs.', vscode.DiagnosticSeverity.Error, 'p6-display'));
    }
  }

  if (profile === 'P4' || profile === 'P5') {
    validateDisplayFormats(document, text, profile, diagnostics);
  }

  if (!/`default_nettype\s+none/.test(text)) {
    diagnostics.push(makeDiagnostic(new vscode.Range(0, 0, 0, Math.max(1, document.lineAt(0).text.length)), 'Consider adding `default_nettype none to catch implicit wires early.', vscode.DiagnosticSeverity.Information, 'default-nettype-none'));
  }
}

function collectAssignmentDiagnostics(document: vscode.TextDocument, text: string, modules: VerilogModule[], diagnostics: vscode.Diagnostic[]): void {
  for (const module of modules) {
    const bodyStart = document.offsetAt(module.headerEnd);
    const body = text.slice(bodyStart, document.offsetAt(module.range.end));
    const assignmentKinds = new Map<string, Set<string>>();
    const assignRegex = /\b([A-Za-z_]\w*)\s*(<=|=)(?!=)/g;
    let match: RegExpExecArray | null;
    while ((match = assignRegex.exec(stripCommentsAndStrings(body)))) {
      const lhs = match[1];
      const operator = match[2];
      if (!assignmentKinds.has(lhs)) {
        assignmentKinds.set(lhs, new Set());
      }
      assignmentKinds.get(lhs)?.add(operator);
    }
    for (const [name, operators] of assignmentKinds) {
      if (operators.has('=') && operators.has('<=')) {
        const decl = module.declarations.get(name);
        const range = decl?.selectionRange ?? module.selectionRange;
        diagnostics.push(makeDiagnostic(range, `Signal '${name}' is assigned with both blocking and nonblocking assignments.`, vscode.DiagnosticSeverity.Warning, 'mixed-assignment'));
      }
    }
  }
}

function collectImplicitNetDiagnostics(document: vscode.TextDocument, text: string, modules: VerilogModule[], diagnostics: vscode.Diagnostic[]): void {
  const severityMode = config<string>('verilog.implicitNet.diagnostic', 'warning', document.uri);
  if (severityMode === 'off') {
    return;
  }
  const severity = severityMode === 'error'
    ? vscode.DiagnosticSeverity.Error
    : severityMode === 'hint'
      ? vscode.DiagnosticSeverity.Hint
      : vscode.DiagnosticSeverity.Warning;
  const ignorePatterns = config<string[]>('verilog.implicitNet.ignorePatterns', [], document.uri).map((pattern) => safeRegExp(pattern)).filter((item): item is RegExp => Boolean(item));

  for (const module of modules) {
    const declared = new Set<string>([module.name]);
    for (const decl of module.declarations.values()) {
      declared.add(decl.name);
    }
    for (const instance of module.instances) {
      declared.add(instance.instanceName);
      declared.add(instance.moduleName);
    }
    const bodyStart = document.offsetAt(module.headerEnd);
    const bodyEnd = document.offsetAt(module.range.end);
    const stripped = stripCommentsAndStrings(text.slice(bodyStart, bodyEnd));
    const tokenRegex = /\b[A-Za-z_]\w*\b/g;
    const reported = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(stripped))) {
      const token = match[0];
      const absolute = bodyStart + match.index;
      const previous = text[absolute - 1] ?? '';
      if (
        declared.has(token) ||
        reported.has(token) ||
        verilogKeywords.has(token) ||
        systemTasks.has(token) ||
        previous === '.' ||
        previous === '`' ||
        previous === '$' ||
        previous === "'"
      ) {
        continue;
      }
      if (ignorePatterns.some((pattern) => pattern.test(token))) {
        continue;
      }
      reported.add(token);
      diagnostics.push(makeDiagnostic(rangeAtOffset(document, absolute, token.length), `Implicit net or undeclared identifier '${token}'.`, severity, `implicit-net:${token}`));
    }
  }
}

function checkExpectedPorts(module: VerilogModule, profile: ProjectProfile, diagnostics: vscode.Diagnostic[]): void {
  const expected = expectedPorts[profile];
  if (!expected) {
    return;
  }
  const portsByName = new Map(module.ports.map((port) => [port.name, port]));
  for (const [name, width] of Object.entries(expected)) {
    const port = portsByName.get(name);
    if (!port) {
      diagnostics.push(makeDiagnostic(module.selectionRange, `${profile} top module is missing port '${name}'.`, vscode.DiagnosticSeverity.Error, `${profile.toLowerCase()}-port`));
      continue;
    }
    if (width && port.width && normalizeWidth(port.width) !== width) {
      diagnostics.push(makeDiagnostic(port.selectionRange, `${profile} port '${name}' is expected to be ${width}, got ${port.width}.`, vscode.DiagnosticSeverity.Warning, `${profile.toLowerCase()}-port-width`));
    }
  }
}

function validateDisplayFormats(document: vscode.TextDocument, text: string, profile: ProjectProfile, diagnostics: vscode.Diagnostic[]): void {
  const displayRegex = /\$display\s*\(\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = displayRegex.exec(text))) {
    const format = match[1];
    const ok = profile === 'P5'
      ? /%d@%h:\s*(?:\$%d|\*%h)\s*<=\s*%h/.test(format)
      : /@%h:\s*(?:\$%d|\*%h)\s*<=\s*%h/.test(format);
    if (!ok) {
      diagnostics.push(makeDiagnostic(rangeAtOffset(document, match.index, '$display'.length), `${profile} $display format does not match the expected CPU trace format.`, vscode.DiagnosticSeverity.Warning, 'display-format'));
    }
  }
}

function buildTestbench(module: VerilogModule, tbName: string): string {
  const declarations = module.ports.map((port) => {
    const kind = port.direction === 'input' || port.direction === 'inout' ? 'reg' : 'wire';
    return `    ${kind} ${port.width ? `${port.width} ` : ''}${port.name};`;
  });
  const connections = module.ports.map((port, index) => {
    const comma = index === module.ports.length - 1 ? '' : ',';
    return `        .${port.name}(${port.name})${comma}`;
  });
  const hasClk = module.ports.some((port) => port.name === 'clk');
  const hasReset = module.ports.some((port) => port.name === 'reset');
  const lines: string[] = [
    '`timescale 1ns / 1ps',
    '',
    `module ${tbName};`,
    ...declarations,
    '',
    `    ${module.name} uut (`,
    ...connections,
    '    );',
    ''
  ];

  if (hasClk) {
    lines.push(
      '    initial begin',
      "        clk = 1'b0;",
      '        forever #5 clk = ~clk;',
      '    end',
      ''
    );
  }

  lines.push('    initial begin');
  if (hasReset) {
    lines.push(
      "        reset = 1'b1;",
      '        #20;',
      "        reset = 1'b0;"
    );
  }
  lines.push('        #200000;', '        $finish;', '    end', 'endmodule', '');
  return lines.join('\n');
}

function makeDeclareWireAction(document: vscode.TextDocument, module: VerilogModule, name: string): vscode.CodeAction {
  const action = new vscode.CodeAction(`Declare wire ${name}`, vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  action.edit.insert(document.uri, module.headerEnd, `    wire ${name};\n`);
  return action;
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function findEndmodule(text: string, from: number): number {
  const index = text.indexOf('endmodule', from);
  if (index < 0) {
    return text.length;
  }
  return index + 'endmodule'.length;
}

function normalizeWidth(width?: string): string | undefined {
  return width?.replace(/\s+/g, '');
}

function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
    .replace(/\/\/.*$/gm, (match) => ' '.repeat(match.length))
    .replace(/"([^"\\]|\\.)*"/g, (match) => ' '.repeat(match.length));
}

function moduleAtPosition(modules: VerilogModule[], position: vscode.Position): VerilogModule | undefined {
  return modules.find((module) => module.range.contains(position));
}

function declDetail(decl: VerilogDecl): string {
  return `${decl.direction ?? decl.kind} ${decl.width ? `${decl.width} ` : ''}${decl.name}`.trim();
}

function snippetItem(label: string, body: string, detail: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
  item.insertText = new vscode.SnippetString(body);
  item.detail = detail;
  return item;
}

function makeDiagnostic(range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity, code: string): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(range, message, severity);
  diagnostic.source = 'BUAA CO';
  diagnostic.code = code;
  return diagnostic;
}

function rangeAtOffset(document: vscode.TextDocument, offset: number, length: number): vscode.Range {
  return new vscode.Range(document.positionAt(offset), document.positionAt(offset + length));
}

function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}
