import {
  CodeAction,
  CodeActionKind,
  Command,
  CompletionItem,
  CompletionItemKind,
  Diagnostic,
  Hover,
  InlayHint,
  InlayHintKind,
  InsertTextFormat,
  Location,
  MarkupKind,
  ParameterInformation,
  Position,
  Range,
  ReferenceParams,
  SignatureHelp,
  SignatureInformation,
  TextEdit,
  WorkspaceEdit
} from 'vscode-languageserver/node';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { containsPosition, lineAt, rangesEqual } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { filterDisabledDiagnostics } from '../common/diagnosticActions';
import { rangeKey } from '../common/util';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import {
  systemTasks,
  VerilogDecl,
  VerilogInclude,
  VerilogInstance,
  VerilogMacro,
  VerilogMacroUse,
  VerilogModule,
  VerilogPortConnection,
  verilogKeywords
} from './model';
import {
  buildTestbench,
  declDetail,
  moduleAtPosition,
  parseVerilog,
  splitTopLevelCommaSpans
} from './parser';
import { getCachedVerilogParse } from './parseCache';
import { getVerilogLiteralCodeActions } from './numericLiterals';
import { addVerilogWorkspaceDiagnostics } from './workspaceDiagnostics';
import { VerilogCstDocument } from './cst';
import {
  verilogWordRangeAtPosition
} from './tokenNavigation';
import {
  findVerilogSemanticSymbol,
  resolveVerilogSemanticAtPosition,
  verilogSemanticReferenceRanges,
  verilogSemanticTargetFromSymbol,
  VerilogSemanticModel,
  VerilogSemanticResolution
} from './semanticModel';

export { buildTestbench, parseVerilog, moduleAtPosition };
export { getVerilogFoldingRanges } from './folding';
export { getVerilogFormattingEdits } from './formatting';
export { getVerilogSemanticTokens } from './semanticTokens';
export { getVerilogDocumentSymbols } from './symbols';
export type { VerilogModule } from './model';

interface ResolvedDecl {
  kind: 'decl';
  decl: VerilogDecl;
  module: VerilogModule;
}

interface ResolvedModule {
  kind: 'module';
  module: VerilogModule;
}

interface ResolvedInstance {
  kind: 'instance';
  instance: VerilogInstance;
  module: VerilogModule;
}

interface ResolvedPortConnection {
  kind: 'portConnection';
  module: VerilogModule;
  instance: VerilogInstance;
  connection: VerilogPortConnection;
  targetModule: VerilogModule;
  targetPort: VerilogDecl;
}

interface ResolvedMacro {
  kind: 'macro';
  macro?: VerilogMacro;
  macroUse?: VerilogMacroUse;
  name: string;
}

interface ResolvedInclude {
  kind: 'include';
  include: VerilogInclude;
}

type ResolvedVerilogSymbol =
  | ResolvedDecl
  | ResolvedModule
  | ResolvedInstance
  | ResolvedPortConnection
  | ResolvedMacro
  | ResolvedInclude;

interface InstanceContext {
  module: VerilogModule;
  instance: VerilogInstance;
  targetModule?: VerilogModule;
  listKind: 'ports' | 'parameters';
  listRange: Range;
  connections: VerilogPortConnection[];
}

export function getVerilogDiagnostics(document: TextDocument, settings: CoSettings, index?: VerilogWorkspaceIndex): Diagnostic[] {
  const parsed = getCachedVerilogParse(document, settings, true);
  const diagnostics = index ? addVerilogWorkspaceDiagnostics(document, settings, index, parsed.diagnostics, parsed) : parsed.diagnostics;
  return filterDisabledDiagnostics(document.languageId, diagnostics, settings, document.uri);
}

