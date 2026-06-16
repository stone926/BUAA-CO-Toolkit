import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { isIdentifierLike, VerilogToken } from './lexer';
import { validateExpressionSyntax } from './syntaxExpressionValidation';
import {
  findMatchingToken,
  hasTrailingSemicolon,
  nextSignificantTokenIndex,
  splitTopLevel,
  tokenRange
} from './syntaxParserUtils';

export interface InstanceValidationDependencies {
  reportMissingSemicolon: (
    document: TextDocument,
    anchor: VerilogToken,
    statement: VerilogToken[],
    diagnostics: Diagnostic[]
  ) => void;
}

export function validateInstanceStatement(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[],
  dependencies: InstanceValidationDependencies
): void {
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
    dependencies.reportMissingSemicolon(document, tokens[0], tokens, diagnostics);
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
