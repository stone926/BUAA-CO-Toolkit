import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { VerilogToken } from './lexer';
import { declarationKeywords } from './syntaxDeclarationKeywords';
import {
  isExpressionOperandToken,
  isExpressionToken,
  validateExpressionSyntax
} from './syntaxExpressionValidation';
import {
  findMatchingToken,
  firstTopLevelToken,
  isInsideDelimitedControl,
  lastTopLevelToken,
  nextSignificantTokenIndex,
  skipDelayControl,
  statementEnd,
  statementStart,
  tokenRange
} from './syntaxParserUtils';

export interface ProceduralValidationDependencies {
  reportMissingSemicolon: (
    document: TextDocument,
    anchor: VerilogToken,
    statement: VerilogToken[],
    diagnostics: Diagnostic[]
  ) => void;
}

export function validateProceduralBlock(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[],
  dependencies: ProceduralValidationDependencies
): void {
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
  validateProceduralStatements(document, tokens.slice(bodyStart), diagnostics, dependencies);
}

export function validateSubroutine(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[],
  dependencies: ProceduralValidationDependencies
): void {
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
  validateProceduralStatements(document, tokens.slice(Math.max(1, headerTerminator + 1)), diagnostics, dependencies);
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

function validateProceduralStatements(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[],
  dependencies: ProceduralValidationDependencies
): void {
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
  validateProceduralAssignments(document, tokens, diagnostics, dependencies);
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

function validateProceduralAssignments(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[],
  dependencies: ProceduralValidationDependencies
): void {
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
      dependencies.reportMissingSemicolon(document, statement[0] ?? token, statement, diagnostics);
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
