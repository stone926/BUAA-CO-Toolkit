import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { VerilogCstDocument } from './cst';
import { isIdentifierLike, VerilogToken } from './lexer';
import { systemTasks, VerilogModule, verilogKeywords } from './model';
import { splitVerilogModuleItems } from './statementUtils';

export type VerilogSyntaxNodeKind =
  | 'sourceFile'
  | 'module'
  | 'declaration'
  | 'continuousAssign'
  | 'proceduralBlock'
  | 'blockStatement'
  | 'if'
  | 'case'
  | 'for'
  | 'task'
  | 'instance'
  | 'expression';

export interface VerilogSyntaxNode {
  kind: VerilogSyntaxNodeKind;
  range: Range;
  children: VerilogSyntaxNode[];
}

export interface VerilogSyntaxParseResult {
  root: VerilogSyntaxNode;
  diagnostics: Diagnostic[];
}

const declarationKeywords = new Set([
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

const unsupportedConstructs = new Set([
  'generate',
  'specify',
  'primitive',
  'defparam',
  'fork',
  'event'
]);

export function parseVerilogSyntax(
  document: TextDocument,
  cst: VerilogCstDocument,
  modules: VerilogModule[]
): VerilogSyntaxParseResult {
  const diagnostics: Diagnostic[] = [];
  const root: VerilogSyntaxNode = {
    kind: 'sourceFile',
    range: documentRange(document),
    children: []
  };
  collectNumberLiteralDiagnostics(document, cst.codeTokens, diagnostics);
  collectUnsupportedConstructDiagnostics(document, cst.codeTokens, diagnostics);

  for (const module of modules) {
    const moduleNode: VerilogSyntaxNode = {
      kind: 'module',
      range: module.range,
      children: []
    };
    root.children.push(moduleNode);
    collectModuleItemDiagnostics(document, cst, module, moduleNode, diagnostics);
  }

  collectOrphanControlDiagnostics(document, cst.codeTokens, diagnostics);
  return { root, diagnostics: dedupeDiagnostics(diagnostics) };
}

function collectModuleItemDiagnostics(
  document: TextDocument,
  cst: VerilogCstDocument,
  module: VerilogModule,
  moduleNode: VerilogSyntaxNode,
  diagnostics: Diagnostic[]
): void {
  const bodyStart = document.offsetAt(module.headerEnd);
  const bodyEnd = document.offsetAt(module.endmoduleRange?.start ?? module.range.end);
  const bodyTokens = cst.codeTokens.filter((token) => token.start >= bodyStart && token.start < bodyEnd && token.kind !== 'eof');
  for (const item of splitVerilogModuleItems(bodyTokens)) {
    const first = item[0];
    if (!first) {
      continue;
    }
    if (first.kind === 'directive') {
      continue;
    }
    if (declarationKeywords.has(first.value)) {
      moduleNode.children.push(nodeFromTokens(document, 'declaration', item));
      validateDeclarationLikeStatement(document, item, diagnostics);
      continue;
    }
    if (first.value === 'assign') {
      moduleNode.children.push(nodeFromTokens(document, 'continuousAssign', item));
      validateContinuousAssign(document, item, diagnostics);
      continue;
    }
    if (first.value === 'always' || first.value === 'initial') {
      moduleNode.children.push(nodeFromTokens(document, 'proceduralBlock', item));
      validateProceduralBlock(document, item, diagnostics);
      continue;
    }
    if (first.value === 'task' || first.value === 'function') {
      moduleNode.children.push(nodeFromTokens(document, 'task', item));
      validateSubroutine(document, item, diagnostics);
      continue;
    }
    if (first.value === 'else' || first.value === 'default' || first.value === 'endcase') {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, first),
        `Syntax error: '${first.value}' is not valid at module scope.`,
        DiagnosticSeverity.Error,
        first.value === 'else' ? 'syntax-orphan-else' : `syntax-orphan-${first.value}`
      ));
      continue;
    }
    if (isIdentifierLike(first.kind) && !verilogKeywords.has(first.value)) {
      moduleNode.children.push(nodeFromTokens(document, 'instance', item));
      validateInstanceStatement(document, item, diagnostics);
      continue;
    }
  }
}

