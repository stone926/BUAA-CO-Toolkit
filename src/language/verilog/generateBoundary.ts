// @index generate-boundary — Shared boundaries of one module or generate item
import type { VerilogToken } from './lexer';
import { findMatchingTokenForward } from './tokenUtils';
import { proceduralStatementEnd } from './proceduralBoundary';

/** Exclusive end of one module/generate item, including an unbraced nested loop. */
export function generateItemEnd(tokens: VerilogToken[], start: number, endOffset: number, depth = 0): number {
  if (!tokens[start] || tokens[start].start >= endOffset || depth >= 128) return start;
  const value = tokens[start].value;
  if (value === 'begin') {
    const end = findMatchingTokenForward(tokens, start, 'begin', 'end');
    return end < 0 ? start : end + 1;
  }
  if (['case', 'casex', 'casez'].includes(value)) {
    let nesting = 0;
    for (let index = start; tokens[index] && tokens[index].start < endOffset; index++) {
      if (['case', 'casex', 'casez'].includes(tokens[index].value)) nesting++;
      if (tokens[index].value === 'endcase' && --nesting === 0) return index + 1;
    }
    return start;
  }
  if (value === 'for' || value === 'if') {
    const close = findMatchingTokenForward(tokens, start + 1, '(', ')');
    if (close < 0) return start;
    const end = generateItemEnd(tokens, close + 1, endOffset, depth + 1);
    return value === 'if' && tokens[end]?.value === 'else' ? generateItemEnd(tokens, end + 1, endOffset, depth + 1) : end;
  }
  if (value === 'initial' || value === 'always') return proceduralStatementEnd(tokens, start + 1, endOffset);
  if (value === 'function' || value === 'task') {
    const close = findMatchingTokenForward(tokens, start, value, value === 'function' ? 'endfunction' : 'endtask');
    return close < 0 ? start : close + 1;
  }
  let nesting = 0;
  for (let index = start; tokens[index] && tokens[index].start < endOffset; index++) {
    const token = tokens[index];
    if (['(', '[', '{'].includes(token.value)) nesting++;
    if ([')', ']', '}'].includes(token.value)) nesting--;
    if (nesting === 0 && token.value === ';') return index + 1;
    if (nesting === 0 && ['end', 'endcase', 'endgenerate', 'endmodule'].includes(token.value)) return index;
  }
  return start;
}
