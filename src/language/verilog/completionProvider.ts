// @index verilog-completion-provider — Verilog LSP补全provider
import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
  Position,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsPosition } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  systemTasks,
  VerilogModule,
  VerilogPortConnection
} from './model';
import { declDetail, moduleAtPosition } from './parser';
import { getCachedVerilogParse } from './parseCache';
import { preprocessorDirectives } from './preprocessor';
import { VerilogWorkspaceIndex } from './workspaceIndex';

type VerilogConnectionListKind = 'ports' | 'parameters';

export interface VerilogCompletionInstanceContext {
  targetModule?: VerilogModule;
  listKind: VerilogConnectionListKind;
  connections: VerilogPortConnection[];
}

export interface VerilogCompletionDependencies {
  findInstanceContext(
    modules: VerilogModule[],
    position: Position,
    index: VerilogWorkspaceIndex
  ): VerilogCompletionInstanceContext | undefined;
}

interface WorkspaceCompletionCacheEntry {
  version: number;
  items: CompletionItem[];
}

const workspaceCompletionCache = new WeakMap<VerilogWorkspaceIndex, WorkspaceCompletionCacheEntry>();

export function getVerilogCompletions(
  document: TextDocument,
  position: Position,
  settings: CoSettings,
  index: VerilogWorkspaceIndex,
  dependencies: VerilogCompletionDependencies
): CompletionItem[] {
  const parsed = getCachedVerilogParse(document, settings, false);

  if (triviaAtPosition(parsed.ast, position)) {
    return [];
  }

  const connectionContext = dependencies.findInstanceContext(parsed.modules, position, index);
  if (connectionContext?.targetModule) {
    const connected = new Set(connectionContext.connections.map((connection) => connection.name).filter((name): name is string => Boolean(name)));
    const entries = connectionContext.listKind === 'parameters' ? connectionContext.targetModule.parameters : connectionContext.targetModule.ports;
    return entries
      .filter((entry) => !connected.has(entry.name))
      .map((entry) => ({
        label: entry.name,
        kind: connectionContext.listKind === 'parameters' ? CompletionItemKind.Constant : CompletionItemKind.Field,
        detail: declDetail(entry),
        insertText: `${entry.name}(${placeholder(1, entry.name)})`,
        insertTextFormat: InsertTextFormat.Snippet,
        documentation: {
          kind: MarkupKind.Markdown,
          value: `Connect \`${entry.name}\` on module \`${connectionContext.targetModule?.name}\`.`
        }
      }));
  }

  const items: CompletionItem[] = [];

  const charBefore = position.character > 0
    ? document.getText(Range.create(position.line, position.character - 1, position.line, position.character))
    : '';
  if (charBefore === '`') {
    for (const name of preprocessorDirectives) {
      items.push({
        label: `\`${name}`,
        kind: CompletionItemKind.Keyword,
        detail: 'Verilog preprocessor directive',
        insertText: name
      });
    }
    return dedupeCompletionItems(items);
  }

  const lineText = document.getText(Range.create(position.line, 0, position.line, position.character));
  const apostropheMatch = lineText.match(/(\d+)\s*'\s*$/);
  if (apostropheMatch) {
    const bases = [
      { label: 'b', detail: 'Binary (base 2)' },
      { label: 'o', detail: 'Octal (base 8)' },
      { label: 'd', detail: 'Decimal (base 10)' },
      { label: 'h', detail: 'Hexadecimal (base 16)' }
    ];
    for (const base of bases) {
      items.push({
        label: `'${base.label}`,
        kind: CompletionItemKind.Keyword,
        detail: base.detail,
        insertText: base.label
      });
    }
    return dedupeCompletionItems(items);
  }

  const currentModule = moduleAtPosition(parsed.modules, position);
  if (currentModule) {
    for (const decl of currentModule.declarations.values()) {
      items.push({
        label: decl.name,
        kind: decl.kind === 'parameter' || decl.kind === 'localparam' ? CompletionItemKind.Constant : CompletionItemKind.Variable,
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

  for (const macro of parsed.macros) {
    items.push({
      label: macro.name,
      kind: CompletionItemKind.Constant,
      detail: 'Verilog macro',
      insertText: macro.name
    });
  }

  items.push(...workspaceCompletionItems(index));

  const textBefore = document.getText(Range.create(
    document.positionAt(Math.max(0, document.offsetAt(position) - 200)),
    position
  ));
  const sensitivityMatch = /@\s*\([^)]*$/s.exec(textBefore);
  if (sensitivityMatch) {
    items.push(
      { label: 'posedge', kind: CompletionItemKind.Keyword, detail: 'Positive edge trigger' },
      { label: 'negedge', kind: CompletionItemKind.Keyword, detail: 'Negative edge trigger' },
      { label: '*', kind: CompletionItemKind.Operator, detail: 'All signals (combinational)' }
    );
    if (currentModule) {
      for (const [name, decl] of currentModule.declarations) {
        if (decl.direction || decl.kind === 'wire' || decl.kind === 'reg') {
          items.push({
            label: name,
            kind: CompletionItemKind.Variable,
            detail: declDetail(decl)
          });
        }
      }
    }
    return dedupeCompletionItems(items);
  }

  const contextKeywords = keywordsForContext(parsed.modules, position);
  for (const keyword of contextKeywords) {
    if (keyword === 'begin') {
      items.push(snippetItem('begin', 'begin\n    ${0}\nend', 'Begin/end block'));
      continue;
    }
    items.push({
      label: keyword,
      kind: CompletionItemKind.Keyword
    });
  }

  for (const task of systemTasks) {
    items.push({
      label: `$${task}`,
      kind: CompletionItemKind.Function,
      detail: 'Verilog system task'
    });
  }

  items.push(snippetItem('always_ff', 'always @(posedge ${1:clk}) begin\n    ${0}\nend', 'Clocked always block'));
  items.push(snippetItem('always_comb', 'always @(*) begin\n    ${0}\nend', 'Combinational always block'));
  items.push(snippetItem('case_default', 'case (${1:signal})\n    ${2:value}: begin\n        ${0}\n    end\n    default: begin\n    end\nendcase', 'Case statement with default'));
  items.push(snippetItem('include', '`include "${1:file.v}"', 'Verilog include directive'));
  items.push(snippetItem('default_nettype_none', '`default_nettype none', 'Disable implicit nets'));
  items.push(snippetItem('display_p5_grf', '$display("%d@%h: $%d <= %h", $time, ${1:WPC}, ${2:Waddr}, ${3:WData});', 'BUAA CO P5 GRF display'));

  items.push(snippetItem('if_else', 'if (${1:condition}) begin\n    ${2}\nend else begin\n    ${3}\nend', 'If-else statement'));
  items.push(snippetItem('if_block', 'if (${1:condition}) begin\n    ${0}\nend', 'If statement'));
  items.push(snippetItem('for_loop', 'for (${1:i} = 0; ${1:i} < ${2:N}; ${1:i} = ${1:i} + 1) begin\n    ${0}\nend', 'For loop'));
  items.push(snippetItem('always_pos', 'always @(posedge ${1:clk}) begin\n    ${0}\nend', 'Always block: posedge clock'));
  items.push(snippetItem('always_neg', 'always @(negedge ${1:clk}) begin\n    ${0}\nend', 'Always block: negedge clock'));
  items.push(snippetItem('assign_wire', 'assign ${1:signal} = ${2:expression};', 'Continuous assignment'));
  items.push(snippetItem('wire_decl', 'wire ${1:name};', 'Wire declaration'));
  items.push(snippetItem('reg_decl', 'reg ${1:name};', 'Reg declaration'));
  items.push(snippetItem('wire_bus', 'wire [${1:MSB}:${2:LSB}] ${3:name};', 'Bus wire declaration'));
  items.push(snippetItem('initial_begin', 'initial begin\n    ${0}\nend', 'Initial block'));
  items.push(snippetItem('parameter_decl', 'parameter ${1:NAME} = ${2:value};', 'Parameter declaration'));
  items.push(snippetItem('generate_for', 'generate\n    for (${1:i} = 0; ${1:i} < ${2:N}; ${1:i} = ${1:i} + 1) begin : ${3:gen_label}\n        ${0}\n    end\nendgenerate', 'Generate for loop'));

  return dedupeCompletionItems(items);
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

function moduleCompletionItem(module: VerilogModule): CompletionItem {
  const ports = module.ports.map((port, index) => {
    const comma = index === module.ports.length - 1 ? '' : ',';
    return `    .${port.name}(${placeholder(index + 2, port.name)})${comma}`;
  }).join('\n');
  const insertText = module.ports.length
    ? `${module.name} ${placeholder(1, `u_${module.name}`)} (\n${ports}\n);`
    : `${module.name} ${placeholder(1, `u_${module.name}`)} ();`;
  return {
    label: module.name,
    kind: CompletionItemKind.Class,
    detail: 'Verilog module',
    insertText,
    insertTextFormat: InsertTextFormat.Snippet,
    documentation: {
      kind: MarkupKind.Markdown,
      value: moduleMarkdown(module)
    }
  };
}

function workspaceCompletionItems(index: VerilogWorkspaceIndex): CompletionItem[] {
  const cached = workspaceCompletionCache.get(index);
  if (cached?.version === index.version) {
    return cached.items;
  }
  const items: CompletionItem[] = [];
  for (const macro of index.indexedMacros()) {
    items.push({
      label: macro.name,
      kind: CompletionItemKind.Constant,
      detail: 'Verilog macro',
      insertText: macro.name
    });
  }
  for (const module of index.indexedModules()) {
    items.push(moduleCompletionItem(module));
  }
  workspaceCompletionCache.set(index, {
    version: index.version,
    items
  });
  return items;
}

function moduleMarkdown(module: VerilogModule): string {
  const params = module.parameters.map((param) => declDetail(param));
  const ports = module.ports.map((port) => declDetail(port));
  const sections = [`**module ${module.name}**`];
  if (params.length) {
    sections.push('', 'Parameters:', '```verilog', ...params, '```');
  }
  if (ports.length) {
    sections.push('', 'Ports:', '```verilog', ...ports, '```');
  }
  return sections.join('\n');
}

function keywordsForContext(modules: VerilogModule[], position: Position): Set<string> {
  const currentModule = moduleAtPosition(modules, position);
  if (!currentModule) {
    return new Set(['module', 'endmodule', 'always', 'assign', 'initial']);
  }
  const afterHeader = position.line > currentModule.headerEnd.line ||
    (position.line === currentModule.headerEnd.line && position.character >= currentModule.headerEnd.character);
  if (!afterHeader) {
    return new Set(['input', 'output', 'inout', 'wire', 'reg', 'signed', 'integer', 'parameter', 'localparam']);
  }
  return new Set([
    'always', 'assign', 'initial', 'begin', 'end', 'if', 'else', 'case', 'casex', 'casez',
    'endcase', 'for', 'forever', 'repeat', 'while', 'fork', 'join',
    'wire', 'reg', 'integer', 'parameter', 'localparam', 'genvar',
    'task', 'endtask', 'function', 'endfunction',
    'input', 'output', 'inout',
    'generate', 'endgenerate', 'posedge', 'negedge', 'or',
    'default', 'signed', 'module', 'endmodule'
  ]);
}

function dedupeCompletionItems(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  const result: CompletionItem[] = [];
  for (const item of items) {
    if (seen.has(item.label)) {
      continue;
    }
    seen.add(item.label);
    result.push(item);
  }
  return result;
}

function triviaAtPosition(ast: ReturnType<typeof getCachedVerilogParse>['ast'], position: Position): boolean {
  return ast.trivia.some((item) => containsPosition(item.range, position));
}

function placeholder(index: number, value: string): string {
  return `\${${index}:${value}}`;
}
