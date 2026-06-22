import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { ProjectProfile } from '../../projectProfile';
import { lineAt, makeDiagnostic } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { evalExpressionAstConstant, shouldReportWidthMismatch, widthOfDecl, widthOfExpression, widthOfExpressionAst } from './expressions';
import { findAssignmentOperator } from './assignmentAnalysis';
import type { VerilogAstDocument, VerilogModuleAst, VerilogStatementAst } from './ast';
import { parseVerilogExpression } from './exprAst';
import type { VerilogExpressionAst } from './exprAst';
import { walkVerilogExpression } from './exprAstUtils';
import {
  expectedPorts,
  VerilogInclude,
  VerilogModule,
  VerilogPortConnection
} from './model';
import { VerilogCstDocument, verilogTokenRange } from './cst';
import { isIdentifierLike, VerilogToken } from './lexer';
import { collectSyntaxDiagnostics } from './syntaxDiagnostics';
import { parameterOverridesForInstance } from './parameterOverrides';
import {
  collectAssignmentDiagnostics,
  collectCourseStyleDiagnostics,
  collectExplicitPortNetTypeDiagnostics,
  collectImplicitNetDiagnostics,
  collectSynthesizableHintDiagnostics
} from './lintDiagnostics';
import { normalizeWidth } from './textUtils';
import type { VerilogSemanticModel } from './semanticModel';

export function collectVerilogDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  text: string,
  modules: VerilogModule[],
  includes: VerilogInclude[],
  cst: VerilogCstDocument,
  ast: VerilogAstDocument,
  semantic?: VerilogSemanticModel
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  collectSyntaxDiagnostics(document, cst, modules, diagnostics);
  collectStructuralDiagnostics(document, modules, diagnostics);
  collectIncludeDiagnostics(document, includes, diagnostics);
  collectInstancePortDiagnostics(modules, diagnostics);
  collectWidthDiagnostics(document, text, modules, cst, ast, diagnostics);
  collectConstantDivisorDiagnostics(document, modules, ast, diagnostics);
  if (settings.verilog.lint.courseRules) {
    collectCourseDiagnostics(document, settings, modules, cst, diagnostics);
    collectAssignmentDiagnostics(document, settings, text, modules, cst, diagnostics);
    collectCourseStyleDiagnostics(document, settings, text, modules, cst, diagnostics);
  }
  if (settings.verilog.lint.synthesizableHints) {
    collectSynthesizableHintDiagnostics(document, settings, text, modules, cst, diagnostics);
  }
  collectExplicitPortNetTypeDiagnostics(document, modules, cst, diagnostics);
  collectImplicitNetDiagnostics(document, settings, text, modules, cst, diagnostics, semantic);
  return diagnostics;
}

function collectStructuralDiagnostics(document: TextDocument, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  const seenModules = new Map<string, VerilogModule>();
  for (const module of modules) {
    if (!module.hasEndmodule) {
      diagnostics.push(makeDiagnostic(module.selectionRange, `Module '${module.name}' is missing endmodule.`, DiagnosticSeverity.Error, 'missing-endmodule'));
    }
    const previous = seenModules.get(module.name);
    if (previous) {
      diagnostics.push(makeDiagnostic(module.selectionRange, `Duplicate module '${module.name}'. First definition is at line ${previous.selectionRange.start.line + 1}.`, DiagnosticSeverity.Error, 'duplicate-module'));
    } else {
      seenModules.set(module.name, module);
    }
  }
}

function collectIncludeDiagnostics(document: TextDocument, includes: VerilogInclude[], diagnostics: Diagnostic[]): void {
  if (!includes.length || document.uri.startsWith('untitled:')) {
    return;
  }
  let baseDir: string | undefined;
  try {
    baseDir = path.dirname(URI.parse(document.uri).fsPath);
  } catch {
    return;
  }
  for (const include of includes) {
    const includePath = path.isAbsolute(include.path) ? include.path : path.resolve(baseDir, include.path);
    if (!fs.existsSync(includePath)) {
      diagnostics.push(makeDiagnostic(include.pathRange, `Included file '${include.path}' was not found relative to this file.`, DiagnosticSeverity.Warning, 'missing-include'));
    }
  }
}