function validateDeclarationLikeStatement(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  if (!hasTrailingSemicolon(tokens)) {
    reportMissingSemicolon(document, tokens[0], tokens, diagnostics);
  }
  const declarator = tokens.find((token, index) => index > 0 && token.kind === 'identifier');
  if (!declarator) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[0]),
      `Syntax error: '${tokens[0].value}' declaration is missing an identifier.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-declaration'
    ));
  }
}

function validateContinuousAssign(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  if (!hasTrailingSemicolon(tokens)) {
    reportMissingSemicolon(document, tokens[0], tokens, diagnostics);
  }
  const semicolon = firstTopLevelToken(tokens, ';', 1);
  const limit = semicolon >= 0 ? semicolon : tokens.length;
  const operator = firstTopLevelAssignmentOperator(tokens, 1, limit);
  if (operator < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[0]),
      'Syntax error: continuous assign is missing an assignment operator.',
      DiagnosticSeverity.Error,
      'syntax-malformed-assignment'
    ));
    return;
  }
  if (tokens.slice(1, operator).filter(isExpressionToken).length === 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[operator]),
      'Syntax error: assignment is missing a left-hand side.',
      DiagnosticSeverity.Error,
      'syntax-malformed-assignment'
    ));
  }
  if (tokens.slice(operator + 1, limit).filter(isExpressionToken).length === 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[operator]),
      'Syntax error: assignment is missing a right-hand side.',
      DiagnosticSeverity.Error,
      'syntax-malformed-assignment'
    ));
  }
}

function validateInstanceStatement(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  let instanceIndex = 1;
  if (tokens[instanceIndex]?.value === '#') {
    if (tokens[instanceIndex + 1]?.value !== '(') {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, tokens[instanceIndex]),
        `Syntax error: parameterized instance '${tokens[0].value}' is missing a parameter list.`,
        DiagnosticSeverity.Error,
        'syntax-malformed-instance'
      ));
      return;
    }
    const close = findMatchingToken(tokens, instanceIndex + 1, '(', ')');
    if (close < 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, tokens[instanceIndex + 1]),
        `Syntax error: parameterized instance '${tokens[0].value}' is missing a closing parenthesis.`,
        DiagnosticSeverity.Error,
        'syntax-malformed-instance'
      ));
      return;
    }
    instanceIndex = close + 1;
  }
  if (tokens.length <= instanceIndex || !isIdentifierLike(tokens[instanceIndex].kind)) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[0]),
      `Syntax error: module instance '${tokens[0].value}' is missing an instance name.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-instance'
    ));
    return;
  }
  if (!hasTrailingSemicolon(tokens)) {
    reportMissingSemicolon(document, tokens[0], tokens, diagnostics);
  }
  const open = tokens.findIndex((token, index) => index > instanceIndex && token.value === '(');
  if (open < 0) {
    return;
  }
  const close = findMatchingToken(tokens, open, '(', ')');
  if (close < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[open]),
      'Syntax error: instance port list is missing a closing parenthesis.',
      DiagnosticSeverity.Error,
      'syntax-malformed-instance'
    ));
    return;
  }
  validateNamedConnections(document, tokens.slice(open + 1, close), diagnostics);
}

