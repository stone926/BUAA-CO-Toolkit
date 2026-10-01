// @index formatting-edits — 全文与选区共用的精确空白编辑契约
import { FormattingOptions, Range, TextEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Source } from './source';
import { Layout } from './layout';

export interface WorkRange { start: number; end: number }
export function workRange(document: TextDocument, source: Source, range?: Range): WorkRange | undefined {
  if (!range) return { start: 0, end: source.text.length };
  const start = document.offsetAt(range.start); const end = document.offsetAt(range.end);
  if (start >= end) return undefined;
  const first = document.positionAt(start).line;
  const lastPosition = document.positionAt(end);
  const last = lastPosition.character === 0 ? lastPosition.line - 1 : lastPosition.line;
  if (last < first) return undefined;
  const line = source.lines[last];
  return { start: source.lines[first].start, end: line.end + line.eol.length };
}
export function finishWhitespace(source: Source, layout: Layout, options: FormattingOptions, full: boolean): void {
  const last = source.tokens[source.tokens.length - 1];
  if (last?.protected) return;
  let gap = layout.gaps[layout.gaps.length - 1];
  const escaped = last?.kind === 'identifier' && last.value.startsWith('\\');
  if (options.trimTrailingWhitespace !== false && !escaped) gap = gap.replace(/[ \t]+(?=\r?\n|\r|$)/g, '');
  if (full && options.trimFinalNewlines) {
    const newline = /\r\n|\r|\n/.exec(gap)?.[0];
    gap = newline ?? gap;
    if (last?.kind === 'comment' && /[\r\n]$/.test(source.text.slice(last.start, last.end))) gap = '';
  }
  if (full && options.insertFinalNewline && !/[\r\n]$/.test(gap || (last ? source.text.slice(last.start, last.end) : ''))) gap += source.lines[last?.line ?? 0].eol || source.eol;
  if (escaped && !gap) gap = layout.gaps[layout.gaps.length - 1];
  layout.gaps[layout.gaps.length - 1] = gap;
}
export function whitespaceEdits(document: TextDocument, source: Source, layout: Layout, work: WorkRange): TextEdit[] {
  const edits: TextEdit[] = [];
  let protectedIndex = 0;
  for (let i = 0; i < layout.gaps.length; i++) {
    let start = source.tokens[i - 1]?.end ?? 0;
    let end = source.tokens[i]?.start ?? source.text.length;
    if (end < work.start || start > work.end || start === work.end && work.end < source.text.length) continue;
    let replacement = layout.gaps[i];
    // 工作范围以完整物理行为边界：按换行序号裁剪布局，范围外的间隙不参与编辑。
    // 布局可能压缩空白行，因此不能用原始字符偏移直接截取 replacement。
    if (start < work.start || end >= work.end && work.end < source.text.length) {
      const breaks = [...replacement.matchAll(/\r\n|\n|\r/g)];
      const before = start < work.start ? (source.text.slice(start, work.start).match(/\r\n|\n|\r/g) ?? []).length : 0;
      const after = end >= work.end && work.end < source.text.length ? (source.text.slice(work.end, end).match(/\r\n|\n|\r/g) ?? []).length : 0;
      const leftBreak = breaks[Math.min(before, breaks.length) - 1];
      const from = leftBreak ? leftBreak.index! + leftBreak[0].length : 0;
      // 右侧范围外的空白行不能消耗当前代码行必需的行尾。
      const needsLineEnd = start >= work.start && start > source.lines[document.positionAt(start).line].start;
      const rightBreak = breaks[Math.max(needsLineEnd ? 0 : -1, breaks.length - after - 1)];
      const to = end >= work.end && work.end < source.text.length
        ? rightBreak ? rightBreak.index! + rightBreak[0].length : 0
        : replacement.length;
      replacement = replacement.slice(from, Math.max(from, to));
      start = Math.max(start, work.start);
      end = Math.min(end, work.end);
    }
    const original = source.text.slice(start, end);
    if (original === replacement) continue;
    if (/\S/.test(original) || /\S/.test(replacement)) continue;
    let prefix = 0;
    while (prefix < original.length && prefix < replacement.length && original[prefix] === replacement[prefix]) prefix++;
    let suffix = 0;
    while (suffix < original.length - prefix && suffix < replacement.length - prefix && original[original.length - suffix - 1] === replacement[replacement.length - suffix - 1]) suffix++;
    const a = start + prefix; const b = end - suffix;
    if (a < work.start || b > work.end || (a === work.end && work.end < source.text.length)) continue;
    while (protectedIndex < source.protected.length && source.protected[protectedIndex].end <= a) protectedIndex++;
    const protectedRange = source.protected[protectedIndex];
    if (protectedRange && (a < protectedRange.end && b > protectedRange.start || a === b && a >= protectedRange.start && a < protectedRange.end)) continue;
    edits.push(TextEdit.replace(Range.create(document.positionAt(a), document.positionAt(b)), replacement.slice(prefix, replacement.length - suffix)));
  }
  return edits;
}