export function getVerilogCompletions(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): CompletionItem[] {
  const parsed = getCachedVerilogParse(document, settings, false);
  const connectionContext = findInstanceContext(parsed.modules, position, index);
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

  for (const keyword of verilogKeywords) {
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
  return dedupeCompletionItems(items);
}

export function getVerilogHover(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): Hover | undefined {
  const resolved = resolveVerilogSymbol(document, position, settings, index);
  if (!resolved) {
    return undefined;
  }
  const parsed = getCachedVerilogParse(document, settings, false);
  const hoverRange = resolved.kind === 'include'
    ? resolved.include.pathRange
    : getVerilogWordRange(document, position, parsed.cst) ?? resolvedRange(resolved);
  switch (resolved.kind) {
    case 'decl':
      return markdownHover(`\`${declDetail(resolved.decl)}\``, hoverRange);
    case 'instance':
      return markdownHover(`Instance \`${resolved.instance.instanceName}\` of module \`${resolved.instance.moduleName}\`.`, hoverRange);
    case 'module':
      return markdownHover(moduleMarkdown(resolved.module), hoverRange);
    case 'portConnection':
      return markdownHover(`Port \`${resolved.targetPort.name}\` on module \`${resolved.targetModule.name}\`\n\n\`${declDetail(resolved.targetPort)}\``, hoverRange);
    case 'macro':
      return markdownHover(`Verilog macro \`${resolved.name}\``, hoverRange);
    case 'include':
      return markdownHover(`Included file \`${resolved.include.path}\``, hoverRange);
  }
}

export function getVerilogDefinition(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): Location | undefined {
  const resolved = resolveVerilogSymbol(document, position, settings, index);
  if (!resolved) {
    return undefined;
  }
  switch (resolved.kind) {
    case 'decl':
      return Location.create(document.uri, resolved.decl.selectionRange);
    case 'instance':
      return Location.create(document.uri, resolved.instance.selectionRange);
    case 'module':
      return Location.create(resolved.module.uri, resolved.module.selectionRange);
    case 'portConnection':
      return Location.create(resolved.targetModule.uri, resolved.targetPort.selectionRange);
    case 'macro': {
      const macro = resolved.macro ?? index.getMacro(resolved.name);
      return macro ? Location.create(macroUri(index, macro, document.uri), macro.selectionRange) : undefined;
    }
    case 'include':
      return includeLocation(document, resolved.include);
  }
}

export function getVerilogReferences(document: TextDocument, params: ReferenceParams, settings: CoSettings, index: VerilogWorkspaceIndex): Location[] {
  const resolved = resolveVerilogSymbol(document, params.position, settings, index);
  if (!resolved || resolved.kind === 'include') {
    return [];
  }
  const parsed = getCachedVerilogParse(document, settings, false);
  const includeDeclaration = params.context.includeDeclaration;
  switch (resolved.kind) {
    case 'decl': {
      const locations = collectSemanticSymbolReferences(document.uri, parsed.semantic, resolved.module, resolved.decl.name, resolved.decl.selectionRange, includeDeclaration);
      if (resolved.decl.direction) {
        locations.push(...collectPortConnectionReferences(index, resolved.module.name, resolved.decl.name));
      }
      return dedupeLocations(locations);
    }
    case 'instance':
      return collectSemanticSymbolReferences(document.uri, parsed.semantic, resolved.module, resolved.instance.instanceName, resolved.instance.selectionRange, includeDeclaration);
    case 'module':
      return collectModuleReferences(index, resolved.module, includeDeclaration);
    case 'portConnection': {
      const locations = collectSignalReferencesForIndexedModule(index, resolved.targetModule, resolved.targetPort.name, resolved.targetPort.selectionRange, includeDeclaration);
      locations.push(...collectPortConnectionReferences(index, resolved.targetModule.name, resolved.targetPort.name));
      return dedupeLocations(locations);
    }
    case 'macro':
      return collectMacroReferences(index, resolved.name, resolved.macro, includeDeclaration, document.uri);
  }
}

export function getVerilogRenameEdits(document: TextDocument, position: Position, newName: string, settings: CoSettings, index: VerilogWorkspaceIndex): WorkspaceEdit | undefined {
  if (!isIdentifier(newName)) {
    return undefined;
  }
  const references = getVerilogReferences(document, {
    textDocument: { uri: document.uri },
    position,
    context: { includeDeclaration: true }
  }, settings, index);
  if (!references.length) {
    return undefined;
  }
  const changes: Record<string, TextEdit[]> = {};
  for (const location of dedupeLocations(references)) {
    const edits = changes[location.uri] ?? [];
    edits.push(TextEdit.replace(location.range, newName));
    changes[location.uri] = edits;
  }
  return { changes };
}

export function getVerilogRenamePrepare(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): Range | undefined {
  const resolved = resolveVerilogSymbol(document, position, settings, index);
  if (!resolved || resolved.kind === 'include') {
    return undefined;
  }
  const parsed = getCachedVerilogParse(document, settings, false);
  const range = getVerilogWordRange(document, position, parsed.cst);
  if (!range) {
    return undefined;
  }
  const text = document.getText(range);
  return isIdentifier(text) ? range : undefined;
}

export function getVerilogCodeActions(document: TextDocument, range: Range, diagnostics: Diagnostic[], settings: CoSettings, index: VerilogWorkspaceIndex): CodeAction[] {
  const actions: CodeAction[] = [];
  const implicit = diagnostics.find((diagnostic) => typeof diagnostic.code === 'string' && diagnostic.code.startsWith('implicit-net:'));
  if (implicit && typeof implicit.code === 'string') {
    const name = implicit.code.slice('implicit-net:'.length);
    const parsed = getCachedVerilogParse(document, settings, false);
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

  const explicitWireDiagnostics = diagnostics.filter((diagnostic) => diagnostic.code === 'explicit-port-wire');
  for (const diagnostic of explicitWireDiagnostics) {
    actions.push({
      title: 'Add explicit wire to port declaration',
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [document.uri]: [TextEdit.insert(diagnostic.range.end, ' wire')]
        }
      }
    });
  }

  actions.push(...getVerilogLintRuleCodeActions(diagnostics, settings));
  actions.push(...getInstanceCodeActions(document, range, settings, index));
  actions.push(...getVerilogLiteralCodeActions(document, range));

  return actions;
}

