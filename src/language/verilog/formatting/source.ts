// @index formatting-source — 源码词法、不可变片段与物理行索引
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexVerilogWithTrivia, VerilogToken } from '../lexer';
import { directiveLineEnd } from '../directiveBoundaries';
import { preprocessorDirectives } from '../preprocessor';

export interface SourceLine { start: number; end: number; eol: string }
export interface FormatToken extends VerilogToken { line: number; lastLine: number; protected?: boolean; structural?: boolean }
export interface Source {
  text: string;
  tokens: FormatToken[];
  lines: SourceLine[];
  protected: Array<{ start: number; end: number }>;
  eol: string;
}

export function readSource(document: TextDocument): Source {
  const text = document.getText();
  const lines: SourceLine[] = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  let match: RegExpExecArray | null;
  let lf = 0;
  let crlf = 0;
  while ((match = newline.exec(text))) {
    lines.push({ start, end: match.index, eol: match[0] });
    match[0] === '\r\n' ? crlf++ : lf++;
    start = match.index + match[0].length;
  }
  lines.push({ start, end: text.length, eol: '' });
  const scanned = lexVerilogWithTrivia(text);
  const protectedRanges: Source['protected'] = [];
  // 指令正文和词法错误仍是不可解析片段；关闭格式化只禁止编辑，不隐藏结构。
  const opaqueRanges: Source['protected'] = [];
  let off: number | undefined;
  let skipUntil = -1;
  for (const token of scanned.tokens) {
    if (token.start < skipUntil || token.kind === 'eof') continue;
    const line = document.positionAt(token.start).line;
    if (token.kind === 'directive' && preprocessorDirectives.has(token.value.slice(1))) {
      const end = directiveLineEnd(text, token.end, true);
      const after = text[end] === '\n' ? end + 1 : end;
      protectedRanges.push({ start: lines[line].start, end: after });
      opaqueRanges.push({ start: lines[line].start, end: after });
      skipUntil = after;
    }
    if (token.kind !== 'comment' || !token.value.startsWith('//') || text.slice(lines[line].start, token.start).trim()) continue;
    const marker = /^\/\/\s*co-format:\s*(off|on)\s*$/.exec(token.value);
    if (marker?.[1] === 'off' && off === undefined) off = lines[line].start;
    if (marker?.[1] === 'on' && off !== undefined) {
      protectedRanges.push({ start: off, end: token.end });
      off = undefined;
    }
  }
  if (off !== undefined) protectedRanges.push({ start: off, end: text.length });
  for (const diagnostic of scanned.diagnostics) {
    const line = document.positionAt(diagnostic.start).line;
    const range = { start: lines[line].start, end: Math.max(diagnostic.end, lines[line].end) };
    protectedRanges.push(range); opaqueRanges.push(range);
  }
  protectedRanges.sort((a, b) => a.start - b.start);
  const merged: Source['protected'] = [];
  for (const range of protectedRanges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  opaqueRanges.sort((a, b) => a.start - b.start);
  const opaque: Source['protected'] = [];
  for (const range of opaqueRanges) {
    const previous = opaque[opaque.length - 1];
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else opaque.push({ ...range });
  }
  const tokens: FormatToken[] = [];
  let region = 0;
  let opaqueRegion = 0;
  for (const token of scanned.tokens) {
    if (token.kind === 'eof') continue;
    while (region < merged.length && merged[region].end <= token.start) region++;
    while (opaqueRegion < opaque.length && opaque[opaqueRegion].end <= token.start) opaqueRegion++;
    const range = opaque[opaqueRegion];
    if (range && token.start >= range.start && token.start < range.end) {
      const previous = tokens[tokens.length - 1];
      if (previous?.protected && previous.start === range.start) continue;
      tokens.push({ ...token, start: range.start, end: range.end, protected: true,
        line: document.positionAt(range.start).line,
        lastLine: document.positionAt(Math.max(range.start, range.end - 1)).line });
    } else {
      const protectedToken = merged[region] && token.start >= merged[region].start && token.start < merged[region].end;
      tokens.push({ ...token, protected: !!protectedToken, structural: !!protectedToken,
        line: document.positionAt(token.start).line,
        lastLine: document.positionAt(Math.max(token.start, token.end - 1)).line });
    }
  }
  return { text, tokens, lines, protected: merged, eol: crlf > lf ? '\r\n' : '\n' };
}

export function rawToken(source: Source, index: number): string {
  const token = source.tokens[index];
  return source.text.slice(token.start, token.end);
}

export function isCode(token: FormatToken): boolean {
  return !token.protected && token.kind !== 'comment';
}
