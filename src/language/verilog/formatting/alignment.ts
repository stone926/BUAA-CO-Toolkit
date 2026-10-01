// @index formatting-alignment — 参数、模块端口、三元链的安全分组对齐
import { Source, isCode } from './source';
import { Structure, Style } from './structure';
import { Layout, placedLines, PlacedLine } from './layout';

const directions = new Set(['input', 'output', 'inout']);
const qualifiers = new Set(['wire', 'reg', 'signed', 'unsigned', 'tri', 'tri0', 'tri1', 'supply0', 'supply1']);
function codeLine(source: Source, line: PlacedLine): number[] {
  if (line.tokens.some(i => source.tokens[i].protected)) return [];
  return line.tokens.filter(i => isCode(source.tokens[i]));
}
function pad(layout: Layout, index: number, amount: number): void {
  if (amount > 0) layout.gaps[index] += ' '.repeat(amount);
}
export function alignLayout(source: Source, structure: Structure, style: Style, layout: Layout): void {
  if (style.parameterAlignment === 'equals') alignParameters(source, structure, layout);
  if (style.modulePortAlignment === 'name' && style.declarationRangeSpacing === 'space') alignPorts(source, structure, layout);
  if (style.ternaryAlignment === 'question') alignTernary(source, structure, layout);
}
function alignParameters(source: Source, structure: Structure, layout: Layout): void {
  const lines = placedLines(source, layout);
  let group: Array<{ index: number; column: number }> = [];
  let active = false;
  const flush = (): void => {
    let width = 0; for (const item of group) width = Math.max(width, item.column);
    if (group.length > 1) for (const item of group) pad(layout, item.index, width - item.column);
    group = []; active = false;
  };
  for (const line of lines) {
    const code = codeLine(source, line); const first = source.tokens[code[0]]?.value;
    if (first === 'parameter' || first === 'localparam') active = true;
    if (!active) continue;
    if (!code.length || code.some(i => structure.preserve.has(i))) { flush(); continue; }
    const equal = code.find(i => source.tokens[i].value === '=');
    if (equal === undefined) { flush(); continue; }
    group.push({ index: equal, column: line.columns.get(equal)! });
    if (source.tokens[code[code.length - 1]].value === ';') flush();
  }
  flush();
}
function alignPorts(source: Source, structure: Structure, layout: Layout): void {
  const lines = placedLines(source, layout);
  let group: Array<{ range?: number; name: number; prefixEnd: number; rangeWidth: number; indent: number }> = [];
  const flush = (): void => {
    let prefixWidth = 0; let rangeWidth = 0;
    for (const item of group) { prefixWidth = Math.max(prefixWidth, item.prefixEnd - item.indent); rangeWidth = Math.max(rangeWidth, item.rangeWidth); }
    if (group.length > 1) for (const item of group) {
      const prefixPadding = prefixWidth - (item.prefixEnd - item.indent);
      if (item.range !== undefined) { pad(layout, item.range, prefixPadding); pad(layout, item.name, rangeWidth - item.rangeWidth); }
      else pad(layout, item.name, prefixPadding + (rangeWidth ? rangeWidth + 1 : 0));
    }
    group = [];
  };
  for (const line of lines) {
    const code = codeLine(source, line); const first = code[0];
    if (first === undefined || !directions.has(source.tokens[first].value) || !structure.modulePort.has(first) || structure.preserve.has(first)) { flush(); continue; }
    let p = 1;
    while (qualifiers.has(source.tokens[code[p]]?.value)) p++;
    const lastPrefix = code[p - 1];
    const prefixEnd = line.columns.get(lastPrefix)! + source.tokens[lastPrefix].value.length;
    let range: number | undefined; let rangeWidth = 0;
    if (source.tokens[code[p]]?.value === '[') {
      range = code[p]; const close = structure.matching.get(range);
      const end = close === undefined ? -1 : code.indexOf(close, p);
      if (end < 0) { flush(); continue; }
      rangeWidth = line.columns.get(close!)! + 1 - line.columns.get(range)!;
      p = end + 1;
    }
    const name = code[p];
    if (source.tokens[name]?.kind !== 'identifier') { flush(); continue; }
    group.push({ range, name, prefixEnd, rangeWidth, indent: line.columns.get(first)! });
  }
  flush();
}
function alignTernary(source: Source, structure: Structure, layout: Layout): void {
  const lines = placedLines(source, layout);
  let group: Array<{ question: number; column: number; last: string }> = [];
  const flush = (fallback?: number): void => {
    if (group.length > 1) {
      let width = 0; for (const item of group) width = Math.max(width, item.column);
      for (const item of group) pad(layout, item.question, width - item.column);
      if (fallback !== undefined && group[group.length - 1].last === ':') {
        const gap = layout.gaps[fallback];
        const prefix = gap.slice(0, Math.max(gap.lastIndexOf('\n'), gap.lastIndexOf('\r')) + 1);
        layout.gaps[fallback] = prefix + ' '.repeat(width + 2);
      }
    }
    group = [];
  };
  for (const line of lines) {
    const code = codeLine(source, line); const first = source.tokens[code[0]]?.value;
    const question = code.find(i => structure.ternaryQuestion.has(i));
    if (question !== undefined && first !== 'assign' && ![')', ']', '}'].includes(first) && !code.some(i => structure.preserve.has(i))) {
      group.push({ question, column: line.columns.get(question)!, last: source.tokens[code[code.length - 1]].value });
      if (source.tokens[code[code.length - 1]].value === ';') flush();
    } else {
      const fallback = code.length && !['module', 'endmodule', 'end', 'endcase', 'assign', 'if', 'else', 'begin'].includes(first) ? code[0] : undefined;
      flush(fallback);
    }
  }
  flush();
}