function getVerilogLintRuleCodeActions(diagnostics: Diagnostic[], settings: CoSettings): CodeAction[] {
  const actions: CodeAction[] = [];
  const seen = new Set<string>();
  const disabled = new Set(settings.verilog.lint.disabledRules.map((rule) => rule.toLowerCase()));
  for (const diagnostic of diagnostics) {
    const rule = verilogLintRuleFromDiagnostic(diagnostic);
    if (!rule || seen.has(rule) || disabled.has(rule)) {
      continue;
    }
    seen.add(rule);
    actions.push({
      title: `Disable ${rule.toUpperCase()} in this workspace`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      command: Command.create(`Disable ${rule.toUpperCase()}`, 'co.verilog.disableLintRule', rule)
    });
  }
  return actions;
}

function verilogLintRuleFromDiagnostic(diagnostic: Diagnostic): string | undefined {
  const code = typeof diagnostic.code === 'string' ? diagnostic.code : undefined;
  const source = code ?? diagnostic.message;
  return source.match(/\bvc-\d{3}\b/i)?.[0].toLowerCase();
}

export function getVerilogSignatureHelp(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): SignatureHelp | undefined {
  const parsed = getCachedVerilogParse(document, settings, false);
  const context = findInstanceContext(parsed.modules, position, index);
  if (!context?.targetModule) {
    return undefined;
  }
  const entries = context.listKind === 'parameters' ? context.targetModule.parameters : context.targetModule.ports;
  if (!entries.length) {
    return undefined;
  }
  const activeParameter = activeConnectionIndex(document, position, context, entries);
  const signature: SignatureInformation = {
    label: `${context.targetModule.name}(${entries.map((entry) => entry.name).join(', ')})`,
    documentation: {
      kind: MarkupKind.Markdown,
      value: moduleMarkdown(context.targetModule)
    },
    parameters: entries.map((entry): ParameterInformation => ({
      label: entry.name,
      documentation: {
        kind: MarkupKind.Markdown,
        value: `\`${declDetail(entry)}\``
      }
    }))
  };
  return {
    signatures: [signature],
    activeSignature: 0,
    activeParameter: Math.min(activeParameter, entries.length - 1)
  };
}

export function getVerilogInlayHints(document: TextDocument, range: Range, settings: CoSettings, index: VerilogWorkspaceIndex): InlayHint[] {
  const hints: InlayHint[] = [];
  const parsed = getCachedVerilogParse(document, settings, false);
  for (const module of parsed.modules) {
    for (const instance of module.instances) {
      const target = index.getModule(instance.moduleName);
      if (!target) {
        continue;
      }
      for (const connection of instance.portConnections) {
        const port = connection.name
          ? target.ports.find((item) => item.name === connection.name)
          : target.ports[connection.positionalIndex];
        if (!port) {
          continue;
        }
        const direction = portDirectionLabel(port);
        const tooltip = {
          kind: MarkupKind.Markdown,
          value: `\`${declDetail(port)}\``
        };
        if (connection.nameRange && lineInRange(connection.nameRange.start.line, range)) {
          hints.push({
            position: connection.nameRange.end,
            label: `: ${direction}`,
            kind: InlayHintKind.Type,
            tooltip,
            paddingLeft: true
          });
        } else if (!connection.name && lineInRange(connection.expressionRange.start.line, range)) {
          hints.push({
            position: connection.expressionRange.start,
            label: `.${port.name}: ${direction}=`,
            kind: InlayHintKind.Parameter,
            tooltip,
            paddingRight: true
          });
        }
      }
    }
  }
  return hints;
}

