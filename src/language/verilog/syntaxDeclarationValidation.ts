import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { VerilogToken } from './lexer';
import {
  declarationModifiers,
  declarationPrefixKeywords,
  firstIdentifierIndex,
  isAllowedDeclarationType
} from './syntaxDeclarationKeywords';
import {
  findMatchingToken,
  hasTrailingSemicolon,
  splitTopLevel,
  tokenRange,
  trimTrailingSemicolon
} from './syntaxParserUtils';

export interface DeclarationValidationDependencies {
  reportMissingSemicolon: (
    document: TextDocument,
    anchor: VerilogToken,
    statement: VerilogToken[],
    diagnostics: Diagnostic[]
  ) => void;
  validateExpressionSyntax: (
    document: TextDocument,
    tokens: VerilogToken[],
    diagnostics: Diagnostic[],
    code: string
  ) => void;
  isExpressionOperandToken: (token: VerilogToken) => boolean;
}

export function validateDeclarationLikeStatement(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[],
  dependencies: DeclarationValidationDependencies
): void {
  if (!hasTrailingSemicolon(tokens)) {
    dependencies.reportMissingSemicolon(document, tokens[0], tokens, diagnostics);
  }
  const statement = trimTrailingSemicolon(tokens);
  const declaratorStart = declarationDeclaratorStart(document, statement, diagnostics);
  if (declaratorStart < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[0]),
      `Syntax error: '${tokens[0].value}' declaration is missing an identifier.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-declaration'
    ));
    return;
  }
  for (const declarator of splitTopLevel(statement.slice(declaratorStart), ',')) {
    validateDeclarationDeclarator(document, declarator, diagnostics, dependencies);
  }
}

function declarationDeclaratorStart(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[]
): number {
  let index = 1;
  let sawType = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.value === '[') {
      const close = findMatchingToken(tokens, index, '[', ']');
      if (close < 0) {
        return -1;
      }
      index = close + 1;
      continue;
    }
    if (declarationModifiers.has(token.value)) {
      index++;
      continue;
    }
    if (!sawType && isAllowedDeclarationType(tokens[0].value, token.value)) {
      sawType = true;
      index++;
      continue;
    }
    if (token.kind === 'keyword' && declarationPrefixKeywords.has(token.value)) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        `Syntax error: unexpected declaration keyword '${token.value}' after '${tokens[0].value}'.`,
        DiagnosticSeverity.Error,
        'syntax-malformed-declaration'
      ));
      return firstIdentifierIndex(tokens, index + 1);
    }
    return token.kind === 'identifier' ? index : -1;
  }
  return -1;
}

function validateDeclarationDeclarator(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[],
  dependencies: DeclarationValidationDependencies
): void {
  const name = tokens[0];
  if (!name || name.kind !== 'identifier') {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, name ?? tokens[0]),
      'Syntax error: declaration declarator is missing an identifier.',
      DiagnosticSeverity.Error,
      'syntax-malformed-declaration'
    ));
    return;
  }
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '[') {
      const close = findMatchingToken(tokens, index, '[', ']');
      if (close < 0) {
        return;
      }
      index = close;
      continue;
    }
    if (token.value === '=') {
      const initializer = tokens.slice(index + 1);
      if (initializer.filter(dependencies.isExpressionOperandToken).length === 0) {
        diagnostics.push(makeDiagnostic(
          tokenRange(document, token),
          `Syntax error: declaration '${name.value}' initializer is missing an expression.`,
          DiagnosticSeverity.Error,
          'syntax-malformed-declaration'
        ));
        return;
      }
      dependencies.validateExpressionSyntax(document, initializer, diagnostics, 'syntax-malformed-declaration');
      return;
    }
    diagnostics.push(makeDiagnostic(
      tokenRange(document, token),
      `Syntax error: unexpected token '${token.value}' in declaration '${name.value}'.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-declaration'
    ));
    return;
  }
}
