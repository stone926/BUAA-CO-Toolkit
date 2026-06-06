import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

export interface TextLine {
  text: string;
  range: Range;
}

export function lineAt(document: TextDocument, line: number): TextLine {
  const text = document.getText(Range.create(line, 0, line + 1, 0)).replace(/\r?\n$/, '');
  return {
    text,
    range: Range.create(line, 0, line, text.length)
  };
}

export function rangeAtOffset(document: TextDocument, offset: number, length: number): Range {
  return Range.create(document.positionAt(offset), document.positionAt(offset + length));
}

export function rangeOfText(document: TextDocument, lineNumber: number, text: string): Range {
  const line = lineAt(document, lineNumber).text;
  const start = Math.max(0, line.indexOf(text));
  return Range.create(lineNumber, start, lineNumber, start + text.length);
}

export function containsPosition(range: Range, position: Position): boolean {
  const afterStart = position.line > range.start.line || (position.line === range.start.line && position.character >= range.start.character);
  const beforeEnd = position.line < range.end.line || (position.line === range.end.line && position.character <= range.end.character);
  return afterStart && beforeEnd;
}

export function rangesEqual(left: Range, right: Range): boolean {
  return left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character;
}

export function makeDiagnostic(range: Range, message: string, severity: DiagnosticSeverity, code: string): Diagnostic {
  return {
    range,
    message,
    severity,
    source: '北航 CO',
    code
  };
}

