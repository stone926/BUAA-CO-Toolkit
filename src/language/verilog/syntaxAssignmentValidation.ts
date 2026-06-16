import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { VerilogToken } from './lexer';
import {
  isExpressionOperandToken,
  validateExpressionSyntax
} from './syntaxExpressionValidation';
import {
  firstTopLevelAssignmentOperator,
  firstTopLevelToken,
  hasTrailingSemicolon,
  tokenRange
} from './syntaxParserUtils';

export interface AssignmentValidationDependencies {
  reportMissingSemicolon: (
    document: TextDocument,
    anchor: VerilogToken,
    statement: VerilogToken[],
    diagnostics: Diagnostic[]
  ) => void;
}

export function validateContinuousAssign(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[],
  dependencies: AssignmentValidationDependencies
): void {
  if (!hasTrailingSemicolon(tokens)) {
    dependencies.reportMissingSemicolon(document, tokens[0], tokens, diagnostics);
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