function makeDeclareWireAction(document: TextDocument, module: VerilogModule, name: string): CodeAction {
  return {
    title: `Declare wire ${name}`,
    kind: CodeActionKind.QuickFix,
    edit: {
      changes: {
        [document.uri]: [declareWireEdit(document, module, name)]
      }
    }
  };
}

function declareWireEdit(document: TextDocument, module: VerilogModule, name: string): TextEdit {
  const headerLine = lineAt(document, module.headerEnd.line).text;
  const afterHeader = headerLine.slice(module.headerEnd.character);
  if (!afterHeader.trim() && module.headerEnd.line + 1 < document.lineCount) {
    return TextEdit.insert(Position.create(module.headerEnd.line + 1, 0), `    wire ${name};\n`);
  }
  return TextEdit.insert(module.headerEnd, `\n    wire ${name};\n`);
}

function getInstanceCodeActions(document: TextDocument, range: Range, settings: CoSettings, index: VerilogWorkspaceIndex): CodeAction[] {
  const parsed = getCachedVerilogParse(document, settings, false);
  const instanceContext = findInstanceForRange(parsed.modules, range, index);
  if (!instanceContext) {
    return [];
  }

  const actions: CodeAction[] = [];
  const instance = instanceContext.instance;

  if (!instance.portListRange) {
    actions.push({
      title: 'Add empty instance port list',
      kind: CodeActionKind.RefactorRewrite,
      edit: {
        changes: {
          [document.uri]: [TextEdit.insert(instance.selectionRange.end, ' ()')]
        }
      }
    });
  }

  for (const connection of instance.portConnections) {
    if (!connection.shorthand || !connection.name) {
      continue;
    }
    actions.push({
      title: `Add explicit empty port connection .${connection.name}()`,
      kind: CodeActionKind.RefactorRewrite,
      edit: {
        changes: {
          [document.uri]: [TextEdit.replace(connection.range, `.${connection.name}()`)]
        }
      }
    });
  }

  const target = instanceContext.targetModule;
  if (!target) {
    return actions;
  }

  const namedPorts = new Set(instance.portConnections.map((connection) => connection.name).filter((name): name is string => Boolean(name)));
  const hasOrderedPortConnections = instance.portConnections.some((connection) => !connection.name);
  const missingPorts = target.ports.filter((port) => !namedPorts.has(port.name));
  if (target.ports.length && missingPorts.length && !hasOrderedPortConnections && (instance.portListRange || !instance.portConnections.length)) {
    actions.push({
      title: 'Fill connections',
      kind: CodeActionKind.RefactorRewrite,
      edit: {
        changes: {
          [document.uri]: [fillPortConnectionsEdit(document, instance, target)]
        }
      }
    });
  }

  const namedParams = new Set(instance.parameterConnections.map((connection) => connection.name).filter((name): name is string => Boolean(name)));
  const hasOrderedParameterConnections = instance.parameterConnections.some((connection) => !connection.name);
  const missingParams = target.parameters.filter((param) => !namedParams.has(param.name));
  if (target.parameters.length && missingParams.length && !hasOrderedParameterConnections) {
    actions.push({
      title: 'Fill parameters',
      kind: CodeActionKind.RefactorRewrite,
      edit: {
        changes: {
          [document.uri]: [fillParameterConnectionsEdit(document, instance, target)]
        }
      }
    });
  }

  if (instance.portListRange && instance.portConnections.some((connection) => !connection.name)) {
    actions.push({
      title: 'Convert ordered port connections to named connections',
      kind: CodeActionKind.RefactorRewrite,
      edit: {
        changes: {
          [document.uri]: [TextEdit.replace(instance.portListRange, formatConvertedConnections(document, instance, target.ports, instance.portConnections))]
        }
      }
    });
  }

  if (instance.parameterListRange && instance.parameterConnections.some((connection) => !connection.name)) {
    actions.push({
      title: 'Convert ordered parameter assignments to named assignments',
      kind: CodeActionKind.RefactorRewrite,
      edit: {
        changes: {
          [document.uri]: [TextEdit.replace(instance.parameterListRange, formatConvertedConnections(document, instance, target.parameters, instance.parameterConnections))]
        }
      }
    });
  }

  const emptyConnections = instance.portConnections.filter((connection) => connection.name && connection.expression.trim() === '');
  if (instance.portListRange && emptyConnections.length) {
    actions.push({
      title: 'Remove empty port connections',
      kind: CodeActionKind.RefactorRewrite,
      edit: {
        changes: {
          [document.uri]: [TextEdit.replace(instance.portListRange, formatExistingConnections(document, instance, instance.portConnections.filter((connection) => !(connection.name && connection.expression.trim() === ''))))]
        }
      }
    });
  }

  return actions;
}