function collectInstancePortDiagnostics(modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  const modulesByName = new Map(modules.map((module) => [module.name, module]));
  for (const module of modules) {
    for (const instance of module.instances) {
      const target = modulesByName.get(instance.moduleName);
      if (!target) {
        continue;
      }
      const targetPorts = new Map(target.ports.map((port) => [port.name, port]));
      const seenConnections = new Map<string, VerilogPortConnection>();
      for (const connection of instance.portConnections) {
        if (!connection.name) {
          continue;
        }
        const previous = seenConnections.get(connection.name);
        if (previous) {
          diagnostics.push(makeDiagnostic(connection.nameRange ?? connection.range, `Port '${connection.name}' is connected more than once.`, DiagnosticSeverity.Warning, 'duplicate-port-connection'));
          continue;
        }
        seenConnections.set(connection.name, connection);
        if (!targetPorts.has(connection.name)) {
          diagnostics.push(makeDiagnostic(connection.nameRange ?? connection.range, `Module '${target.name}' has no port named '${connection.name}'.`, DiagnosticSeverity.Error, 'unknown-port'));
        }
      }
      if (instance.portConnections.some((connection) => connection.name)) {
        for (const port of target.ports) {
          if (!seenConnections.has(port.name)) {
            diagnostics.push(makeDiagnostic(instance.selectionRange, `Instance '${instance.instanceName}' does not connect port '${port.name}'.`, DiagnosticSeverity.Information, `missing-port:${port.name}`));
          }
        }
      }
    }
  }
}

function collectConstantDivisorDiagnostics(document: TextDocument, modules: VerilogModule[], ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    const moduleAst = ast.modules.find((item) => item.module === module);
    if (moduleAst) {
      for (const statement of moduleAst.items) {
        for (const expression of statement.expressions) {
          collectConstantDivisorDiagnosticsForExpression(document, module, expression, 0, diagnostics);
        }
      }
    }

    for (const decl of module.declarations.values()) {
      if (!decl.initializer || !decl.initializerRange) {
        continue;
      }
      const expression = parseVerilogExpression(decl.initializer);
      if (!expression) {
        continue;
      }
      collectConstantDivisorDiagnosticsForExpression(
        document,
        module,
        expression,
        expressionBaseOffset(document, decl.initializerRange, decl.initializer),
        diagnostics
      );
    }

    for (const instance of module.instances) {
      for (const connection of [...instance.parameterConnections, ...instance.portConnections]) {
        if (!connection.expression.trim()) {
          continue;
        }
        const expression = parseVerilogExpression(connection.expression);
        if (!expression) {
          continue;
        }
        collectConstantDivisorDiagnosticsForExpression(
          document,
          module,
          expression,
          expressionBaseOffset(document, connection.expressionRange, connection.expression),
          diagnostics
        );
      }
    }
  }
}

function collectConstantDivisorDiagnosticsForExpression(
  document: TextDocument,
  module: VerilogModule,
  expression: VerilogExpressionAst,
  baseOffset: number,
  diagnostics: Diagnostic[]
): void {
  walkVerilogExpression(expression, (candidate) => {
    if (candidate.kind !== 'binaryExpression' || (candidate.operator !== '/' && candidate.operator !== '%')) {
      return;
    }
    const divisor = evalExpressionAstConstant(candidate.right, module);
    if (divisor !== 0n) {
      return;
    }
    diagnostics.push(makeDiagnostic(
      expressionRangeAtBase(document, candidate.right, baseOffset),
      `Constant ${candidate.operator === '/' ? 'division' : 'modulo'} by zero.`,
      DiagnosticSeverity.Warning,
      'constant-division-by-zero'
    ));
  });
}

function expressionBaseOffset(document: TextDocument, range: Range, expressionText: string): number {
  const rangeStart = document.offsetAt(range.start);
  const rangeText = document.getText(range);
  const index = rangeText.indexOf(expressionText);
  return rangeStart + Math.max(0, index);
}

function expressionRangeAtBase(document: TextDocument, expression: VerilogExpressionAst, baseOffset: number): Range {
  return Range.create(document.positionAt(baseOffset + expression.start), document.positionAt(baseOffset + expression.end));
}

