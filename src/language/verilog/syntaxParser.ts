import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { VerilogCstDocument } from './cst';
import { isIdentifierLike, VerilogToken } from './lexer';
import { VerilogModule, verilogKeywords } from './model';
import { splitVerilogModuleItems } from './statementUtils';
import { declarationKeywords } from './syntaxDeclarationKeywords';
import { validateDeclarationLikeStatement } from './syntaxDeclarationValidation';
import {
  isExpressionOperandToken,
  isExpressionToken,
  validateExpressionSyntax
} from './syntaxExpressionValidation';
import { collectModuleHeaderDiagnostics } from './syntaxModuleHeaderValidation';
import {
  findMatchingToken,
  firstTopLevelAssignmentOperator,
  firstTopLevelToken,
  hasTrailingSemicolon,
  isInsideDelimitedControl,
  lastTopLevelToken,
  nextSignificantTokenIndex,
  previousToken,
  skipDelayControl,
  splitTopLevel,
  statementEnd,
  statementStart,
  tokenRange
} from './syntaxParserUtils';

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
    collectModuleHeaderDiagnostics(document, cst, module, diagnostics);
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
      validateDeclarationLikeStatement(document, item, diagnostics, {
        reportMissingSemicolon,
        validateExpressionSyntax,
        isExpressionOperandToken
      });
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
    if (unsupportedConstructs.has(first.value)) {
      continue;
    }
    diagnostics.push(makeDiagnostic(
      tokenRange(document, first),
      `Syntax error: unexpected token '${first.value}' at module scope.`,
      DiagnosticSeverity.Error,
      'syntax-unexpected-token'
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
  if (tokens.slice(1, operator).filter(isExpressionOperandToken).length === 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[operator]),
      'Syntax error: assignment is missing a left-hand side.',
      DiagnosticSeverity.Error,
      'syntax-malformed-assignment'
    ));
  }
  validateExpressionSyntax(document, tokens.slice(1, operator), diagnostics, 'syntax-malformed-assignment');
  if (tokens.slice(operator + 1, limit).filter(isExpressionOperandToken).length === 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[operator]),
      'Syntax error: assignment is missing a right-hand side.',
      DiagnosticSeverity.Error,
      'syntax-malformed-assignment'
    ));
  }
  validateExpressionSyntax(document, tokens.slice(operator + 1, limit), diagnostics, 'syntax-malformed-assignment');
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
  const afterInstanceName = nextSignificantTokenIndex(tokens, instanceIndex + 1);
  if (
    afterInstanceName >= 0 &&
    tokens[afterInstanceName].value !== ';' &&
    tokens[afterInstanceName].value !== '(' &&
    tokens[afterInstanceName].value !== ','
  ) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[afterInstanceName]),
      `Syntax error: unexpected token '${tokens[afterInstanceName].value}' after instance name '${tokens[instanceIndex].value}'.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-instance'
    ));
    return;
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
  validatePortConnections(document, tokens.slice(open + 1, close), diagnostics);
}

function validatePortConnections(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  for (const connection of splitTopLevel(tokens, ',')) {
    if (connection[0]?.value === '.') {
      validateNamedConnection(document, connection, diagnostics);
      continue;
    }
    if (connection.length > 0) {
      validateExpressionSyntax(document, connection, diagnostics, 'syntax-malformed-instance');
    }
  }
}

function validateNamedConnection(document: TextDocument, connection: VerilogToken[], diagnostics: Diagnostic[]): void {
  const name = connection[1];
  if (!name || !isIdentifierLike(name.kind)) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, connection[0]),
      'Syntax error: named port connection is missing a port name.',
      DiagnosticSeverity.Error,
      'syntax-malformed-instance'
    ));
    return;
  }
  if (connection[2]?.value !== '(') {
    if (connection.length > 2) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, name),
        `Syntax error: named port connection '.${name.value}' must use parentheses.`,
        DiagnosticSeverity.Error,
        'syntax-malformed-instance'
      ));
    }
    return;
  }

  const close = findMatchingToken(connection, 2, '(', ')');
  if (close < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, connection[2]),
      `Syntax error: named port connection '.${name.value}' is missing a closing parenthesis.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-instance'
    ));
    return;
  }
  if (close !== connection.length - 1) {
    const extra = connection[close + 1];
    diagnostics.push(makeDiagnostic(
      tokenRange(document, extra),
      `Syntax error: unexpected token '${extra.value}' after named port connection '.${name.value}'. Did you forget a comma?`,
      DiagnosticSeverity.Error,
      'syntax-malformed-instance'
    ));
    return;
  }
  const expression = connection.slice(3, close);
  if (expression.length > 0) {
    validateExpressionSyntax(document, expression, diagnostics, 'syntax-malformed-instance');
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
    const lhsStart = proceduralAssignmentLhsStart(statement, relativeOperator);
    const lhs = statement.slice(lhsStart, relativeOperator);
    const rhs = statement.slice(relativeOperator + 1);
    if (lhs.filter(isExpressionOperandToken).length === 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        'Syntax error: assignment is missing a left-hand side.',
        DiagnosticSeverity.Error,
        'syntax-malformed-assignment'
      ));
    } else {
      validateExpressionSyntax(document, lhs, diagnostics, 'syntax-malformed-assignment');
    }
    if (rhs.filter(isExpressionOperandToken).length === 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        'Syntax error: assignment is missing a right-hand side.',
        DiagnosticSeverity.Error,
        'syntax-malformed-assignment'
      ));
    } else {
      validateExpressionSyntax(document, rhs, diagnostics, 'syntax-malformed-assignment');
    }
    if (tokens[end]?.value !== ';' && tokens[index - 1]?.value !== '<' && tokens[index - 1]?.value !== '>') {
      reportMissingSemicolon(document, statement[0] ?? token, statement, diagnostics);
    }
  }
}

function proceduralAssignmentLhsStart(statement: VerilogToken[], operatorIndex: number): number {
  let start = 0;
  while (start < operatorIndex) {
    const token = statement[start];
    if (token.value === 'if' || token.value === 'while' || token.value === 'repeat' || token.value === 'for') {
      const open = nextSignificantTokenIndex(statement, start + 1);
      if (open < 0 || statement[open].value !== '(') {
        return start;
      }
      const close = findMatchingToken(statement, open, '(', ')');
      if (close < 0 || close >= operatorIndex) {
        return start;
      }
      start = close + 1;
      continue;
    }
    if (token.value === 'forever') {
      start++;
      continue;
    }
    if (token.value === '#') {
      const next = skipDelayControl(statement, start);
      if (next <= start || next > operatorIndex) {
        return start;
      }
      start = next;
      continue;
    }
    break;
  }

  const label = lastTopLevelToken(statement, ':', start, operatorIndex);
  if (label >= 0) {
    start = label + 1;
  }

  while (statement[start]?.value === '#') {
    const next = skipDelayControl(statement, start);
    if (next <= start || next > operatorIndex) {
      break;
    }
    start = next;
  }
  return start;
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
