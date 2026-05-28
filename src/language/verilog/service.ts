import {
  CodeAction,
  CodeActionKind,
  CompletionItem,
  CompletionItemKind,
  Diagnostic,
  DocumentSymbol,
  Hover,
  InsertTextFormat,
  Location,
  MarkupKind,
  Position,
  Range,
  SymbolKind,
  TextEdit
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { VerilogModule, verilogKeywords } from './model';
import {
  buildTestbench,
  declDetail,
  moduleAtPosition,
  parseVerilog
} from './parser';

export { buildTestbench, parseVerilog, moduleAtPosition };
export type { VerilogModule } from './model';

export function getVerilogDiagnostics(document: TextDocument, settings: CoSettings): Diagnostic[] {
  return parseVerilog(document, settings, true).diagnostics;
}

export function getVerilogCompletions(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): CompletionItem[] {
  const items: CompletionItem[] = [];
  const currentModule = moduleAtPosition(parseVerilog(document, settings, false).modules, position);
  if (currentModule) {
    for (const decl of currentModule.declarations.values()) {
      items.push({
        label: decl.name,
        kind: CompletionItemKind.Variable,
        detail: declDetail(decl)
      });
    }
    for (const instance of currentModule.instances) {
      items.push({
        label: instance.instanceName,
        kind: CompletionItemKind.Reference,
        detail: `Instance of ${instance.moduleName}`
      });
    }
  }

  for (const module of index.allModules()) {
    items.push({
      label: module.name,
      kind: CompletionItemKind.Class,
      detail: 'Verilog module',
      documentation: {
        kind: MarkupKind.Markdown,
        value: '```verilog\n' + module.ports.map((port) => `${port.direction ?? port.kind} ${port.width ?? ''} ${port.name}`.trim()).join('\n') + '\n```'
      }
    });
  }

  for (const keyword of verilogKeywords) {
    items.push({
      label: keyword,
      kind: CompletionItemKind.Keyword
    });
  }

  items.push(snippetItem('always_ff', 'always @(posedge ${1:clk}) begin\n    ${0}\nend', 'Clocked always block'));
  items.push(snippetItem('always_comb', 'always @(*) begin\n    ${0}\nend', 'Combinational always block'));
  items.push(snippetItem('display_p5_grf', '$display("%d@%h: $%d <= %h", $time, ${1:WPC}, ${2:Waddr}, ${3:WData});', 'BUAA CO P5 GRF display'));
  return items;
}

export function getVerilogHover(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): Hover | undefined {
  const wordRange = getVerilogWordRange(document, position);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const parsed = parseVerilog(document, settings, false);
  const currentModule = moduleAtPosition(parsed.modules, position);
  if (currentModule) {
    const decl = currentModule.declarations.get(word);
    if (decl) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `\`${declDetail(decl)}\``
        },
        range: wordRange
      };
    }
    const instance = currentModule.instances.find((item) => item.instanceName === word);
    if (instance) {
      return {
        contents: `Instance \`${instance.instanceName}\` of module \`${instance.moduleName}\`.`,
        range: wordRange
      };
    }
  }
  const module = index.getModule(word) ?? parsed.modules.find((item) => item.name === word);
  if (module) {
    const ports = module.ports.map((port) => `${port.direction ?? port.kind} ${port.width ?? ''} ${port.name}`.trim()).join('\n');
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**module ${module.name}**\n\n\`\`\`verilog\n${ports}\n\`\`\``
      },
      range: wordRange
    };
  }
  return undefined;
}

export function getVerilogDefinition(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): Location | undefined {
  const wordRange = getVerilogWordRange(document, position);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const parsed = parseVerilog(document, settings, false);
  const currentModule = moduleAtPosition(parsed.modules, position);
  if (currentModule) {
    const decl = currentModule.declarations.get(word);
    if (decl) {
      return Location.create(document.uri, decl.selectionRange);
    }
    const instance = currentModule.instances.find((item) => item.instanceName === word);
    if (instance) {
      return Location.create(document.uri, instance.selectionRange);
    }
  }
  const module = index.getModule(word) ?? parsed.modules.find((item) => item.name === word);
  if (module) {
    return Location.create(module.uri, module.selectionRange);
  }
  return undefined;
}

export function getVerilogDocumentSymbols(document: TextDocument, settings: CoSettings): DocumentSymbol[] {
  return parseVerilog(document, settings, false).modules.map((module) => {
    const symbol = DocumentSymbol.create(module.name, 'module', SymbolKind.Module, module.range, module.selectionRange, []);
    for (const port of module.ports) {
      symbol.children?.push(DocumentSymbol.create(port.name, declDetail(port), SymbolKind.Field, port.range, port.selectionRange));
    }
    for (const decl of module.declarations.values()) {
      if (module.ports.some((port) => port.name === decl.name)) {
        continue;
      }
      symbol.children?.push(DocumentSymbol.create(decl.name, declDetail(decl), SymbolKind.Variable, decl.range, decl.selectionRange));
    }
    for (const instance of module.instances) {
      symbol.children?.push(DocumentSymbol.create(instance.instanceName, instance.moduleName, SymbolKind.Object, instance.range, instance.selectionRange));
    }
    return symbol;
  });
}

export function getVerilogCodeActions(document: TextDocument, range: Range, diagnostics: Diagnostic[], settings: CoSettings): CodeAction[] {
  const actions: CodeAction[] = [];
  const implicit = diagnostics.find((diagnostic) => typeof diagnostic.code === 'string' && diagnostic.code.startsWith('implicit-net:'));
  if (implicit && typeof implicit.code === 'string') {
    const name = implicit.code.slice('implicit-net:'.length);
    const parsed = parseVerilog(document, settings, false);
    const module = moduleAtPosition(parsed.modules, range.start) ?? parsed.modules[0];
    if (module) {
      actions.push(makeDeclareWireAction(document, module, name));
    }
  }

  const defaultNettype = diagnostics.find((diagnostic) => diagnostic.code === 'default-nettype-none');
  if (defaultNettype) {
    actions.push({
      title: 'Add `default_nettype none',
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [document.uri]: [TextEdit.insert(Position.create(0, 0), '`default_nettype none\n')]
        }
      }
    });
  }

  return actions;
}

function makeDeclareWireAction(document: TextDocument, module: VerilogModule, name: string): CodeAction {
  return {
    title: `Declare wire ${name}`,
    kind: CodeActionKind.QuickFix,
    edit: {
      changes: {
        [document.uri]: [TextEdit.insert(module.headerEnd, `    wire ${name};\n`)]
      }
    }
  };
}

function snippetItem(label: string, body: string, detail: string): CompletionItem {
  return {
    label,
    kind: CompletionItemKind.Snippet,
    insertText: body,
    insertTextFormat: InsertTextFormat.Snippet,
    detail
  };
}

function getVerilogWordRange(document: TextDocument, position: Position): Range | undefined {
  const text = lineAt(document, position.line).text;
  const regex = /[A-Za-z_]\w*/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return Range.create(position.line, start, position.line, end);
    }
  }
  return undefined;
}