function findInstanceForRange(modules: VerilogModule[], range: Range, index: VerilogWorkspaceIndex): InstanceContext | undefined {
  const position = range.start;
  const module = moduleAtPosition(modules, position);
  if (!module) {
    return undefined;
  }
  const instance = module.instances.find((item) => containsPosition(item.range, position)) ??
    module.instances.find((item) => item.range.start.line <= position.line && item.range.end.line >= position.line);
  if (!instance) {
    return undefined;
  }
  return {
    module,
    instance,
    targetModule: index.getModule(instance.moduleName) ?? modules.find((item) => item.name === instance.moduleName),
    listKind: 'ports',
    listRange: instance.portListRange ?? instance.selectionRange,
    connections: instance.portConnections
  };
}

function fillPortConnectionsEdit(document: TextDocument, instance: VerilogInstance, target: VerilogModule): TextEdit {
  const existingByName = new Map(instance.portConnections.filter((connection) => connection.name).map((connection) => [connection.name as string, connection]));
  const lines = target.ports.map((port) => {
    const existing = existingByName.get(port.name);
    return existing ? document.getText(existing.range).trim() : `.${port.name}(${port.name})`;
  });
  const replacement = formatConnectionLines(document, instance, lines);
  if (instance.portListRange) {
    return TextEdit.replace(instance.portListRange, replacement);
  }
  return TextEdit.insert(instance.selectionRange.end, ` (${replacement})`);
}

function fillParameterConnectionsEdit(document: TextDocument, instance: VerilogInstance, target: VerilogModule): TextEdit {
  const existingByName = new Map(instance.parameterConnections.filter((connection) => connection.name).map((connection) => [connection.name as string, connection]));
  const lines = target.parameters.map((param) => {
    const existing = existingByName.get(param.name);
    return existing ? document.getText(existing.range).trim() : `.${param.name}(${param.name})`;
  });
  const replacement = formatConnectionLines(document, instance, lines);
  if (instance.parameterListRange) {
    return TextEdit.replace(instance.parameterListRange, replacement);
  }
  return TextEdit.insert(instance.moduleSelectionRange.end, ` #(${replacement})`);
}

function formatConvertedConnections(document: TextDocument, instance: VerilogInstance, declarations: VerilogDecl[], connections: VerilogPortConnection[]): string {
  const lines = connections.map((connection) => {
    if (connection.name) {
      return document.getText(connection.range).trim();
    }
    const declaration = declarations[connection.positionalIndex];
    if (!declaration) {
      return document.getText(connection.range).trim();
    }
    return `.${declaration.name}(${connection.expression.trim()})`;
  });
  return formatConnectionLines(document, instance, lines);
}

function formatExistingConnections(document: TextDocument, instance: VerilogInstance, connections: VerilogPortConnection[]): string {
  return formatConnectionLines(document, instance, connections.map((connection) => document.getText(connection.range).trim()));
}

function formatConnectionLines(document: TextDocument, instance: VerilogInstance, lines: string[]): string {
  const filtered = lines.filter((line) => line.length > 0);
  if (!filtered.length) {
    return '';
  }
  const isMultiline = instance.range.start.line !== instance.range.end.line || filtered.length > 2;
  if (!isMultiline) {
    return filtered.join(', ');
  }
  const baseIndent = indentationOfLine(document, instance.range.start.line);
  const indent = `${baseIndent}    `;
  return `\n${filtered.map((line, itemIndex) => `${indent}${line}${itemIndex === filtered.length - 1 ? '' : ','}`).join('\n')}\n${baseIndent}`;
}