function collectWidthDiagnostics(document: TextDocument, text: string, modules: VerilogModule[], cst: VerilogCstDocument, ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  const modulesByName = new Map(modules.map((module) => [module.name, module]));
  for (const module of modules) {
    const moduleAst = ast.modules.find((item) => item.module === module);
    const bodyStart = document.offsetAt(module.headerEnd);
    const bodyEnd = document.offsetAt(module.range.end);
    for (const statement of cst.statements) {
      if (statement.start < bodyStart || statement.start >= bodyEnd) {
        continue;
      }
      const tokens = trimStatementTokens(statement.tokens);
      if (isDeclarationStatement(tokens)) {
        collectDeclarationInitializerWidthDiagnostics(document, text, module, tokens, diagnostics);
        continue;
      }
    }
    if (moduleAst) {
      collectAssignmentWidthDiagnostics(document, moduleAst, diagnostics);
    }

    for (const instance of module.instances) {
      const target = modulesByName.get(instance.moduleName);
      if (!target) {
        continue;
      }
      for (const connection of instance.portConnections) {
        const targetPort = connection.name
          ? target.ports.find((port) => port.name === connection.name)
          : target.ports[connection.positionalIndex];
        if (!targetPort || !connection.expression.trim()) {
          continue;
        }
        const expected = widthOfDecl(targetPort, target, parameterOverridesForInstance(instance, module, target));
        const actual = widthOfExpression(connection.expression, module);
        if (shouldReportWidthMismatch(expected, actual)) {
          diagnostics.push(makeDiagnostic(
            connection.expressionRange,
            `Port '${targetPort.name}' is ${expected.width} bit(s), but this connection is ${actual.width} bit(s).`,
            DiagnosticSeverity.Warning,
            'port-width-mismatch'
          ));
        }
      }
    }
  }
}

function collectAssignmentWidthDiagnostics(document: TextDocument, moduleAst: VerilogModuleAst, diagnostics: Diagnostic[]): void {
  for (const statement of moduleAst.items) {
    if (statement.kind === 'declaration') {
      continue;
    }
    collectStatementAssignmentWidthDiagnostic(document, moduleAst.module, statement, diagnostics);
  }
}

function collectStatementAssignmentWidthDiagnostic(
  document: TextDocument,
  module: VerilogModule,
  statement: VerilogStatementAst,
  diagnostics: Diagnostic[]
): void {
  const assignment = statement.assignment;
  if (!assignment) {
    return;
  }
  const lhs = widthOfExpressionAst(assignment.lhs, module);
  const rhs = widthOfExpressionAst(assignment.rhs, module);
  if (!shouldReportWidthMismatch(lhs, rhs)) {
    return;
  }
  const lhsRange = Range.create(document.positionAt(assignment.lhs.start), document.positionAt(assignment.lhs.end));
  const rhsRange = Range.create(document.positionAt(assignment.rhs.start), document.positionAt(assignment.rhs.end));
  diagnostics.push(makeDiagnostic(
    rhsRange,
    `Width mismatch: '${document.getText(lhsRange).trim()}' is ${lhs.width} bit(s), but this expression is ${rhs.width} bit(s).`,
    DiagnosticSeverity.Warning,
    'width-mismatch'
  ));
}

const declarationStatementKeywords = new Set([
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'integer',
  'real',
  'realtime',
  'time',
  'parameter',
  'localparam',
  'genvar'
]);

const declarationModifierKeywords = new Set([
  'signed', 'unsigned', 'automatic', 'scalared', 'vectored',
  'tri', 'tri0', 'tri1', 'supply0', 'supply1', 'wand', 'wor'
]);

// parameter/localparam widths are inferred FROM their initializer, so checking them is circular;
// genvar is a loop index, not a sized net.
const initializerWidthCheckedKinds = new Set(['wire', 'reg', 'logic', 'integer', 'time', 'input', 'output', 'inout']);