function validateNamedConnections(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  for (const connection of splitTopLevel(tokens, ',')) {
    if (connection[0]?.value !== '.') {
      continue;
    }
    const name = connection[1];
    if (!name || !isIdentifierLike(name.kind)) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, connection[0]),
        'Syntax error: named port connection is missing a port name.',
        DiagnosticSeverity.Error,
        'syntax-malformed-instance'
      ));
      continue;
    }
    if (connection[2]?.value !== '(' && connection.length > 2) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, name),
        `Syntax error: named port connection '.${name.value}' must use parentheses.`,
        DiagnosticSeverity.Error,
        'syntax-malformed-instance'
      ));
      continue;
    }
    if (connection[2]?.value === '(' && findMatchingToken(connection, 2, '(', ')') < 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, connection[2]),
        `Syntax error: named port connection '.${name.value}' is missing a closing parenthesis.`,
        DiagnosticSeverity.Error,
        'syntax-malformed-instance'
      ));
    }
  }
}

function validateProceduralBlock(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const first = tokens[0];
  let bodyStart = 1;
  if (first.value === 'always' && tokens[1]?.value === '@') {
    bodyStart = validateEventControl(document, tokens, 1, diagnostics);
  } else if (tokens[1]?.value === '#') {
    bodyStart = skipDelayControl(tokens, 1);
  }
  if (bodyStart >= tokens.length) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, first),
      `Syntax error: '${first.value}' block is missing a statement body.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-procedural-block'
    ));
    return;
  }
  validateProceduralStatements(document, tokens.slice(bodyStart), diagnostics);
}

function validateSubroutine(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const first = tokens[0];
  const endKeyword = first.value === 'task' ? 'endtask' : 'endfunction';
  if (!tokens.some((token) => token.value === endKeyword)) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, first),
      `Syntax error: '${first.value}' is missing a matching ${endKeyword}.`,
      DiagnosticSeverity.Error,
      `syntax-unclosed-${first.value}`
    ));
  }
  const headerTerminator = firstTopLevelToken(tokens, ';', 1);
  if (headerTerminator < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, first),
      `Syntax error: '${first.value}' declaration is missing a semicolon after its header.`,
      DiagnosticSeverity.Error,
      'syntax-missing-semicolon'
    ));
  }
  validateProceduralStatements(document, tokens.slice(Math.max(1, headerTerminator + 1)), diagnostics);
}

function validateEventControl(
  document: TextDocument,
  tokens: VerilogToken[],
  atIndex: number,
  diagnostics: Diagnostic[]
): number {
  const at = tokens[atIndex];
  const next = tokens[atIndex + 1];
  if (!next) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, at),
      'Syntax error: event control is missing a sensitivity expression.',
      DiagnosticSeverity.Error,
      'syntax-malformed-event-control'
    ));
    return atIndex + 1;
  }
  if (next.value === '*') {
    return atIndex + 2;
  }
  if (next.value !== '(') {
    return atIndex + 2;
  }
  const close = findMatchingToken(tokens, atIndex + 1, '(', ')');
  if (close < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, next),
      'Syntax error: event control is missing a closing parenthesis.',
      DiagnosticSeverity.Error,
      'syntax-malformed-event-control'
    ));
    return atIndex + 2;
  }
  const rawContent = tokens.slice(atIndex + 2, close);
  const content = rawContent.filter((token) => token.value === '*' || isExpressionToken(token));
  if (content.length === 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, next),
      'Syntax error: event control is empty.',
      DiagnosticSeverity.Error,
      'syntax-malformed-event-control'
    ));
  } else {
    const badTokenIndex = tokens.findIndex((token, index) =>
      index > atIndex + 1 &&
      index < close &&
      (token.value === 'begin' || token.value === 'if' || token.value === 'case' || token.value === 'for' || token.value === ';')
    );
    if (badTokenIndex < 0) {
      return close + 1;
    }
    diagnostics.push(makeDiagnostic(
      tokenRange(document, next),
      'Syntax error: event control reaches into the statement body; a closing parenthesis is probably missing.',
      DiagnosticSeverity.Error,
      'syntax-malformed-event-control'
    ));
    return badTokenIndex;
  }
  return close + 1;
}

function validateProceduralStatements(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  let pendingIf = 0;
  let caseDepth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'eof') {
      break;
    }
    if (token.value === 'if') {
      pendingIf++;
      validateParenthesizedControl(document, tokens, index, 'if', diagnostics);
      continue;
    }
    if (token.value === 'else') {
      if (pendingIf === 0) {
        diagnostics.push(makeDiagnostic(
          tokenRange(document, token),
          "Syntax error: 'else' has no matching if.",
          DiagnosticSeverity.Error,
          'syntax-orphan-else'
        ));
      } else {
        pendingIf--;
      }
      continue;
    }
    if (token.value === 'case' || token.value === 'casex' || token.value === 'casez') {
      caseDepth++;
      validateParenthesizedControl(document, tokens, index, 'case', diagnostics);
      continue;
    }
    if (token.value === 'endcase') {
      caseDepth = Math.max(0, caseDepth - 1);
      continue;
    }
    if (token.value === 'default' && caseDepth === 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        "Syntax error: 'default' appears outside a case statement.",
        DiagnosticSeverity.Error,
        'syntax-orphan-default'
      ));
      continue;
    }
    if (token.value === 'for') {
      validateForStatement(document, tokens, index, diagnostics);
      continue;
    }
  }
  validateProceduralAssignments(document, tokens, diagnostics);
}

function validateParenthesizedControl(
  document: TextDocument,
  tokens: VerilogToken[],
  keywordIndex: number,
  kind: 'if' | 'case',
  diagnostics: Diagnostic[]
): void {
  const open = nextSignificantTokenIndex(tokens, keywordIndex + 1);
  if (open < 0 || tokens[open].value !== '(') {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[keywordIndex]),
      `Syntax error: '${kind}' is missing a parenthesized expression.`,
      DiagnosticSeverity.Error,
      `syntax-malformed-${kind}`
    ));
    return;
  }
  const close = findMatchingToken(tokens, open, '(', ')');
  if (close < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[open]),
      `Syntax error: '${kind}' expression is missing a closing parenthesis.`,
      DiagnosticSeverity.Error,
      `syntax-malformed-${kind}`
    ));
  }
}

function validateForStatement(document: TextDocument, tokens: VerilogToken[], forIndex: number, diagnostics: Diagnostic[]): void {
  const open = nextSignificantTokenIndex(tokens, forIndex + 1);
  if (open < 0 || tokens[open].value !== '(') {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[forIndex]),
      "Syntax error: 'for' is missing a parenthesized control expression.",
      DiagnosticSeverity.Error,
      'syntax-malformed-for'
    ));
    return;
  }
  const close = findMatchingToken(tokens, open, '(', ')');
  if (close < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[open]),
      "Syntax error: 'for' control expression is missing a closing parenthesis.",
      DiagnosticSeverity.Error,
      'syntax-malformed-for'
    ));
    return;
  }
  const semicolons = tokens.slice(open + 1, close).filter((token) => token.value === ';');
  if (semicolons.length !== 2) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[forIndex]),
      "Syntax error: 'for' control expression must contain init, condition, and step sections.",
      DiagnosticSeverity.Error,
      'syntax-malformed-for'
    ));
  }
}

function validateProceduralAssignments(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value !== '=' && token.value !== '<=') {
      continue;
    }
    if (isInsideDelimitedControl(tokens, index)) {
      continue;
    }
    const start = statementStart(tokens, index);
    const end = statementEnd(tokens, index);
    const statement = tokens.slice(start, end);
    if (statement.some((item, itemIndex) => itemIndex === 0 && declarationKeywords.has(item.value))) {
      continue;
    }
    const relativeOperator = index - start;
    if (statement.slice(0, relativeOperator).filter(isExpressionToken).length === 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        'Syntax error: assignment is missing a left-hand side.',
        DiagnosticSeverity.Error,
        'syntax-malformed-assignment'
      ));
    }
    if (statement.slice(relativeOperator + 1).filter(isExpressionToken).length === 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        'Syntax error: assignment is missing a right-hand side.',
        DiagnosticSeverity.Error,
        'syntax-malformed-assignment'
      ));
    }
    if (tokens[end]?.value !== ';' && tokens[index - 1]?.value !== '<' && tokens[index - 1]?.value !== '>') {
      reportMissingSemicolon(document, statement[0] ?? token, statement, diagnostics);
    }
  }
}

function collectNumberLiteralDiagnostics(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  for (const token of tokens) {
    if (token.kind !== 'number') {
      continue;
    }
    const error = numberLiteralError(token.value);
    if (!error) {
      continue;
    }
    diagnostics.push(makeDiagnostic(
      tokenRange(document, token),
      `Syntax error: ${error}`,
      DiagnosticSeverity.Error,
      'syntax-malformed-number'
    ));
  }
}

function collectUnsupportedConstructDiagnostics(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const reported = new Set<string>();
  for (const token of tokens) {
    if (!unsupportedConstructs.has(token.value) || reported.has(token.value)) {
      continue;
    }
    reported.add(token.value);
    diagnostics.push(makeDiagnostic(
      tokenRange(document, token),
      `Verilog construct '${token.value}' is outside the supported CO course subset; ISE may still accept it.`,
      DiagnosticSeverity.Information,
      'syntax-unsupported-construct'
    ));
  }
}

function collectOrphanControlDiagnostics(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  let caseDepth = 0;
  for (const token of tokens) {
    if (token.value === 'case' || token.value === 'casex' || token.value === 'casez') {
      caseDepth++;
    } else if (token.value === 'endcase') {
      caseDepth = Math.max(0, caseDepth - 1);
    } else if (token.value === 'default' && caseDepth === 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        "Syntax error: 'default' appears outside a case statement.",
        DiagnosticSeverity.Error,
        'syntax-orphan-default'
      ));
    }
  }
}

function numberLiteralError(value: string): string | undefined {
  const apostrophe = value.indexOf("'");
  if (apostrophe < 0) {
    return /^[0-9_]+$/.test(value) && /[0-9]/.test(value) ? undefined : `malformed decimal literal '${value}'.`;
  }
  let index = apostrophe + 1;
  if (value[index] === 's' || value[index] === 'S') {
    index++;
  }
  const base = value[index]?.toLowerCase();
  if (base !== 'b' && base !== 'o' && base !== 'd' && base !== 'h') {
    return `based literal '${value}' is missing a valid base.`;
  }
  const digits = value.slice(index + 1).replace(/_/g, '');
  if (!digits) {
    return `based literal '${value}' is missing digits.`;
  }
  const allowed = base === 'b'
    ? /^[01xXzZ?]+$/
    : base === 'o'
      ? /^[0-7xXzZ?]+$/
      : base === 'd'
        ? /^[0-9xXzZ?]+$/
        : /^[0-9a-fA-FxXzZ?]+$/;
  return allowed.test(digits) ? undefined : `literal '${value}' contains digits invalid for base ${base}.`;
}

function hasTrailingSemicolon(tokens: VerilogToken[]): boolean {
  return tokens[tokens.length - 1]?.value === ';';
}

function reportMissingSemicolon(
  document: TextDocument,
  anchor: VerilogToken,
  statement: VerilogToken[],
  diagnostics: Diagnostic[]
): void {
  diagnostics.push(makeDiagnostic(
    tokenRange(document, anchor),
    `Syntax error: '${anchor.value}' statement is missing a terminating semicolon.`,
    DiagnosticSeverity.Error,
    'syntax-missing-semicolon'
  ));
}

function firstTopLevelAssignmentOperator(tokens: VerilogToken[], from: number, to: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = from; index < to; index++) {
    const token = tokens[index];
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    } else if ((token.value === '=' || token.value === '<=') && paren === 0 && bracket === 0 && brace === 0) {
      return index;
    }
  }
  return -1;
}

function firstTopLevelToken(tokens: VerilogToken[], value: string, from: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = from; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    } else if (token.value === value && paren === 0 && bracket === 0 && brace === 0) {
      return index;
    }
  }
  return -1;
}

function splitTopLevel(tokens: VerilogToken[], separator: string): VerilogToken[][] {
  const result: VerilogToken[][] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    } else if (token.value === separator && paren === 0 && bracket === 0 && brace === 0) {
      result.push(tokens.slice(start, index).filter((item) => item.kind !== 'eof'));
      start = index + 1;
    }
  }
  result.push(tokens.slice(start).filter((item) => item.kind !== 'eof'));
  return result.filter((part) => part.length > 0);
}

function skipDelayControl(tokens: VerilogToken[], hashIndex: number): number {
  if (tokens[hashIndex + 1]?.value === '(') {
    const close = findMatchingToken(tokens, hashIndex + 1, '(', ')');
    return close >= 0 ? close + 1 : hashIndex + 2;
  }
  return Math.min(tokens.length, hashIndex + 2);
}

function nextSignificantTokenIndex(tokens: VerilogToken[], start: number): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind !== 'eof') {
      return index;
    }
  }
  return -1;
}

function findMatchingToken(tokens: VerilogToken[], openIndex: number, openValue: string, closeValue: string): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    if (tokens[index].value === openValue) {
      depth++;
    } else if (tokens[index].value === closeValue) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function isInsideDelimitedControl(tokens: VerilogToken[], index: number): boolean {
  let paren = 0;
  for (let cursor = index; cursor >= 0; cursor--) {
    if (tokens[cursor].value === ')') {
      paren++;
    } else if (tokens[cursor].value === '(') {
      if (paren === 0) {
        const previous = previousToken(tokens, cursor);
        return previous?.value === 'if' || previous?.value === 'case' || previous?.value === 'casex' || previous?.value === 'casez' || previous?.value === 'for';
      }
      paren--;
    } else if (tokens[cursor].value === ';' || tokens[cursor].value === 'begin') {
      return false;
    }
  }
  return false;
}

function statementStart(tokens: VerilogToken[], index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (tokens[cursor].value === ';' || tokens[cursor].value === 'begin' || tokens[cursor].value === 'else') {
      return cursor + 1;
    }
  }
  return 0;
}

function statementEnd(tokens: VerilogToken[], index: number): number {
  for (let cursor = index + 1; cursor < tokens.length; cursor++) {
    if (tokens[cursor].value === ';' || tokens[cursor].value === 'end' || tokens[cursor].value === 'else' || tokens[cursor].value === 'endcase') {
      return cursor;
    }
  }
  return tokens.length;
}

function previousToken(tokens: VerilogToken[], index: number): VerilogToken | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (tokens[cursor].kind !== 'eof') {
      return tokens[cursor];
    }
  }
  return undefined;
}

function isExpressionToken(token: VerilogToken): boolean {
  if (token.kind === 'eof') {
    return false;
  }
  if (token.kind === 'systemIdentifier') {
    const name = token.value.startsWith('$') ? token.value.slice(1) : token.value;
    return !systemTasks.has(name);
  }
  return token.kind === 'identifier' || token.kind === 'number' || token.kind === 'string' || token.kind === 'directive';
}

function tokenRange(document: TextDocument, token: VerilogToken): Range {
  return Range.create(document.positionAt(token.start), document.positionAt(token.end));
}

function nodeFromTokens(document: TextDocument, kind: VerilogSyntaxNodeKind, tokens: VerilogToken[]): VerilogSyntaxNode {
  const first = tokens[0];
  const last = tokens[tokens.length - 1] ?? first;
  return {
    kind,
    range: Range.create(document.positionAt(first.start), document.positionAt(last.end)),
    children: []
  };
}

function documentRange(document: TextDocument): Range {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const lastLine = Math.max(0, lines.length - 1);
  return Range.create(0, 0, lastLine, lines[lastLine]?.length ?? 0);
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}
