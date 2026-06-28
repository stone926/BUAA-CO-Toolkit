import {
  CodeAction,
  CodeActionKind,
  Command,
  CompletionItem,
  Diagnostic,
  Hover,
  InlayHint,
  InlayHintKind,
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
import { Commands } from '../../constants';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { containsPosition, lineAt, rangesEqual } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { rangeKey } from '../common/util';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import {
  VerilogDecl,
  VerilogInclude,
  VerilogInstance,
  VerilogMacro,
  VerilogMacroUse,
  VerilogModule,
  VerilogPortConnection
} from './model';
import {
  buildTestbench,
  declDetail,
  moduleAtPosition,
  parseVerilog,
  splitTopLevelCommaSpans
} from './parser';
import { getCachedVerilogParse } from './parseCache';
import { getVerilogLiteralCodeActions, numericLiteralAt, formatNumericLiteralHover } from './numericLiterals';
import { evalExpressionAstConstant, widthOfDecl, widthOfExpressionAst } from './expressions';
import type { VerilogConstantOverrides, WidthInfo } from './expressions';
import { parameterOverridesForInstance } from './parameterOverrides';
import type { VerilogExpressionAst } from './exprAst';
import type { VerilogModuleAst, VerilogStatementAst } from './ast';
import type { VerilogCaseStatementAst, VerilogProceduralStatementAst } from './proceduralAst';
import { findSmallestVerilogExpressionAtOffset, findSmallestVerilogExpressionMatchAtOffset } from './exprAstUtils';
import type { VerilogExpressionMatch } from './exprAstUtils';
import {
  findVerilogSemanticSymbol,
  resolveVerilogSemanticAtPosition,
  verilogSemanticReferenceRanges,
  verilogSemanticTargetFromSymbol,
  VerilogSemanticModel,
  VerilogSemanticResolution,
  VerilogSemanticSymbol
} from './semanticModel';
import { getVerilogCompletions as getVerilogCompletionsFromProvider } from './completionProvider';

export { buildTestbench, parseVerilog, moduleAtPosition };
export { getVerilogFoldingRanges } from './folding';
export { getVerilogFormattingEdits } from './formatting';
export { getVerilogSemanticTokens, clearVerilogSemanticTokenCache } from './semanticTokens';
export { getVerilogDocumentSymbols } from './symbols';
export { getVerilogDiagnostics } from './diagnosticProvider';
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
  targetSymbol?: VerilogSemanticSymbol;
  listKind: VerilogConnectionListKind;
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

type VerilogConnectionListKind = 'ports' | 'parameters';

interface VerilogExpressionActionContext extends VerilogExpressionMatch {
  statement: VerilogStatementAst;
}

type ResolvedVerilogSymbol = (
  | ResolvedDecl
  | ResolvedModule
  | ResolvedInstance
  | ResolvedPortConnection
  | ResolvedMacro
  | ResolvedInclude
) & { sourceRange?: Range };

interface InstanceContext {
  module: VerilogModule;
  instance: VerilogInstance;
  targetModule?: VerilogModule;
  listKind: VerilogConnectionListKind;
  listRange: Range;
  connections: VerilogPortConnection[];
}

interface NamedInstanceConnection {
  connection: VerilogPortConnection;
  listKind: VerilogConnectionListKind;
}

interface InstanceConnectionTarget {
  targetModule: VerilogModule;
  targetPort: VerilogDecl;
  targetSymbol?: VerilogSemanticSymbol;
  listKind: VerilogConnectionListKind;
}

export function getVerilogCompletions(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): CompletionItem[] {
  return getVerilogCompletionsFromProvider(document, position, settings, index, { findInstanceContext });
}

export function getVerilogHover(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): Hover | undefined {
  const resolved = resolveVerilogSymbol(document, position, settings, index);
  if (!resolved) {
    const literal = numericLiteralAt(document, position);
    if (literal) {
      return markdownHover(formatNumericLiteralHover(literal), literal.range);
    }
    const expressionHover = getVerilogExpressionHover(document, position, settings);
    if (expressionHover) {
      return expressionHover;
    }
    return undefined;
  }
  const parsed = getCachedVerilogParse(document, settings, false);
  const hoverRange = resolved.kind === 'include'
    ? resolved.include.pathRange
    : resolved.sourceRange ?? resolvedRange(resolved);
  switch (resolved.kind) {
    case 'decl': {
      const detail = declDetail(resolved.decl);
      const widthInfo = widthOfDecl(resolved.decl, resolved.module);
      let widthLine = '';
      if (widthInfo.width !== undefined) {
        widthLine = `\n\nInferred width: \`${widthInfo.width}\``;
        if (widthInfo.minWidth !== undefined && widthInfo.minWidth !== widthInfo.width) {
          widthLine += ` (min: \`${widthInfo.minWidth}\`)`;
        }
        if (widthInfo.flexible) {
          widthLine += ' *(flexible)*';
        }
      }
      const valueLine = resolved.decl.constantValue !== undefined
        ? `\n\nConstant value: \`${formatBigInt(resolved.decl.constantValue)}\``
        : '';
      return markdownHover(`\`${detail}\`${widthLine}${valueLine}`, hoverRange);
    }
    case 'instance': {
      const target = resolveInstanceTargetModule(index, parsed.modules, resolved.instance);
      return markdownHover(instanceMarkdown(resolved.instance, resolved.module, target), hoverRange);
    }
    case 'module':
      return markdownHover(moduleMarkdown(resolved.module), hoverRange);
    case 'portConnection': {
      return markdownHover(connectionMarkdown(resolved), hoverRange);
    }
    case 'macro': {
      const macroDef = resolved.macro ?? index.getMacro(resolved.name);
      const bodyMd = macroDef?.body ? `\n\n\`\`\`verilog\n${macroDef.body}\n\`\`\`` : '';
      return markdownHover(`Verilog macro \`${resolved.name}\`${bodyMd}`, hoverRange);
    }
    case 'include': {
      let status = '';
      if (!document.uri.startsWith('untitled:')) {
        try {
          const currentPath = URI.parse(document.uri).fsPath;
          const resolvedPath = path.resolve(path.dirname(currentPath), resolved.include.path);
          if (fs.existsSync(resolvedPath)) {
            status = `\n\nResolved: \`${resolvedPath}\``;
          } else {
            status = '\n\n**Unresolved**';
          }
        } catch {
          status = '\n\n**Unresolved**';
        }
      }
      return markdownHover(`Included file \`${resolved.include.path}\`${status}`, hoverRange);
    }
  }
}

function getVerilogExpressionHover(document: TextDocument, position: Position, settings: CoSettings): Hover | undefined {
  const parsed = getCachedVerilogParse(document, settings, false);
  const module = moduleAtPosition(parsed.modules, position);
  const moduleAst = module ? parsed.ast.modules.find((item) => item.module === module) : undefined;
  if (!module || !moduleAst) {
    return undefined;
  }
  const expressions = moduleAst.items.flatMap((item) => item.expressions);
  const expression = findSmallestVerilogExpressionAtOffset(expressions, document.offsetAt(position));
  if (!expression) {
    return undefined;
  }
  const range = Range.create(document.positionAt(expression.start), document.positionAt(expression.end));
  const source = document.getText(range).trim();
  if (!source) {
    return undefined;
  }
  const width = widthOfExpressionAst(expression, module);
  const value = evalExpressionAstConstant(expression, module);
  if (width.width === undefined && value === undefined) {
    return undefined;
  }
  const lines = [`Expression \`${source}\``, '', `AST: \`${expression.kind}\``];
  if (width.width !== undefined) {
    let widthText = `Width: \`${width.width}\``;
    if (width.minWidth !== undefined && width.minWidth !== width.width) {
      widthText += ` (min: \`${width.minWidth}\`)`;
    }
    if (width.flexible) {
      widthText += ' *(flexible)*';
    }
    lines.push(widthText);
  }
  if (value !== undefined) {
    lines.push(`Constant value: \`${formatBigInt(value)}\``);
  }
  lines.push('', `Node range: \`${expression.start}..${expression.end}\``);
  return markdownHover(lines.join('\n'), range);
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
      return Location.create(resolved.targetSymbol?.uri ?? resolved.targetModule.uri, resolved.targetSymbol?.selectionRange ?? resolved.targetPort.selectionRange);
    case 'macro': {
      const macro = resolved.macro ?? index.getMacro(resolved.name);
      if (!macro) {
        return undefined;
      }
      return index.macroDefinitionLocations(macro.name)
        .find((location) => rangesEqual(location.range, macro.selectionRange))
        ?? Location.create(document.uri, macro.selectionRange);
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
      const connectionKind = connectionListKindForModuleDecl(resolved.module, resolved.decl);
      if (connectionKind) {
        locations.push(...collectInterfaceConnectionReferences(index, resolved.module, resolved.decl.name, connectionKind));
      }
      return dedupeLocations(locations);
    }
    case 'instance':
      return collectSemanticSymbolReferences(document.uri, parsed.semantic, resolved.module, resolved.instance.instanceName, resolved.instance.selectionRange, includeDeclaration);
    case 'module':
      return collectModuleReferences(index, resolved.module, includeDeclaration);
    case 'portConnection': {
      const locations = collectSignalReferencesForIndexedModule(
        index,
        resolved.targetModule,
        resolved.targetPort.name,
        resolved.targetPort.selectionRange,
        includeDeclaration,
        resolved.targetSymbol
      );
      locations.push(...collectInterfaceConnectionReferences(index, resolved.targetModule, resolved.targetPort.name, resolved.listKind));
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
  const range = sourceRangeAtPosition(parsed.semantic, position) ?? resolved.sourceRange ?? resolvedRange(resolved);
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

  actions.push(...getWidthMismatchCodeActions(document, diagnostics, settings));
  actions.push(...getVerilogDataflowCodeActions(document, diagnostics, settings));
  actions.push(...getVerilogLintRuleCodeActions(diagnostics, settings));
  actions.push(...getInstanceCodeActions(document, range, settings, index));
  actions.push(...getVerilogExpressionCodeActions(document, range, settings));
  actions.push(...getVerilogLiteralCodeActions(document, range));

  return actions;
}

function getVerilogExpressionCodeActions(document: TextDocument, range: Range, settings: CoSettings): CodeAction[] {
  const parsed = getCachedVerilogParse(document, settings, false);
  const module = moduleAtPosition(parsed.modules, range.start);
  const moduleAst = module ? parsed.ast.modules.find((item) => item.module === module) : undefined;
  if (!module || !moduleAst) {
    return [];
  }

  const context = findExpressionActionContextAtOffset(moduleAst, document.offsetAt(range.start));
  if (!context) {
    return [];
  }

  return [
    makeFoldConstantExpressionAction(document, context.expression, module),
    makeExtractConstantLocalparamAction(document, context, module),
    makeExtractWireAction(document, context, module),
    makeRemoveRedundantParenthesesAction(document, context.expression, context.parent)
  ].filter((action): action is CodeAction => Boolean(action));
}

function findExpressionActionContextAtOffset(moduleAst: VerilogModuleAst, offset: number): VerilogExpressionActionContext | undefined {
  let best: VerilogExpressionActionContext | undefined;
  for (const statement of moduleAst.items) {
    const match = findSmallestVerilogExpressionMatchAtOffset(statement.expressions, offset);
    if (!match) {
      continue;
    }
    if (!best || expressionSize(match.expression) < expressionSize(best.expression)) {
      best = { ...match, statement };
    }
  }
  return best;
}

function makeFoldConstantExpressionAction(document: TextDocument, expression: VerilogExpressionAst, module: VerilogModule): CodeAction | undefined {
  if (expression.kind === 'numberLiteral' || expression.kind === 'identifier') {
    return undefined;
  }
  const value = evalExpressionAstConstant(expression, module);
  if (value === undefined) {
    return undefined;
  }
  const expressionRange = Range.create(document.positionAt(expression.start), document.positionAt(expression.end));
  const source = document.getText(expressionRange).trim();
  const replacement = value.toString();
  if (!source || source === replacement) {
    return undefined;
  }
  return {
    title: `Fold constant expression to ${replacement}`,
    kind: CodeActionKind.RefactorRewrite,
    edit: {
      changes: {
        [document.uri]: [TextEdit.replace(expressionRange, replacement)]
      }
    }
  };
}

function makeExtractConstantLocalparamAction(
  document: TextDocument,
  context: VerilogExpressionActionContext,
  module: VerilogModule
): CodeAction | undefined {
  const { expression, statement } = context;
  if (statement.kind !== 'continuousAssign' || expression.kind === 'numberLiteral' || expression.kind === 'identifier') {
    return undefined;
  }
  const assignment = statement.assignment;
  if (!assignment || !containsExpression(assignment.rhs, expression)) {
    return undefined;
  }
  if (evalExpressionAstConstant(expression, module) === undefined) {
    return undefined;
  }
  const expressionRange = Range.create(document.positionAt(expression.start), document.positionAt(expression.end));
  const source = document.getText(expressionRange).trim();
  if (!source || /[\r\n]/.test(source)) {
    return undefined;
  }
  const name = uniqueDeclarationName(module, 'EXPR_CONST');
  const indent = lineAt(document, statement.range.start.line).text.match(/^\s*/)?.[0] ?? '';
  const insert = TextEdit.insert(
    Position.create(statement.range.start.line, 0),
    `${indent}localparam ${name} = ${source};\n`
  );
  return {
    title: `Extract constant expression to localparam ${name}`,
    kind: CodeActionKind.RefactorExtract,
    edit: {
      changes: {
        [document.uri]: [
          insert,
          TextEdit.replace(expressionRange, name)
        ]
      }
    }
  };
}

function makeExtractWireAction(
  document: TextDocument,
  context: VerilogExpressionActionContext,
  module: VerilogModule
): CodeAction | undefined {
  const { expression, statement } = context;
  if (statement.kind !== 'continuousAssign' || expression.kind === 'numberLiteral' || expression.kind === 'identifier' || expression.kind === 'stringLiteral') {
    return undefined;
  }
  const assignment = statement.assignment;
  if (!assignment || !containsExpression(assignment.rhs, expression)) {
    return undefined;
  }
  if (evalExpressionAstConstant(expression, module) !== undefined) {
    return undefined;
  }
  const width = extractWireWidth(expression, assignment.rhs, assignment.lhs, module);
  if (width === undefined || width < 1) {
    return undefined;
  }
  const expressionRange = Range.create(document.positionAt(expression.start), document.positionAt(expression.end));
  const source = document.getText(expressionRange).trim();
  if (!source || /[\r\n]/.test(source)) {
    return undefined;
  }
  const name = uniqueDeclarationName(module, 'EXPR_WIRE');
  const indent = lineAt(document, statement.range.start.line).text.match(/^\s*/)?.[0] ?? '';
  const insert = TextEdit.insert(
    Position.create(statement.range.start.line, 0),
    `${indent}wire ${wireRangeText(width)}${name};\n${indent}assign ${name} = ${source};\n`
  );
  return {
    title: `Extract expression to wire ${name}`,
    kind: CodeActionKind.RefactorExtract,
    edit: {
      changes: {
        [document.uri]: [
          insert,
          TextEdit.replace(expressionRange, name)
        ]
      }
    }
  };
}

function makeRemoveRedundantParenthesesAction(
  document: TextDocument,
  expression: VerilogExpressionAst,
  parent: VerilogExpressionAst | undefined
): CodeAction | undefined {
  if (expression.kind !== 'parenthesizedExpression' || !canRemoveParentheses(expression, parent)) {
    return undefined;
  }
  const outerRange = Range.create(document.positionAt(expression.start), document.positionAt(expression.end));
  const innerRange = Range.create(document.positionAt(expression.expression.start), document.positionAt(expression.expression.end));
  const outer = document.getText(outerRange).trim();
  const inner = document.getText(innerRange);
  if (!outer.startsWith('(') || !outer.endsWith(')') || !inner.trim()) {
    return undefined;
  }
  return {
    title: 'Remove redundant parentheses',
    kind: CodeActionKind.RefactorRewrite,
    edit: {
      changes: {
        [document.uri]: [TextEdit.replace(outerRange, inner)]
      }
    }
  };
}

function canRemoveParentheses(
  expression: Extract<VerilogExpressionAst, { kind: 'parenthesizedExpression' }>,
  parent: VerilogExpressionAst | undefined
): boolean {
  const inner = expression.expression;
  if (inner.kind === 'parenthesizedExpression' || isPrimaryExpression(inner)) {
    return true;
  }
  return parent === undefined;
}

function isPrimaryExpression(expression: VerilogExpressionAst): boolean {
  switch (expression.kind) {
    case 'numberLiteral':
    case 'stringLiteral':
    case 'identifier':
    case 'selectExpression':
    case 'callExpression':
    case 'memberExpression':
    case 'concatenation':
    case 'multipleConcatenation':
      return true;
    default:
      return false;
  }
}

function containsExpression(outer: VerilogExpressionAst, inner: VerilogExpressionAst): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

function extractWireWidth(expression: VerilogExpressionAst, rhs: VerilogExpressionAst, lhs: VerilogExpressionAst, module: VerilogModule): number | undefined {
  const expressionWidth = widthOfExpressionAst(expression, module);
  if (expression === rhs) {
    return widthOfExpressionAst(lhs, module).width ?? expressionWidth.width;
  }
  if (expressionWidth.flexible) {
    return undefined;
  }
  return expressionWidth.width;
}

function wireRangeText(width: number): string {
  return width <= 1 ? '' : `[${width - 1}:0] `;
}

function uniqueDeclarationName(module: VerilogModule, baseName: string): string {
  if (!module.declarations.has(baseName)) {
    return baseName;
  }
  let index = 1;
  while (module.declarations.has(`${baseName}_${index}`)) {
    index++;
  }
  return `${baseName}_${index}`;
}

function expressionSize(expression: VerilogExpressionAst): number {
  return expression.end - expression.start;
}

function getWidthMismatchCodeActions(document: TextDocument, diagnostics: Diagnostic[], settings: CoSettings): CodeAction[] {
  const actions: CodeAction[] = [];
  const codes = new Set(['width-mismatch', 'port-width-mismatch']);
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const code = typeof diagnostic.code === 'string' ? diagnostic.code : undefined;
    if (!code || !codes.has(code) || seen.has(code)) {
      continue;
    }
    seen.add(code);
    // 对此文件禁用
    actions.push({
      title: `对此文件禁用「${code}」检查`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      command: Command.create(
        `对此文件禁用 ${code}`,
        Commands.Diagnostics.DisableCode,
        document.languageId,
        code,
        document.uri
      )
    });
    // 对此工作区禁用
    actions.push({
      title: `对此工作区禁用「${code}」检查`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      command: Command.create(
        `对此工作区禁用 ${code}`,
        Commands.Diagnostics.DisableCode,
        document.languageId,
        code
      )
    });
  }
  return actions;
}

function getVerilogDataflowCodeActions(document: TextDocument, diagnostics: Diagnostic[], settings: CoSettings): CodeAction[] {
  const actions: CodeAction[] = [];
  const parsed = getCachedVerilogParse(document, settings, false);
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== 'vc-008-case-default') {
      continue;
    }
    const key = rangeKey(diagnostic.range);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const caseStatement = findCaseStatementForRange(parsed.ast.modules, diagnostic.range);
    const edit = caseStatement ? addDefaultCaseItemEdit(document, caseStatement) : undefined;
    if (!edit) {
      continue;
    }
    actions.push({
      title: 'Add default case item',
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [document.uri]: [edit]
        }
      }
    });
  }
  return actions;
}