// `wire [31:0] x = {20'h0, imm16};` is a declaration with an initializer — the assignment-statement
// loop skips declarations, so initializer width is checked here. Each declarator `name = expr` is
// compared against the declared width; only truncation is reported (see shouldReportWidthMismatch).
function collectDeclarationInitializerWidthDiagnostics(
  document: TextDocument,
  text: string,
  module: VerilogModule,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[]
): void {
  const start = firstDeclaratorIndex(tokens);
  if (start < 0) {
    return;
  }
  for (const declarator of splitTopLevelByComma(tokens.slice(start))) {
    const operatorIndex = findAssignmentOperator(declarator);
    if (operatorIndex <= 0 || declarator[operatorIndex].value !== '=') {
      continue;
    }
    const nameToken = declarator[0];
    if (!nameToken || !isIdentifierLike(nameToken.kind)) {
      continue;
    }
    const decl = module.declarations.get(nameToken.value);
    if (!decl || !initializerWidthCheckedKinds.has(decl.kind)) {
      continue;
    }
    const initTokens = declarator.slice(operatorIndex + 1);
    if (!initTokens.length) {
      continue;
    }
    const expected = widthOfDecl(decl, module);
    const actual = widthOfExpression(tokenText(text, initTokens).trim(), module);
    if (shouldReportWidthMismatch(expected, actual)) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, initTokens),
        `Width mismatch: '${nameToken.value}' is ${expected.width} bit(s), but its initializer is ${actual.width} bit(s).`,
        DiagnosticSeverity.Warning,
        'width-mismatch'
      ));
    }
  }
}

function firstDeclaratorIndex(tokens: VerilogToken[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.value === '[') {
      const close = matchingBracket(tokens, index);
      if (close < 0) {
        return -1;
      }
      index = close + 1;
      continue;
    }
    if (token.kind === 'keyword' && (declarationStatementKeywords.has(token.value) || declarationModifierKeywords.has(token.value))) {
      index++;
      continue;
    }
    return isIdentifierLike(token.kind) ? index : -1;
  }
  return -1;
}

