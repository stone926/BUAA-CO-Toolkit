import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { findCommentIndex, parseMipsCstLine } from './syntax';

export function getMipsWordRange(document: TextDocument, position: Position): Range | undefined {
  const text = lineAt(document, position.line).text;
  const line = parseMipsCstLine(text, position.line);
  for (const token of line.tokens) {
    if (!isMipsWordToken(token.kind)) {
      continue;
    }
    if (position.character >= token.start && position.character <= token.end) {
      return Range.create(position.line, token.start, position.line, token.end);
    }
  }
  return undefined;
}

export function directiveCompletionReplaceRange(linePrefix: string, position: Position): Range | undefined {
  const start = scanPrefixStart(linePrefix, linePrefix.length, isDirectivePart);
  if (start >= linePrefix.length || linePrefix[start] !== '.') {
    return undefined;
  }
  return Range.create(position.line, position.character - (linePrefix.length - start), position.line, position.character);
}

export function prefixedCompletionReplaceRange(linePrefix: string, position: Position, prefix: string, isPart: (char: string) => boolean): Range | undefined {
  const start = scanPrefixStart(linePrefix, linePrefix.length, (char) => char === prefix || isPart(char));
  if (start >= linePrefix.length || linePrefix[start] !== prefix) {
    return undefined;
  }
  for (let index = start + 1; index < linePrefix.length; index++) {
    if (!isPart(linePrefix[index])) {
      return undefined;
    }
  }
  return Range.create(position.line, position.character - (linePrefix.length - start), position.line, position.character);
}

export function suffixCompletionReplaceRange(linePrefix: string, position: Position, isPart: (char: string, index: number, text: string) => boolean): Range {
  const start = scanPrefixStart(linePrefix, linePrefix.length, isPart);
  return Range.create(position.line, position.character - (linePrefix.length - start), position.line, position.character);
}

export function stripLineComment(line: string): string {
  const commentIndex = findCommentIndex(line);
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

export function isIdentifierPart(char: string): boolean {
  return isAsciiLetter(char) || isAsciiDigit(char) || char === '_' || char === '.';
}

export function isRegisterPart(char: string): boolean {
  return isAsciiLetter(char) || isAsciiDigit(char) || char === '_';
}

export function isMacroParameterPart(char: string): boolean {
  return isAsciiLetter(char) || isAsciiDigit(char) || char === '_';
}

export function isIntegerLiteralPart(char: string, index: number, text: string): boolean {
  if (isAsciiDigit(char) || char === '_') {
    return true;
  }
  if (char === '+' || char === '-') {
    return index === 0 || !isIntegerLiteralPart(text[index - 1] ?? '', index - 1, text);
  }
  if (char === 'x' || char === 'X' || char === 'b' || char === 'B') {
    return true;
  }
  return (char >= 'A' && char <= 'F') || (char >= 'a' && char <= 'f');
}

function isMipsWordToken(kind: string): boolean {
  return kind === 'identifier'
    || kind === 'directive'
    || kind === 'register'
    || kind === 'macroParameter'
    || kind === 'number';
}

function scanPrefixStart(text: string, end: number, isPart: (char: string, index: number, text: string) => boolean): number {
  let start = end;
  while (start > 0 && isPart(text[start - 1], start - 1, text)) {
    start--;
  }
  return start;
}

function isDirectivePart(char: string): boolean {
  return char === '.' || isAsciiLetter(char) || char === '_';
}

function isAsciiLetter(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z');
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}
