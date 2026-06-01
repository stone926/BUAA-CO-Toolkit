import { Range, TextEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  parseMipsFormatDocument,
  printMipsFormatDocument
} from './syntax';

export function getMipsFormattingEdits(document: TextDocument): TextEdit[] {
  const text = document.getText();
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const formatted = printMipsFormatDocument(parseMipsFormatDocument(text), eol);
  if (formatted === text) {
    return [];
  }
  return [TextEdit.replace(Range.create(0, 0, document.lineCount, 0), formatted)];
}