function matchingBracket(tokens: VerilogToken[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    if (tokens[index].value === '[') {
      depth++;
    } else if (tokens[index].value === ']') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitTopLevelByComma(tokens: VerilogToken[]): VerilogToken[][] {
  const parts: VerilogToken[][] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < tokens.length; index++) {
    const value = tokens[index].value;
    if (value === '(') {
      paren++;
    } else if (value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (value === '[') {
      bracket++;
    } else if (value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (value === '{') {
      brace++;
    } else if (value === '}') {
      brace = Math.max(0, brace - 1);
    } else if (value === ',' && paren === 0 && bracket === 0 && brace === 0) {
      parts.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(tokens.slice(start));
  return parts.filter((part) => part.length > 0);
}

function trimStatementTokens(tokens: VerilogToken[]): VerilogToken[] {
  const result = tokens.filter((token) => token.kind !== 'eof');
  return result[result.length - 1]?.value === ';' ? result.slice(0, -1) : result;
}

function isDeclarationStatement(tokens: VerilogToken[]): boolean {
  return Boolean(tokens[0] && declarationStatementKeywords.has(tokens[0].value));
}

function tokenText(text: string, tokens: VerilogToken[]): string {
  if (!tokens.length) {
    return '';
  }
  return text.slice(tokens[0].start, tokens[tokens.length - 1].end);
}

function tokenRange(document: TextDocument, tokens: VerilogToken[]): Range {
  return Range.create(document.positionAt(tokens[0].start), document.positionAt(tokens[tokens.length - 1].end));
}

function collectCourseDiagnostics(document: TextDocument, settings: CoSettings, modules: VerilogModule[], cst: VerilogCstDocument, diagnostics: Diagnostic[]): void {
  const profile = settings.project.profile;
  const topName = settings.project.topModule.trim() || 'mips';
  const top = modules.find((module) => module.name === topName);

  if ((profile === 'P4' || profile === 'P5' || profile === 'P6' || profile === 'P7') && !top) {
    const firstLine = lineAt(document, 0).text;
    diagnostics.push(makeDiagnostic(Range.create(0, 0, 0, Math.max(1, firstLine.length)), `Top module '${topName}' was not found.`, DiagnosticSeverity.Warning, 'missing-top'));
  }

  if (top && (profile === 'P4' || profile === 'P5' || profile === 'P6' || profile === 'P7')) {
    checkExpectedPorts(top, profile, diagnostics);
  }

  if (top && (profile === 'P6' || profile === 'P7')) {
    for (const token of cst.codeTokens) {
      if (token.kind === 'systemIdentifier' && token.value === '$display' && tokenInsideModule(document, token, top)) {
        diagnostics.push(makeDiagnostic(verilogTokenRange(document, token), `${profile} top-level design should not contain $display; the testbench should monitor external outputs.`, DiagnosticSeverity.Error, `${profile.toLowerCase()}-display`));
      }
    }
  }

  if (profile === 'P4' || profile === 'P5') {
    validateDisplayFormats(document, cst, profile, diagnostics);
  }

  if (!hasDefaultNettypeNone(document, cst)) {
    const firstLine = lineAt(document, 0).text;
    diagnostics.push(makeDiagnostic(Range.create(0, 0, 0, Math.max(1, firstLine.length)), 'Consider adding `default_nettype none to catch implicit wires early.', DiagnosticSeverity.Information, 'default-nettype-none'));
  }
}

function tokenInsideModule(document: TextDocument, token: VerilogToken, module: VerilogModule): boolean {
  const start = document.offsetAt(module.range.start);
  const end = document.offsetAt(module.range.end);
  return token.start >= start && token.start < end;
}

function checkExpectedPorts(module: VerilogModule, profile: ProjectProfile, diagnostics: Diagnostic[]): void {
  const expected = expectedPorts[profile];
  if (!expected) {
    return;
  }
  const portsByName = new Map(module.ports.map((port) => [port.name, port]));
  for (const [name, width] of Object.entries(expected)) {
    const port = portsByName.get(name);
    if (!port) {
      diagnostics.push(makeDiagnostic(module.selectionRange, `${profile} top module is missing port '${name}'.`, DiagnosticSeverity.Error, `${profile.toLowerCase()}-port`));
      continue;
    }
    if (width && port.width && normalizeWidth(port.width) !== width) {
      diagnostics.push(makeDiagnostic(port.selectionRange, `${profile} port '${name}' is expected to be ${width}, got ${port.width}.`, DiagnosticSeverity.Warning, `${profile.toLowerCase()}-port-width`));
    }
  }
}

function validateDisplayFormats(document: TextDocument, cst: VerilogCstDocument, profile: ProjectProfile, diagnostics: Diagnostic[]): void {
  for (let index = 0; index < cst.codeTokens.length; index++) {
    const token = cst.codeTokens[index];
    if (token.kind !== 'systemIdentifier' || token.value !== '$display') {
      continue;
    }
    const format = firstDisplayFormatString(cst.codeTokens, index);
    if (format !== undefined && !traceFormatLooksOk(format, profile)) {
      diagnostics.push(makeDiagnostic(verilogTokenRange(document, token), `${profile} $display format does not match the expected CPU trace format.`, DiagnosticSeverity.Warning, 'display-format'));
    }
  }
}

function firstDisplayFormatString(tokens: VerilogToken[], displayIndex: number): string | undefined {
  const open = nextTokenValue(tokens, displayIndex + 1, '(');
  if (open < 0) {
    return undefined;
  }
  for (let index = open + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === ')') {
      return undefined;
    }
    if (token.kind === 'string') {
      return token.value.length >= 2 ? token.value.slice(1, -1) : '';
    }
    if (token.value !== ',') {
      return undefined;
    }
  }
  return undefined;
}

function hasDefaultNettypeNone(document: TextDocument, cst: VerilogCstDocument): boolean {
  for (let index = 0; index < cst.codeTokens.length; index++) {
    const token = cst.codeTokens[index];
    if (token.kind !== 'directive' || token.value !== '`default_nettype') {
      continue;
    }
    const next = cst.codeTokens[index + 1];
    if (next && document.positionAt(next.start).line === document.positionAt(token.start).line && next.value === 'none') {
      return true;
    }
  }
  return false;
}

function traceFormatLooksOk(format: string, profile: ProjectProfile): boolean {
  const normalized = removeAsciiWhitespace(format);
  const expected = profile === 'P5'
    ? ['%d@%h:$%d<=%h', '%d@%h:*%h<=%h']
    : ['@%h:$%d<=%h', '@%h:*%h<=%h'];
  return expected.some((pattern) => normalized.includes(pattern));
}

function removeAsciiWhitespace(text: string): string {
  let result = '';
  for (const char of text) {
    if (char !== ' ' && char !== '\t' && char !== '\r' && char !== '\n' && char !== '\f' && char !== '\v') {
      result += char;
    }
  }
  return result;
}

function nextTokenValue(tokens: VerilogToken[], start: number, value: string): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].value === value) {
      return index;
    }
    if (tokens[index].kind !== 'comment') {
      return -1;
    }
  }
  return -1;
}
