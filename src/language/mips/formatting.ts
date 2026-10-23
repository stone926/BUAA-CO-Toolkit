import { FormattingOptions, Range, TextEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  parseMipsFormatDocument,
  printMipsFormatDocument
} from './syntax';

export function getMipsFormattingEdits(document: TextDocument, options?: FormattingOptions): TextEdit[] {
  const text = document.getText();
  const eol = /\r\n|\r|\n/.exec(text)?.[0] ?? '\n';
  let formatted = printMipsFormatDocument(parseMipsFormatDocument(text), eol, options);
  if (options?.trimFinalNewlines) {
    formatted = formatted.replace(/(?:\r\n|\r|\n)+$/, eol);
  }
  if (options?.insertFinalNewline && formatted && !/[\r\n]$/.test(formatted)) {
    formatted += eol;
  }
  if (formatted === text) {
    return [];
  }
  return [TextEdit.replace(Range.create({ line: 0, character: 0 }, document.positionAt(text.length)), formatted)];
}
