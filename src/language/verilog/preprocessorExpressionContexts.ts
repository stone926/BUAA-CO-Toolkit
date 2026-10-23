// @index preprocessor-expression-contexts — validate required expressions after source-mapped macro expansion
import { parseVerilogExpressionTokens, verilogExpressionHasError } from './exprAst';
import { VerilogToken } from './lexer';
import { findMatchingTokenBackward, findMatchingTokenForward, findTopLevelTokenIndexes } from './tokenUtils';

const controls = new Set(['if', 'case', 'casex', 'casez', 'while', 'repeat']);
const boundaries = new Set([';', 'begin', 'end', 'module', 'endmodule']);

/** Only a complete, known expansion can prove that a required expression is malformed. */
export function macroExpansionBreaksExpression(tokens: VerilogToken[], index: number, replacement: VerilogToken[], invocationEnd: number): boolean {
  const expanded = (start: number, end: number) => [...tokens.slice(start, index), ...replacement, ...tokens.slice(invocationEnd + 1, end)];
  let cursor = index - 1;
  while (cursor >= 0 && !boundaries.has(tokens[cursor].value)) {
    const token = tokens[cursor];
    if ([')', ']', '}'].includes(token.value)) {
      const open = findMatchingTokenBackward(tokens, cursor, token.value === ')' ? '(' : token.value === ']' ? '[' : '{', token.value);
      if (open >= 0) { cursor = open - 1; continue; }
    }
    if (token.value === '[' || token.value === '(') {
      const close = findMatchingTokenForward(tokens, cursor, token.value, token.value === '[' ? ']' : ')');
      if (close >= invocationEnd) {
        const expression = expanded(cursor + 1, close);
        if (token.value === '[') {
          const anchor: VerilogToken = { ...token, kind: 'identifier', value: '__macro_range' };
          if (invalid([anchor, token, ...expression, tokens[close]])) return true;
        } else if (controls.has(tokens[cursor - 1]?.value) && invalid(expression)) return true;
        else if (tokens[cursor - 1]?.value === '#' && invalidDelay(expression)) return true;
      }
    }
    if (['=', '<='].includes(token.value)) {
      const end = expressionEnd(tokens, cursor + 1);
      if (invocationEnd < end && invalid(expanded(cursor + 1, end))) return true;
      break;
    }
    cursor--;
  }
  return false;
}

function invalid(tokens: VerilogToken[]): boolean {
  if (tokens.some((token) => token.kind === 'directive')) return false;
  const ast = parseVerilogExpressionTokens(tokens);
  return !ast || verilogExpressionHasError(ast);
}

function expressionEnd(tokens: VerilogToken[], start: number): number {
  const closing: string[] = [];
  let end = start;
  for (; end < tokens.length; end++) {
    const token = tokens[end];
    if (token.kind === 'eof' || boundaries.has(token.value) || (!closing.length && [',', ')', ']', '}'].includes(token.value))) break;
    if (['(', '[', '{'].includes(token.value)) closing.push(token.value === '(' ? ')' : token.value === '[' ? ']' : '}');
    else if (token.value === closing[closing.length - 1]) closing.pop();
  }
  return end;
}

function invalidDelay(tokens: VerilogToken[]): boolean {
  const separators: number[] = [];
  let conditionalDepth = 0;
  for (const index of findTopLevelTokenIndexes(tokens, (token) => token.value === '?' || token.value === ':')) {
    if (tokens[index].value === '?') conditionalDepth++;
    else if (conditionalDepth) conditionalDepth--;
    else separators.push(index);
  }
  if (separators.length !== 2) return invalid(tokens);
  let start = 0;
  for (const end of [...separators, tokens.length]) {
    if (invalid(tokens.slice(start, end))) return true;
    start = end + 1;
  }
  return false;
}
