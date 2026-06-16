import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { VerilogToken } from './lexer';
import { systemTasks } from './model';
import { tokenRange } from './syntaxParserUtils';

const unaryExpressionOperators = new Set(['+', '-', '!', '~', '&', '|', '^', '~&', '~|', '^~', '~^']);

const binaryExpressionOperators = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '~^',
  '^~',
  '&&',
  '||',
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '>',
  '<=',
  '>=',
  '<<',
  '>>',
  '<<<',
  '>>>',
  '**',
  '+:',
  '-:'
]);

export function validateExpressionSyntax(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[],
  code: string
): void {
  interface DelimitedExpressionFrame {
    open: string;
    sawOperand: boolean;
    allowEmpty: boolean;
  }

  const expression = tokens.filter((token) => token.kind !== 'eof');
  if (expression.length === 0) {
    return;
  }

  let expectingOperand = true;
  const stack: DelimitedExpressionFrame[] = [];
  const markOperand = (): void => {
    if (stack.length) {
      stack[stack.length - 1].sawOperand = true;
    }
  };

  for (let index = 0; index < expression.length; index++) {
    const token = expression[index];
    if (token.value === '(' || token.value === '[' || token.value === '{') {
      const allowEmpty = token.value === '(' && !expectingOperand;
      stack.push({ open: token.value, sawOperand: false, allowEmpty });
      expectingOperand = true;
      continue;
    }
    if (token.value === ')' || token.value === ']' || token.value === '}') {
      const frame = stack.pop();
      if (!frame || expressionClosingDelimiter(frame.open) !== token.value) {
        reportMalformedExpressionToken(document, token, diagnostics, code);
        return;
      }
      if (expectingOperand && !(frame.allowEmpty && !frame.sawOperand)) {
        reportMalformedExpressionToken(document, token, diagnostics, code);
        return;
      }
      expectingOperand = false;
      markOperand();
      continue;
    }
    if (token.value === ',' || token.value === '?' || token.value === ':') {
      if (expectingOperand) {
        reportMalformedExpressionToken(document, token, diagnostics, code);
        return;
      }
      expectingOperand = true;
      continue;
    }
    if (token.value === '.') {
      if (expectingOperand) {
        reportMalformedExpressionToken(document, token, diagnostics, code);
        return;
      }
      expectingOperand = true;
      continue;
    }
    if (isExpressionOperatorValue(token.value)) {
      if (expectingOperand && !unaryExpressionOperators.has(token.value)) {
        reportMalformedExpressionToken(document, token, diagnostics, code);
        return;
      }
      expectingOperand = true;
      continue;
    }
    if (isExpressionOperandToken(token)) {
      if (!expectingOperand) {
        reportMalformedExpressionToken(document, token, diagnostics, code);
        return;
      }
      expectingOperand = false;
      markOperand();
      continue;
    }
    reportMalformedExpressionToken(document, token, diagnostics, code);
    return;
  }

  if (expectingOperand) {
    reportMalformedExpressionToken(document, expression[expression.length - 1], diagnostics, code);
  }
}

export function isExpressionToken(token: VerilogToken): boolean {
  if (token.kind === 'eof') {
    return false;
  }
  if (token.kind === 'systemIdentifier') {
    const name = token.value.startsWith('$') ? token.value.slice(1) : token.value;
    return !systemTasks.has(name);
  }
  return token.kind === 'identifier' || token.kind === 'number' || token.kind === 'string' || token.kind === 'directive';
}

export function isExpressionOperandToken(token: VerilogToken): boolean {
  return token.kind === 'systemIdentifier' || isExpressionToken(token);
}

function isExpressionOperatorValue(value: string): boolean {
  return unaryExpressionOperators.has(value) || binaryExpressionOperators.has(value);
}

function expressionClosingDelimiter(open: string): string | undefined {
  if (open === '(') {
    return ')';
  }
  if (open === '[') {
    return ']';
  }
  if (open === '{') {
    return '}';
  }
  return undefined;
}

function reportMalformedExpressionToken(
  document: TextDocument,
  token: VerilogToken,
  diagnostics: Diagnostic[],
  code: string
): void {
  diagnostics.push(makeDiagnostic(
    tokenRange(document, token),
    `Syntax error: unexpected token '${token.value}' in expression.`,
    DiagnosticSeverity.Error,
    code
  ));
}
