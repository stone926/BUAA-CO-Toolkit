// @index syntax-expression-validation — Shared expression recovery and declaration range syntax checks.
import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseVerilogExpressionTokens, VerilogExpressionAst, VerilogMissingTokenAst } from './exprAst';
import { childrenOfVerilogExpression } from './exprAstUtils';
import { VerilogToken } from './lexer';
import { findTopLevelTokenIndexes } from './tokenUtils';

export interface ExpressionSyntaxIssue {
  range: Range;
  message: string;
}

export function expressionSyntaxIssues(
  document: TextDocument,
  tokens: VerilogToken[],
  requiredAnchor?: VerilogToken
): ExpressionSyntaxIssue[] {
  const expression = tokens.filter((token) => token.kind !== 'eof');
  if (expression.length === 0) {
    if (!requiredAnchor) return [];
    const missing: VerilogMissingTokenAst = {
      kind: 'missingToken', expected: 'expression', message: 'Expected an expression.',
      start: requiredAnchor.start, end: requiredAnchor.end
    };
    return [missingTokenIssue(document, missing)];
  }
  const ast = parseVerilogExpressionTokens(expression);
  const issue = ast ? firstExpressionSyntaxIssue(document, ast) : undefined;
  // Function-like and empty macros can change the expression grammar. Their
  // expansion/lifetime diagnostics belong to the preprocessor, not the raw AST.
  if (issue && expression.some((token) => token.kind === 'directive')) return [];
  return issue ? [issue] : [];
}

function firstExpressionSyntaxIssue(document: TextDocument, expression: VerilogExpressionAst): ExpressionSyntaxIssue | undefined {
  const missing = expression.missing?.[0];
  if (missing) {
    return missingTokenIssue(document, missing);
  }
  if (expression.kind === 'errorExpression') {
    return {
      range: Range.create(document.positionAt(expression.start), document.positionAt(expression.end)),
      message: expression.unexpectedToken
        ? `Syntax error: unexpected token '${expression.unexpectedToken}' in expression.`
        : `Syntax error: ${expression.message}`
    };
  }
  for (const child of childrenOfVerilogExpression(expression)) {
    const issue = firstExpressionSyntaxIssue(document, child);
    if (issue) {
      return issue;
    }
  }
  return undefined;
}

function missingTokenIssue(document: TextDocument, missing: VerilogMissingTokenAst): ExpressionSyntaxIssue {
  return {
    range: Range.create(document.positionAt(missing.start), document.positionAt(missing.end)),
    message: `Syntax error: expression is missing '${missing.expected}'.`
  };
}

/** Delays and parameter overrides also allow the Verilog min:typ:max form. */
export function mintypmaxExpressionSyntaxIssues(
  document: TextDocument,
  tokens: VerilogToken[],
  requiredAnchor?: VerilogToken
): ExpressionSyntaxIssue[] {
  let conditionalDepth = 0;
  const separators: number[] = [];
  for (const index of findTopLevelTokenIndexes(tokens, (token) => token.value === '?' || token.value === ':')) {
    if (tokens[index].value === '?') conditionalDepth++;
    else if (conditionalDepth) conditionalDepth--;
    else separators.push(index);
  }
  if (separators.length !== 2) return expressionSyntaxIssues(document, tokens, requiredAnchor);
  const issues: ExpressionSyntaxIssue[] = [];
  let start = 0;
  for (const end of [...separators, tokens.length]) {
    issues.push(...expressionSyntaxIssues(document, tokens.slice(start, end), tokens[end] ?? requiredAnchor));
    start = end + 1;
  }
  return issues;
}

export function declarationRangeSyntaxIssues(
  document: TextDocument,
  tokens: VerilogToken[],
  open: number,
  close: number
): ExpressionSyntaxIssue[] {
  // Parse the bracketed range as a select so ternaries, nested selects and
  // incomplete endpoints use the same expression recovery tree as other syntax.
  const anchor: VerilogToken = { ...tokens[open], kind: 'identifier', value: '__range' };
  const expressionTokens = [anchor, ...tokens.slice(open, close + 1)];
  const expression = parseVerilogExpressionTokens(expressionTokens);
  if (expression?.kind === 'selectExpression' && expression.select.kind !== 'rangeSelect') {
    return [{
      range: Range.create(document.positionAt(tokens[open].start), document.positionAt(tokens[close].end)),
      message: 'Syntax error: a declaration range requires [left:right] endpoints.'
    }];
  }
  const issue = expression ? firstExpressionSyntaxIssue(document, expression) : undefined;
  if (issue && expressionTokens.some((token) => token.kind === 'directive')) return [];
  return issue ? [issue] : [];
}
