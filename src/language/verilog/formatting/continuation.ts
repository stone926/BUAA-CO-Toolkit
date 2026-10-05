// @index formatting-continuation — 赋值右值续行与同一表达式内的三元链对齐
import { Source, isCode } from './source';
import { Structure } from './structure';
import { Layout, placedLines, PlacedLine } from './layout';

interface Expression { operator: number; anchor?: number; tokens: number[] }
const boundaries = new Set([';', ',', 'module', 'endmodule', 'begin', 'end', 'endcase', 'assign', 'always', 'initial', 'else']);

// Only recognize assignment expressions outside parentheses/lists. Ambiguous or
// protected syntax terminates a group instead of aligning unrelated statements.
function expressions(source: Source, structure: Structure): Expression[] {
  const result: Expression[] = [];
  let active: Expression | undefined;
  for (let i = 0; i < source.tokens.length; i++) {
    const token = source.tokens[i]; const value = token.value;
    if (token.protected || structure.preserve.has(i)) { active = undefined; continue; }
    if (!isCode(token)) { active?.tokens.push(i); continue; }
    const depth = structure.delimiterDepth[i];
    if (depth === 0 && boundaries.has(value)) active = undefined;
    if (depth === 0 && !active && (value === '=' || value === '<=')) {
      active = { operator: i, tokens: [] }; result.push(active);
    } else if (active) {
      active.anchor ??= i;
      active.tokens.push(i);
    }
  }
  return result;
}

function setIndent(layout: Layout, token: number, column: number): void {
  const gap = layout.gaps[token];
  const end = Math.max(gap.lastIndexOf('\n'), gap.lastIndexOf('\r')) + 1;
  const width = Math.max(0, column);
  const indent = layout.options.insertSpaces ? ' '.repeat(width)
    : '\t'.repeat(Math.floor(width / layout.tabSize)) + ' '.repeat(width % layout.tabSize);
  layout.gaps[token] = gap.slice(0, end) + indent;
}

function lineIndex(lines: PlacedLine[]): Map<number, number> {
  const result = new Map<number, number>();
  lines.forEach((line, index) => { for (const token of line.tokens) result.set(token, index); });
  return result;
}

function originalColumns(source: Source, tabSize: number): Map<number, number> {
  const columns = new Map<number, number>();
  let line = -1; let offset = 0; let column = 0;
  source.tokens.forEach((token, index) => {
    if (token.line !== line) { line = token.line; offset = source.lines[line].start; column = 0; }
    while (offset < token.start) column += source.text[offset++] === '\t' ? tabSize - column % tabSize : 1;
    columns.set(index, column);
  });
  return columns;
}

export function alignContinuations(source: Source, structure: Structure, layout: Layout, work?: { start: number; end: number }): void {
  const groups = expressions(source, structure);
  const lines = placedLines(source, layout);
  const locations = lineIndex(lines);
  const shifts = new Map<number, number>();
  const padding = new Map<number, number>();
  const original = work ? originalColumns(source, layout.tabSize) : undefined;
  const columnAt = (token: number): number => {
    const entry = source.tokens[token];
    if (work && (entry.start < work.start || entry.start >= work.end)) return original!.get(token)!;
    const row = locations.get(token)!;
    return lines[row].columns.get(token)! + (shifts.get(row) ?? 0) + (padding.get(row) ?? 0);
  };
  const indent = (token: number, column: number): void => {
    setIndent(layout, token, column);
    const row = locations.get(token)!;
    shifts.set(row, column - lines[row].columns.get(token)!);
  };
  // Finish each expression before visiting the next one. A continuation or
  // ternary pad may move a later declarator's RHS on the same physical line.
  for (const group of groups) {
    if (group.anchor === undefined) continue;
    const anchorLine = locations.get(group.anchor)!;
    const anchorColumn = columnAt(group.anchor);
    const inline = locations.get(group.operator) === anchorLine;
    const baseline = inline
      ? (structure.indent[group.anchor] + 1) * layout.tabSize
      : anchorColumn;
    const rows: Array<{ row: number; tokens: number[] }> = [];
    for (const token of group.tokens) {
      const row = locations.get(token)!;
      const previousRow = rows[rows.length - 1];
      if (previousRow?.row === row) { previousRow.tokens.push(token); continue; }
      rows.push({ row, tokens: [token] });
      if (row === anchorLine) continue;
      const line = lines[row]; const first = line.tokens[0];
      // A multiline comment owns its interior whitespace; only move line starts.
      if (first !== token) continue;
      const previous = source.tokens[first - 1];
      if (!/[\r\n]/.test(layout.gaps[first]) && previous && previous.end > source.lines[source.tokens[first].line].start) continue;
      const offset = Math.max(0, line.columns.get(first)! - baseline);
      indent(first, anchorColumn + offset);
    }
    let chain: Array<{ question: number; column: number; last: string }> = [];
    const flush = (fallback?: number): void => {
      if (chain.length > 1) {
        let width = 0; for (const item of chain) width = Math.max(width, item.column);
        for (const item of chain) {
          const amount = width - item.column;
          layout.gaps[item.question] += ' '.repeat(amount);
          const row = locations.get(item.question)!;
          padding.set(row, (padding.get(row) ?? 0) + amount);
        }
        if (fallback !== undefined && chain[chain.length - 1].last === ':') indent(fallback, width + 2);
      }
      chain = [];
    };
    let previousRow = -1;
    for (const { row, tokens } of rows) {
      if (row !== previousRow + 1) flush();
      previousRow = row;
      const code = tokens.filter(i => isCode(source.tokens[i]));
      if (!code.length) continue;
      const questions = code.filter(i => structure.ternaryQuestion.has(i));
      const question = questions.length === 1 && ![')', ']', '}'].includes(source.tokens[code[0]]?.value) ? questions[0] : undefined;
      if (question !== undefined) {
        if (chain.length && chain[chain.length - 1].last !== ':') flush();
        chain.push({ question, column: columnAt(question), last: source.tokens[code[code.length - 1]].value });
      } else flush(code[0] === lines[row].tokens[0] ? code[0] : undefined);
    }
    flush();
  }
}
