// @index formatting-layout — 空白间隙、缩进及局部换行布局
import { FormattingOptions } from 'vscode-languageserver/node';
import { Source } from './source';
import { Structure } from './structure';
import { horizontalSpace } from './spacing';

export interface Layout { gaps: string[]; tabSize: number; options: FormattingOptions }
export function indentation(level: number, options: FormattingOptions): string {
  const bounded = Math.min(512, Math.max(0, Math.floor(level)));
  return (options.insertSpaces ? ' '.repeat(options.tabSize) : '\t').repeat(bounded);
}
export function createLayout(source: Source, structure: Structure, supplied: FormattingOptions): Layout {
  const tabSize = Number.isFinite(supplied.tabSize) ? Math.max(1, Math.min(16, Math.floor(supplied.tabSize))) : 4;
  const options = { ...supplied, tabSize };
  const gaps: string[] = [];
  for (let i = 0; i <= source.tokens.length; i++) {
    const token = source.tokens[i]; const previous = source.tokens[i - 1];
    const start = previous?.end ?? 0; const end = token?.start ?? source.text.length;
    const original = source.text.slice(start, end);
    if (!token || token.protected || structure.preserve.has(i)) { gaps.push(original); continue; }
    const lineStart = source.lines[token.line].start;
    const startsLine = start <= lineStart;
    const prefix = indentation(structure.indent[i], options) + ' '.repeat(structure.extra[i]);
    if (startsLine) {
      const breaks = original.match(/\r\n|\n|\r/g) ?? [];
      let leading = breaks.join('');
      if (options.trimTrailingWhitespace === false) leading = original.slice(0, Math.max(0, lineStart - start));
      gaps.push(leading + prefix);
    } else gaps.push(horizontalSpace(source, structure, i, original));
  }
  return { gaps, tabSize, options };
}

export interface PlacedLine { tokens: number[]; columns: Map<number, number>; width: number }
export function placedLines(source: Source, layout: Layout): PlacedLine[] {
  const lines: PlacedLine[] = [{ tokens: [], columns: new Map(), width: 0 }];
  let current = lines[0];
  const consume = (text: string): void => {
    for (let c = 0; c < text.length; c++) {
      const char = text[c];
      if (char === '\r' || char === '\n') {
        if (char === '\r' && text[c + 1] === '\n') c++;
        current = { tokens: [], columns: new Map(), width: 0 }; lines.push(current);
      } else current.width += char === '\t' ? layout.tabSize - current.width % layout.tabSize : 1;
    }
  };
  for (let i = 0; i < source.tokens.length; i++) {
    consume(layout.gaps[i]);
    current.tokens.push(i); current.columns.set(i, current.width);
    const token = source.tokens[i]; consume(source.text.slice(token.start, token.end));
  }
  return lines;
}