function findCaseStatementForRange(modules: VerilogModuleAst[], range: Range): VerilogCaseStatementAst | undefined {
  for (const moduleAst of modules) {
    for (const block of moduleAst.alwaysBlocks) {
      const found = findCaseStatementInProceduralAst(block.statementTree, range);
      if (found) {
        return found;
      }
    }
    for (const block of moduleAst.proceduralBlocks) {
      const found = findCaseStatementInProceduralAst(block.statementTree, range);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function findCaseStatementInProceduralAst(node: VerilogProceduralStatementAst, range: Range): VerilogCaseStatementAst | undefined {
  if (node.kind === 'case' && rangesEqual(node.range, range)) {
    return node;
  }
  for (const child of proceduralStatementChildren(node)) {
    const found = findCaseStatementInProceduralAst(child, range);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function proceduralStatementChildren(node: VerilogProceduralStatementAst): VerilogProceduralStatementAst[] {
  switch (node.kind) {
    case 'block':
      return node.statements;
    case 'if':
      return [node.consequent, ...(node.alternate ? [node.alternate] : [])];
    case 'case':
      return node.items.map((item) => item.body);
    case 'loop':
      return [node.body];
    default:
      return [];
  }
}

function addDefaultCaseItemEdit(document: TextDocument, statement: VerilogCaseStatementAst): TextEdit | undefined {
  if (statement.items.some((item) => item.defaultItem)) {
    return undefined;
  }
  if (statement.range.end.line < statement.range.start.line) {
    return undefined;
  }
  const indent = defaultCaseIndent(document, statement);
  return TextEdit.insert(Position.create(statement.range.end.line, 0), `${indent}default: ;\n`);
}

function defaultCaseIndent(document: TextDocument, statement: VerilogCaseStatementAst): string {
  const firstItem = statement.items[0];
  if (firstItem) {
    return lineAt(document, firstItem.labelRange.start.line).text.match(/^\s*/)?.[0] ?? '';
  }
  const caseIndent = lineAt(document, statement.range.start.line).text.match(/^\s*/)?.[0] ?? '';
  return `${caseIndent}    `;
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
      command: Command.create(`Disable ${rule.toUpperCase()}`, Commands.Verilog.DisableLintRule, rule)
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
      const target = resolveInstanceTargetModule(index, parsed.modules, instance);
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
        const overrides = parameterOverridesForInstance(instance, module, target);
        const direction = portDirectionLabel(port);
        const effectiveWidth = widthOfDecl(port, target, overrides).width;
        const labelSuffix = effectiveWidth && effectiveWidth > 1 ? `${direction}[${effectiveWidth}]` : direction;
        const tooltip = {
          kind: MarkupKind.Markdown,
          value: portConnectionTooltip(module, instance, target, port, connection)
        };
        if (connection.nameRange && lineInRange(connection.nameRange.start.line, range)) {
          hints.push({
            position: connection.nameRange.end,
            label: `: ${labelSuffix}`,
            kind: InlayHintKind.Type,
            tooltip,
            paddingLeft: true
          });
        } else if (!connection.name && lineInRange(connection.expressionRange.start.line, range)) {
          hints.push({
            position: connection.expressionRange.start,
            label: `.${port.name}: ${labelSuffix}=`,
            kind: InlayHintKind.Parameter,
            tooltip,
            paddingRight: true
          });
        }
      }
      for (const connection of instance.parameterConnections) {
        const parameter = connection.name
          ? target.parameters.find((item) => item.name === connection.name)
          : target.parameters[connection.positionalIndex];
        if (!parameter) {
          continue;
        }
        const tooltip = {
          kind: MarkupKind.Markdown,
          value: parameterConnectionTooltip(module, instance, target, parameter, connection)
        };
        if (connection.nameRange && lineInRange(connection.nameRange.start.line, range)) {
          hints.push({
            position: connection.nameRange.end,
            label: ': param',
            kind: InlayHintKind.Type,
            tooltip,
            paddingLeft: true
          });
        } else if (!connection.name && lineInRange(connection.expressionRange.start.line, range)) {
          hints.push({
            position: connection.expressionRange.start,
            label: `.${parameter.name}=`,
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
    targetModule: resolveInstanceTargetModule(index, modules, instance),
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
  const currentModule = moduleAtPosition(parsed.modules, position);
  if (currentModule) {
    if (containsPosition(currentModule.selectionRange, position)) {
      return { kind: 'module', module: currentModule, sourceRange: currentModule.selectionRange };
    }
    for (const instance of currentModule.instances) {
      if (containsPosition(instance.moduleSelectionRange, position)) {
        const target = resolveInstanceTargetModule(index, parsed.modules, instance);
        return target ? { kind: 'module', module: target, sourceRange: instance.moduleSelectionRange } : undefined;
      }
      if (containsPosition(instance.selectionRange, position)) {
        return { kind: 'instance', module: currentModule, instance, sourceRange: instance.selectionRange };
      }
      const namedConnection = findNamedInstanceConnectionAtPosition(instance, position);
      if (namedConnection) {
        const target = resolveInstanceConnectionTarget(index, parsed.modules, instance, namedConnection.connection, namedConnection.listKind);
        if (target) {
          return { kind: 'portConnection', module: currentModule, instance, connection: namedConnection.connection, sourceRange: namedConnection.connection.nameRange, ...target };
        }
      }
    }
    const decl = [...currentModule.declarations.values()].find((item) => containsPosition(item.selectionRange, position));
    if (decl) {
      return { kind: 'decl', decl, module: currentModule, sourceRange: decl.selectionRange };
    }
  }

  const macro = parsed.macros.find((item) => containsPosition(item.selectionRange, position));
  if (macro) {
    return { kind: 'macro', macro, name: macro.name, sourceRange: macro.selectionRange };
  }
  const macroUse = parsed.macroUses.find((item) => containsPosition(item.selectionRange, position));
  if (macroUse) {
    return { kind: 'macro', macro: index.getMacro(macroUse.name), macroUse, name: macroUse.name, sourceRange: macroUse.selectionRange };
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
    const listKind = connectionListKindForInstanceConnection(reference.instance, reference.portConnection);
    const target = resolveInstanceConnectionTarget(index, modules, reference.instance, reference.portConnection, listKind);
    if (target) {
      return {
        kind: 'portConnection',
        module: reference.module,
        instance: reference.instance,
        connection: reference.portConnection,
        sourceRange: reference.range,
        ...target
      };
    }
  }
  if (reference?.kind === 'module') {
    const module = resolved.symbol?.module ?? index.getModule(reference.name) ?? modules.find((item) => item.name === reference.name);
    return module ? { kind: 'module', module, sourceRange: reference.range } : undefined;
  }
  if (reference?.kind === 'macro') {
    return {
      kind: 'macro',
      macro: resolved.symbol?.macro ?? index.getMacro(reference.name),
      macroUse: reference.macroUse,
      name: reference.name,
      sourceRange: reference.range
    };
  }
  if (reference?.kind === 'include' && reference.include) {
    return { kind: 'include', include: reference.include, sourceRange: reference.range };
  }

  const symbol = resolved.symbol;
  if (!symbol) {
    return undefined;
  }
  if (symbol.kind === 'module' && symbol.module) {
    return { kind: 'module', module: symbol.module, sourceRange: symbol.selectionRange };
  }
  if ((symbol.kind === 'signal' || symbol.kind === 'port' || symbol.kind === 'parameter' || symbol.kind === 'task') && symbol.decl && symbol.module) {
    return { kind: 'decl', decl: symbol.decl, module: symbol.module, sourceRange: symbol.selectionRange };
  }
  if (symbol.kind === 'instance' && symbol.instance && symbol.module) {
    return { kind: 'instance', instance: symbol.instance, module: symbol.module, sourceRange: symbol.selectionRange };
  }
  if (symbol.kind === 'macro') {
    return { kind: 'macro', macro: symbol.macro, name: symbol.name, sourceRange: symbol.selectionRange };
  }
  if (symbol.kind === 'include' && symbol.include) {
    return { kind: 'include', include: symbol.include, sourceRange: symbol.selectionRange };
  }
  return undefined;
}

function resolveInstanceTargetModule(index: VerilogWorkspaceIndex, modules: VerilogModule[], instance: VerilogInstance): VerilogModule | undefined {
  return index.getModule(instance.moduleName) ?? modules.find((item) => item.name === instance.moduleName);
}

function resolveInstanceConnectionTarget(
  index: VerilogWorkspaceIndex,
  modules: VerilogModule[],
  instance: VerilogInstance,
  connection: VerilogPortConnection,
  preferredListKind?: VerilogConnectionListKind
): InstanceConnectionTarget | undefined {
  if (!connection.name) {
    return undefined;
  }
  const targetModule = resolveInstanceTargetModule(index, modules, instance);
  if (!targetModule) {
    return undefined;
  }
  const listKinds = preferredListKind ? [preferredListKind] : (['ports', 'parameters'] as const);
  for (const listKind of listKinds) {
    const targetSymbol = index.findModuleSymbol(targetModule, connection.name, semanticKindsForConnectionList(listKind));
    const targetPort = targetSymbol?.decl ?? declarationsForConnectionList(targetModule, listKind).find((decl) => decl.name === connection.name);
    if (targetPort) {
      return {
        targetModule,
        targetPort,
        targetSymbol,
        listKind
      };
    }
  }
  return undefined;
}

function findNamedInstanceConnectionAtPosition(instance: VerilogInstance, position: Position): NamedInstanceConnection | undefined {
  for (const connection of instance.parameterConnections) {
    if (connection.nameRange && containsPosition(connection.nameRange, position)) {
      return { connection, listKind: 'parameters' };
    }
  }
  for (const connection of instance.portConnections) {
    if (connection.nameRange && containsPosition(connection.nameRange, position)) {
      return { connection, listKind: 'ports' };
    }
  }
  return undefined;
}

function connectionListKindForInstanceConnection(instance: VerilogInstance, connection: VerilogPortConnection): VerilogConnectionListKind | undefined {
  if (instance.parameterConnections.includes(connection)) {
    return 'parameters';
  }
  if (instance.portConnections.includes(connection)) {
    return 'ports';
  }
  return undefined;
}

function connectionListKindForModuleDecl(module: VerilogModule, decl: VerilogDecl): VerilogConnectionListKind | undefined {
  if (module.ports.some((port) => sameDeclarationIdentity(port, decl))) {
    return 'ports';
  }
  if (module.parameters.some((param) => sameDeclarationIdentity(param, decl))) {
    return 'parameters';
  }
  return undefined;
}

function declarationsForConnectionList(module: VerilogModule, listKind: VerilogConnectionListKind): VerilogDecl[] {
  return listKind === 'parameters' ? module.parameters : module.ports;
}

function semanticKindsForConnectionList(listKind: VerilogConnectionListKind): readonly ('parameter' | 'port')[] {
  return listKind === 'parameters' ? ['parameter'] : ['port'];
}

function sameDeclarationIdentity(left: VerilogDecl, right: VerilogDecl): boolean {
  return left === right || (left.name === right.name && rangesEqual(left.selectionRange, right.selectionRange));
}

function collectSignalReferencesForIndexedModule(
  index: VerilogWorkspaceIndex,
  module: VerilogModule,
  name: string,
  declarationRange: Range | undefined,
  includeDeclaration: boolean,
  targetSymbol?: VerilogSemanticSymbol
): Location[] {
  const file = index.getFile(module.uri);
  if (!file) {
    return includeDeclaration && declarationRange ? [Location.create(module.uri, declarationRange)] : [];
  }
  if (targetSymbol) {
    return collectSemanticSymbolReferenceLocations(file.uri, file.semantic, targetSymbol, includeDeclaration);
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
  return collectSemanticSymbolReferenceLocations(uri, semantic, symbol, includeDeclaration);
}

function collectSemanticSymbolReferenceLocations(uri: string, semantic: VerilogSemanticModel, symbol: VerilogSemanticSymbol, includeDeclaration: boolean): Location[] {
  return verilogSemanticReferenceRanges(semantic, verilogSemanticTargetFromSymbol(symbol), includeDeclaration)
    .map((range) => Location.create(uri, range));
}

function collectModuleReferences(index: VerilogWorkspaceIndex, target: VerilogModule, includeDeclaration: boolean): Location[] {
  const locations: Location[] = [];
  if (includeDeclaration) {
    locations.push(Location.create(target.uri, target.selectionRange));
  }
  locations.push(...index.moduleReferenceLocations(target.name));
  return dedupeLocations(locations);
}

function collectInterfaceConnectionReferences(
  index: VerilogWorkspaceIndex,
  targetModule: VerilogModule,
  name: string,
  listKind: VerilogConnectionListKind
): Location[] {
  return [...index.interfaceConnectionLocations(targetModule.name, name, listKind)];
}

function collectMacroReferences(index: VerilogWorkspaceIndex, name: string, macro: VerilogMacro | undefined, includeDeclaration: boolean, fallbackUri: string): Location[] {
  const locations: Location[] = [];
  if (includeDeclaration) {
    const definitions = macro
      ? index.macroDefinitionLocations(name).filter((location) => rangesEqual(location.range, macro.selectionRange))
      : index.macroDefinitionLocations(name);
    if (macro && !definitions.length) {
      locations.push(Location.create(fallbackUri, macro.selectionRange));
    } else {
      locations.push(...definitions);
    }
  }
  locations.push(...index.macroUseLocations(name));
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
        targetModule: resolveInstanceTargetModule(index, modules, instance),
        listKind: 'parameters',
        listRange: instance.parameterListRange,
        connections: instance.parameterConnections
      };
    }
    if (instance.portListRange && containsPosition(instance.portListRange, position)) {
      return {
        module,
        instance,
        targetModule: resolveInstanceTargetModule(index, modules, instance),
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

function sourceRangeAtPosition(semantic: VerilogSemanticModel, position: Position): Range | undefined {
  const resolved = resolveVerilogSemanticAtPosition(semantic, position);
  return resolved?.reference?.range ?? resolved?.symbol?.selectionRange;
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

function instanceMarkdown(instance: VerilogInstance, parentModule: VerilogModule, targetModule: VerilogModule | undefined): string {
  const lines = [`Instance \`${instance.instanceName}\` of module \`${instance.moduleName}\`.`];
  if (!targetModule) {
    return lines.join('\n');
  }
  const overrides = parameterOverridesForInstance(instance, parentModule, targetModule);
  const parameterLines = effectiveParameterLines(targetModule, overrides);
  if (parameterLines.length) {
    lines.push('', 'Effective parameters:', '```verilog', ...parameterLines, '```');
  }
  return lines.join('\n');
}

function connectionMarkdown(resolved: ResolvedPortConnection): string {
  return resolved.listKind === 'parameters'
    ? parameterConnectionMarkdown(resolved.module, resolved.instance, resolved.targetModule, resolved.targetPort, resolved.connection)
    : portConnectionMarkdown(resolved.module, resolved.instance, resolved.targetModule, resolved.targetPort, resolved.connection);
}

function portConnectionMarkdown(
  parentModule: VerilogModule,
  instance: VerilogInstance,
  targetModule: VerilogModule,
  port: VerilogDecl,
  connection: VerilogPortConnection
): string {
  const lines = [
    `Port \`${port.name}\` on module \`${targetModule.name}\``,
    '',
    `\`${declDetail(port)}\``
  ];
  const overrides = parameterOverridesForInstance(instance, parentModule, targetModule);
  const expected = widthOfDecl(port, targetModule, overrides);
  const actual = connection.expressionAst ? widthOfExpressionAst(connection.expressionAst, parentModule) : undefined;
  lines.push(...widthMarkdownLines('Effective width', expected));
  if (actual) {
    lines.push(...widthMarkdownLines('Connection width', actual));
  }
  return lines.join('\n');
}

function parameterConnectionMarkdown(
  parentModule: VerilogModule,
  instance: VerilogInstance,
  targetModule: VerilogModule,
  parameter: VerilogDecl,
  connection: VerilogPortConnection
): string {
  const lines = [
    `Parameter \`${parameter.name}\` on module \`${targetModule.name}\``,
    '',
    `\`${declDetail(parameter)}\``
  ];
  const overrides = parameterOverridesForInstance(instance, parentModule, targetModule);
  const effective = effectiveParameterValue(parameter, targetModule, overrides);
  if (effective !== undefined) {
    lines.push('', `Effective value: \`${formatBigInt(effective)}\``);
  }
  const supplied = connection.expressionAst
    ? evalExpressionAstConstant(connection.expressionAst, parentModule)
    : undefined;
  if (supplied !== undefined) {
    lines.push(`Connection value: \`${formatBigInt(supplied)}\``);
  }
  const width = widthOfDecl(parameter, targetModule, overrides);
  lines.push(...widthMarkdownLines('Parameter width', width));
  return lines.join('\n');
}

function portConnectionTooltip(
  parentModule: VerilogModule,
  instance: VerilogInstance,
  targetModule: VerilogModule,
  port: VerilogDecl,
  connection: VerilogPortConnection
): string {
  return portConnectionMarkdown(parentModule, instance, targetModule, port, connection);
}

function parameterConnectionTooltip(
  parentModule: VerilogModule,
  instance: VerilogInstance,
  targetModule: VerilogModule,
  parameter: VerilogDecl,
  connection: VerilogPortConnection
): string {
  return parameterConnectionMarkdown(parentModule, instance, targetModule, parameter, connection);
}

function effectiveParameterLines(module: VerilogModule, overrides?: VerilogConstantOverrides): string[] {
  return module.parameters
    .map((parameter) => {
      const value = effectiveParameterValue(parameter, module, overrides);
      if (value === undefined) {
        return undefined;
      }
      const source = overrides?.has(parameter.name) ? ' // override' : '';
      return `${parameter.name} = ${formatBigInt(value)}${source}`;
    })
    .filter((line): line is string => Boolean(line));
}

function effectiveParameterValue(
  parameter: VerilogDecl,
  module: VerilogModule,
  overrides?: VerilogConstantOverrides
): bigint | undefined {
  const override = overrides?.get(parameter.name);
  if (override !== undefined) {
    return override;
  }
  if (parameter.initializerAst) {
    return evalExpressionAstConstant(parameter.initializerAst, module, overrides);
  }
  return parameter.constantValue;
}

function widthMarkdownLines(label: string, info: WidthInfo): string[] {
  if (info.width === undefined) {
    return [];
  }
  let text = `${label}: \`${info.width}\``;
  if (info.minWidth !== undefined && info.minWidth !== info.width) {
    text += ` (min: \`${info.minWidth}\`)`;
  }
  if (info.flexible) {
    text += ' *(flexible)*';
  }
  return ['', text];
}

function formatBigInt(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const hex = `0x${magnitude.toString(16)}`;
  return negative ? `${value.toString()} (-${hex})` : `${value.toString()} (${hex})`;
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
