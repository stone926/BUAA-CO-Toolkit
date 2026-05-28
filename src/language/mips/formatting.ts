import { TextEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { formatMipsLine } from './syntax';

export function getMipsFormattingEdits(document: TextDocument): TextEdit[] {
  const edits: TextEdit[] = [];
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const line = lineAt(document, lineNumber);
    const formatted = formatMipsLine(line.text);
    if (formatted !== line.text) {
      edits.push(TextEdit.replace(line.range, formatted));
    }
  }
  return edits;
}
