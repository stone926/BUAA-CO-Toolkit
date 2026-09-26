// @index procedural-boundary — locate one procedural statement without assuming begin/end
import { VerilogToken } from './lexer';

const moduleBoundaries = new Set(['module', 'endmodule', 'always', 'initial', 'assign', 'function', 'task', 'endgenerate']);

/** Exclusive token end, bounded by the containing module and hard recovery points. */
export function proceduralStatementEnd(tokens: VerilogToken[], start: number, endOffset = Infinity): number {
  const available = (index: number): boolean => Boolean(tokens[index] && tokens[index].kind !== 'eof' && tokens[index].start < endOffset);
  const groupEnd = (start: number, opens: Set<string>, close: string): number => {
    let depth = 0;
    let index = start;
    for (; available(index); index++) {
      const value = tokens[index].value;
      if (moduleBoundaries.has(value)) return index;
      if (opens.has(value)) depth++;
      else if (value === close && --depth === 0) return index + 1;
    }
    return index;
  };
  const parensEnd = (index: number): number => tokens[index]?.value === '('
    ? groupEnd(index, new Set(['(']), ')') : index;
  const statementEnd = (start: number, depth: number): number => {
    if (!available(start) || moduleBoundaries.has(tokens[start].value)) return start;
    const value = tokens[start].value;
    // Limit recovery recursion for partially written/generated input.
    if (depth < 256) {
      if (value === 'begin') return groupEnd(start, new Set(['begin']), 'end');
      if (value === 'case' || value === 'casex' || value === 'casez') return groupEnd(start, new Set(['case', 'casex', 'casez']), 'endcase');
      if (value === 'if') {
        const consequent = statementEnd(parensEnd(start + 1), depth + 1);
        return tokens[consequent]?.value === 'else' ? statementEnd(consequent + 1, depth + 1) : consequent;
      }
      if (value === 'for' || value === 'while' || value === 'repeat' || value === 'wait') {
        return statementEnd(parensEnd(start + 1), depth + 1);
      }
      if (value === 'forever') return statementEnd(start + 1, depth + 1);
      if (value === '#' || value === '@') {
        const next = tokens[start + 1]?.value === '(' ? parensEnd(start + 1) : start + 2;
        return statementEnd(next, depth + 1);
      }
    }
    let nesting = 0;
    let index = start;
    for (; available(index); index++) {
      const value = tokens[index].value;
      if (moduleBoundaries.has(value) || (nesting === 0 && (value === 'end' || value === 'endcase' || value === 'else'))) return index;
      if (value === '(' || value === '[' || value === '{') nesting++;
      else if (value === ')' || value === ']' || value === '}') nesting = Math.max(0, nesting - 1);
      else if (value === ';' && nesting === 0) return index + 1;
    }
    return index;
  };
  return statementEnd(start, 0);
}
