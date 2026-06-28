import { TextDocument } from 'vscode-languageserver-textdocument';

let nextDocumentVersion = 1;

export function verilogDoc(text: string, uri?: string): TextDocument {
  return languageDoc('verilog', text, uri ?? `test://verilog-${nextDocumentVersion}.v`);
}

export function mipsDoc(text: string, uri?: string): TextDocument {
  return languageDoc('mipsasm', text, uri ?? `test://mips-${nextDocumentVersion}.asm`);
}

export function logisimDoc(text: string, uri?: string): TextDocument {
  return languageDoc('logisim', text, uri ?? `test://logisim-${nextDocumentVersion}.circ`);
}

export function languageDoc(languageId: string, text: string, uri: string): TextDocument {
  return TextDocument.create(uri, languageId, nextDocumentVersion++, text);
}

export function positionOf(document: TextDocument, text: string, offset = 0) {
  const index = document.getText().indexOf(text);
  if (index < 0) {
    throw new Error(`Text not found in document: ${text}`);
  }
  return document.positionAt(index + offset);
}

export function rangeOf(document: TextDocument, text: string, offset = 0, length = text.length) {
  const start = positionOf(document, text, offset);
  const startOffset = document.offsetAt(start);
  return {
    start,
    end: document.positionAt(startOffset + length)
  };
}
