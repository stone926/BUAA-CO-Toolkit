import { expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { FormattingOptions, TextEdit } from 'vscode-languageserver/node';
import { mergeCoSettings } from '../../language/common/settings';
import { getVerilogFormattingEdits } from '../../language/verilog/formatting';
import { lexVerilogWithTrivia } from '../../language/verilog/lexer';

export const formattingOptions: FormattingOptions = { tabSize: 2, insertSpaces: true };
export const formattingSettings = mergeCoSettings({});
export function formattingDocument(text: string): TextDocument {
  return TextDocument.create('test://中文 空格/format.v', 'verilog', 1, text);
}
export function applyFormattingEdits(document: TextDocument, edits: TextEdit[]): string {
  let previousEnd = 0;
  for (const edit of edits) {
    const start = document.offsetAt(edit.range.start);
    const end = document.offsetAt(edit.range.end);
    expect(document.positionAt(start)).toEqual(edit.range.start);
    expect(document.positionAt(end)).toEqual(edit.range.end);
    expect(start).toBeGreaterThanOrEqual(previousEnd);
    expect(end).toBeGreaterThanOrEqual(start);
    previousEnd = end;
  }
  return TextDocument.applyEdits(document, edits);
}
export function formatVerilog(text: string, options = formattingOptions): string {
  const document = formattingDocument(text);
  return applyFormattingEdits(document, getVerilogFormattingEdits(document, formattingSettings, options));
}
export function tokenBodies(text: string): unknown[] {
  return lexVerilogWithTrivia(text).tokens.filter(token => token.kind !== 'eof').map(token => [token.kind, text.slice(token.start, token.end)]);
}
export function expectStableFormatting(source: string, options = formattingOptions): string {
  const result = formatVerilog(source, options);
  expect(tokenBodies(result)).toEqual(tokenBodies(source));
  const document = formattingDocument(result);
  expect(getVerilogFormattingEdits(document, formattingSettings, options)).toEqual([]);
  expect(formatVerilog(result, options)).toBe(result);
  return result;
}
