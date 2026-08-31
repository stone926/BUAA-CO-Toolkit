// @index(Verilog quick-fix and refactor code actions)
import {
  CodeAction,
  CodeActionKind,
  Command,
  Diagnostic,
  Position,
  Range,
  TextEdit
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Commands } from '../../constants';
import { containsPosition, lineAt, rangesEqual } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { rangeKey } from '../common/util';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { VerilogDecl, VerilogInstance, VerilogModule, VerilogPortConnection } from './model';
import { moduleAtPosition } from './parser';
import { getCachedVerilogParse } from './parseCache';
import { getVerilogLiteralCodeActions } from './numericLiterals';
import { evalExpressionAstConstant, widthOfExpressionAst } from './expressions';
import type { VerilogExpressionAst } from './exprAst';
import type { VerilogModuleAst, VerilogStatementAst } from './ast';
import type { VerilogCaseStatementAst, VerilogProceduralStatementAst } from './proceduralAst';
import { findSmallestVerilogExpressionMatchAtOffset } from './exprAstUtils';
import type { VerilogExpressionMatch } from './exprAstUtils';
import { InstanceContext, resolveInstanceTargetModule } from './resolveSymbol';

interface VerilogExpressionActionContext extends VerilogExpressionMatch {
  statement: VerilogStatementAst;
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
  actions.push(...getVerilogLintRuleCodeActions(document, diagnostics, settings));
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
        'file',
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
        code,
        'workspace',
        document.uri
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

function getVerilogLintRuleCodeActions(document: TextDocument, diagnostics: Diagnostic[], settings: CoSettings): CodeAction[] {
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
      command: Command.create(`Disable ${rule.toUpperCase()}`, Commands.Verilog.DisableLintRule, rule, document.uri)
    });
  }
  return actions;
}

function verilogLintRuleFromDiagnostic(diagnostic: Diagnostic): string | undefined {
  const code = typeof diagnostic.code === 'string' ? diagnostic.code : undefined;
  const source = code ?? diagnostic.message;
  return source.match(/\bvc-\d{3}\b/i)?.[0].toLowerCase();
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