function indentationOfLine(document: TextDocument, line: number): string {
  return lineAt(document, line).text.match(/^\s*/)?.[0] ?? '';
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

function resolveVerilogSymbol(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): ResolvedVerilogSymbol | undefined {
  const parsed = getCachedVerilogParse(document, settings, false);
  const semanticResolved = resolvedVerilogSymbolFromSemantic(parsed, position, index);
  if (semanticResolved) {
    return semanticResolved;
  }
  const include = parsed.includes.find((item) => containsPosition(item.pathRange, position));
  if (include) {
    return { kind: 'include', include };
  }
  const wordRange = getVerilogWordRange(document, position, parsed.cst);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const currentModule = moduleAtPosition(parsed.modules, position);
  if (currentModule) {
    if (rangesEqual(currentModule.selectionRange, wordRange)) {
      return { kind: 'module', module: currentModule };
    }
    for (const instance of currentModule.instances) {
      if (rangesEqual(instance.moduleSelectionRange, wordRange)) {
        const target = index.getModule(instance.moduleName) ?? parsed.modules.find((item) => item.name === instance.moduleName);
        return target ? { kind: 'module', module: target } : undefined;
      }
      if (rangesEqual(instance.selectionRange, wordRange)) {
        return { kind: 'instance', module: currentModule, instance };
      }
      const connection = instance.portConnections.find((item) => item.nameRange && containsPosition(item.nameRange, position));
      if (connection?.name) {
        const targetModule = index.getModule(instance.moduleName) ?? parsed.modules.find((item) => item.name === instance.moduleName);
        const targetPort = targetModule?.ports.find((port) => port.name === connection.name);
        if (targetModule && targetPort) {
          return { kind: 'portConnection', module: currentModule, instance, connection, targetModule, targetPort };
        }
      }
    }
    const decl = currentModule.declarations.get(word);
    if (decl) {
      return { kind: 'decl', decl, module: currentModule };
    }
  }

  const macro = parsed.macros.find((item) => rangesEqual(item.selectionRange, wordRange));
  if (macro) {
    return { kind: 'macro', macro, name: macro.name };
  }
  const macroUse = parsed.macroUses.find((item) => rangesEqual(item.selectionRange, wordRange));
  if (macroUse) {
    return { kind: 'macro', macro: index.getMacro(macroUse.name), macroUse, name: macroUse.name };
  }
  const module = index.getModule(word) ?? parsed.modules.find((item) => item.name === word);
  if (module) {
    return { kind: 'module', module };
  }
  return undefined;
}

function resolvedVerilogSymbolFromSemantic(
  parsed: ReturnType<typeof getCachedVerilogParse>,
  position: Position,
  index: VerilogWorkspaceIndex
): ResolvedVerilogSymbol | undefined {
  const resolved = resolveVerilogSemanticAtPosition(parsed.semantic, position);
  if (!resolved) {
    return undefined;
  }
  return mapSemanticResolution(parsed.modules, resolved, index);
}

function mapSemanticResolution(
  modules: VerilogModule[],
  resolved: VerilogSemanticResolution,
  index: VerilogWorkspaceIndex
): ResolvedVerilogSymbol | undefined {
  const reference = resolved.reference;
  if (reference?.kind === 'portConnection' && reference.module && reference.instance && reference.portConnection?.name) {
    const targetModule = index.getModule(reference.instance.moduleName) ?? modules.find((item) => item.name === reference.instance?.moduleName);
    const targetPort = targetModule?.ports.find((port) => port.name === reference.portConnection?.name)
      ?? targetModule?.parameters.find((param) => param.name === reference.portConnection?.name);
    if (targetModule && targetPort) {
      return {
        kind: 'portConnection',
        module: reference.module,
        instance: reference.instance,
        connection: reference.portConnection,
        targetModule,
        targetPort
      };
    }
  }
  if (reference?.kind === 'module') {
    const module = resolved.symbol?.module ?? index.getModule(reference.name) ?? modules.find((item) => item.name === reference.name);
    return module ? { kind: 'module', module } : undefined;
  }
  if (reference?.kind === 'macro') {
    return {
      kind: 'macro',
      macro: resolved.symbol?.macro ?? index.getMacro(reference.name),
      macroUse: reference.macroUse,
      name: reference.name
    };
  }
  if (reference?.kind === 'include' && reference.include) {
    return { kind: 'include', include: reference.include };
  }

  const symbol = resolved.symbol;
  if (!symbol) {
    return undefined;
  }
  if (symbol.kind === 'module' && symbol.module) {
    return { kind: 'module', module: symbol.module };
  }
  if ((symbol.kind === 'signal' || symbol.kind === 'port' || symbol.kind === 'parameter') && symbol.decl && symbol.module) {
    return { kind: 'decl', decl: symbol.decl, module: symbol.module };
  }
  if (symbol.kind === 'instance' && symbol.instance && symbol.module) {
    return { kind: 'instance', instance: symbol.instance, module: symbol.module };
  }
  if (symbol.kind === 'macro') {
    return { kind: 'macro', macro: symbol.macro, name: symbol.name };
  }
  if (symbol.kind === 'include' && symbol.include) {
    return { kind: 'include', include: symbol.include };
  }
  return undefined;
}

function collectSignalReferencesForIndexedModule(index: VerilogWorkspaceIndex, module: VerilogModule, name: string, declarationRange: Range | undefined, includeDeclaration: boolean): Location[] {
  const file = index.getFile(module.uri);
  if (!file) {
    return includeDeclaration && declarationRange ? [Location.create(module.uri, declarationRange)] : [];
  }
  return collectSemanticSymbolReferences(file.uri, file.semantic, module, name, declarationRange, includeDeclaration);
}

function collectSemanticSymbolReferences(uri: string, semantic: VerilogSemanticModel, module: VerilogModule, name: string, declarationRange: Range | undefined, includeDeclaration: boolean): Location[] {
  const symbol = findVerilogSemanticSymbol(semantic, (candidate) =>
    candidate.name === name &&
    candidate.module?.name === module.name &&
    (!declarationRange || rangesEqual(candidate.selectionRange, declarationRange))
  );
  if (!symbol) {
    return includeDeclaration && declarationRange ? [Location.create(uri, declarationRange)] : [];
  }
  return verilogSemanticReferenceRanges(semantic, verilogSemanticTargetFromSymbol(symbol), includeDeclaration)
    .map((range) => Location.create(uri, range));
}

function collectModuleReferences(index: VerilogWorkspaceIndex, target: VerilogModule, includeDeclaration: boolean): Location[] {
  const locations: Location[] = [];
  if (includeDeclaration) {
    locations.push(Location.create(target.uri, target.selectionRange));
  }
  for (const file of index.indexedFiles()) {
    for (const module of file.modules) {
      for (const instance of module.instances) {
        if (instance.moduleName === target.name) {
          locations.push(Location.create(file.uri, instance.moduleSelectionRange));
        }
      }
    }
  }
  return dedupeLocations(locations);
}

function collectPortConnectionReferences(index: VerilogWorkspaceIndex, moduleName: string, portName: string): Location[] {
  const locations: Location[] = [];
  for (const file of index.indexedFiles()) {
    for (const module of file.modules) {
      for (const instance of module.instances) {
        if (instance.moduleName !== moduleName) {
          continue;
        }
        for (const connection of instance.portConnections) {
          if (connection.name === portName && connection.nameRange) {
            locations.push(Location.create(file.uri, connection.nameRange));
          }
        }
      }
    }
  }
  return locations;
}

function collectMacroReferences(index: VerilogWorkspaceIndex, name: string, macro: VerilogMacro | undefined, includeDeclaration: boolean, fallbackUri: string): Location[] {
  const locations: Location[] = [];
  if (includeDeclaration) {
    const definitions = macro ? [macro] : index.getMacros(name);
    for (const definition of definitions) {
      locations.push(Location.create(macroUri(index, definition, fallbackUri), definition.selectionRange));
    }
  }
  for (const file of index.indexedFiles()) {
    for (const use of file.macroUses) {
      if (use.name === name) {
        locations.push(Location.create(file.uri, use.selectionRange));
      }
    }
  }
  return dedupeLocations(locations);
}

function findInstanceContext(modules: VerilogModule[], position: Position, index: VerilogWorkspaceIndex): InstanceContext | undefined {
  const module = moduleAtPosition(modules, position);
  if (!module) {
    return undefined;
  }
  for (const instance of module.instances) {
    if (instance.parameterListRange && containsPosition(instance.parameterListRange, position)) {
      return {
        module,
        instance,
        targetModule: index.getModule(instance.moduleName) ?? modules.find((item) => item.name === instance.moduleName),
        listKind: 'parameters',
        listRange: instance.parameterListRange,
        connections: instance.parameterConnections
      };
    }
    if (instance.portListRange && containsPosition(instance.portListRange, position)) {
      return {
        module,
        instance,
        targetModule: index.getModule(instance.moduleName) ?? modules.find((item) => item.name === instance.moduleName),
        listKind: 'ports',
        listRange: instance.portListRange,
        connections: instance.portConnections
      };
    }
  }
  return undefined;
}

function activeConnectionIndex(document: TextDocument, position: Position, context: InstanceContext, entries: VerilogDecl[]): number {
  for (const connection of context.connections) {
    if (containsPosition(connection.range, position)) {
      if (connection.name) {
        const namedIndex = entries.findIndex((entry) => entry.name === connection.name);
        return namedIndex >= 0 ? namedIndex : connection.positionalIndex;
      }
      return Math.min(connection.positionalIndex, entries.length - 1);
    }
  }
  const start = document.offsetAt(context.listRange.start);
  const end = document.offsetAt(position);
  const prefix = document.getText().slice(start, end);
  let active = 0;
  for (const span of splitTopLevelCommaSpans(prefix)) {
    if (span.end < prefix.length) {
      active++;
    }
  }
  return Math.min(active, Math.max(0, entries.length - 1));
}

function includeLocation(document: TextDocument, include: VerilogInclude): Location | undefined {
  if (document.uri.startsWith('untitled:')) {
    return undefined;
  }
  try {
    const currentPath = URI.parse(document.uri).fsPath;
    const uri = URI.file(path.resolve(path.dirname(currentPath), include.path)).toString();
    return Location.create(uri, Range.create(0, 0, 0, 0));
  } catch {
    return undefined;
  }
}

function macroUri(index: VerilogWorkspaceIndex, macro: VerilogMacro, fallbackUri: string): string {
  for (const file of index.indexedFiles()) {
    if (file.macros.some((item) => rangesEqual(item.selectionRange, macro.selectionRange) && item.name === macro.name)) {
      return file.uri;
    }
  }
  return fallbackUri;
}

function resolvedRange(resolved: ResolvedVerilogSymbol): Range | undefined {
  switch (resolved.kind) {
    case 'decl':
      return resolved.decl.selectionRange;
    case 'instance':
      return resolved.instance.selectionRange;
    case 'module':
      return resolved.module.selectionRange;
    case 'portConnection':
      return resolved.connection.nameRange;
    case 'macro':
      return resolved.macro?.selectionRange ?? resolved.macroUse?.selectionRange;
    case 'include':
      return resolved.include.pathRange;
  }
}

function getVerilogWordRange(document: TextDocument, position: Position, cst: VerilogCstDocument): Range | undefined {
  return verilogWordRangeAtPosition(document, cst, position);
}

function markdownHover(value: string, range?: Range): Hover {
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value
    },
    range
  };
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

function portDirectionLabel(port: VerilogDecl): 'in' | 'out' | 'inout' {
  if (port.direction === 'output') {
    return 'out';
  }
  if (port.direction === 'inout') {
    return 'inout';
  }
  return 'in';
}

function lineInRange(line: number, range: Range): boolean {
  return line >= range.start.line && line <= range.end.line;
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

function dedupeLocations(locations: Location[]): Location[] {
  const seen = new Set<string>();
  const result: Location[] = [];
  for (const location of locations) {
    const key = `${location.uri}:${rangeKey(location.range)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(location);
  }
  return result;
}

function placeholder(index: number, value: string): string {
  return `\${${index}:${value}}`;
}

function isIdentifier(value: string): boolean {
  if (!value || !isIdentifierStart(value[0])) {
    return false;
  }
  for (let index = 1; index < value.length; index++) {
    if (!isIdentifierPart(value[index])) {
      return false;
    }
  }
  return true;
}

function isIdentifierStart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_';
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || (char >= '0' && char <= '9');
}
