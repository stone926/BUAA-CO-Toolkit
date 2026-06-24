import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { buildMipsAst } from './ast';
import type { MipsAstDocument, MipsOperandAst } from './ast';
import { getNumericLikeRanges, isCharLiteral } from './literals';
import { collectMipsOperandReferences } from './operandReferences';
import { findCommentIndex } from './syntax';

export function getMipsWordRange(document: TextDocument, position: Position, ast: MipsAstDocument = buildMipsAst(document)): Range | undefined {
  const line = ast.lines[position.line];
  if (!line || line.kind !== 'statement') {
    return undefined;
  }
  if (line.comment && containsWordPosition(line.comment.range, position)) {
    return undefined;
  }
  for (const label of line.labels) {
    if (containsWordPosition(label.range, position)) {
      return label.range;
    }
  }
  const executable = line.executable;
  if (!executable) {
    return undefined;
  }
  if (containsWordPosition(executable.mnemonicRange, position)) {
    return executable.mnemonicRange;
  }
  for (const operand of executable.operands) {
    const range = wordRangeInOperand(operand, position);
    if (range) {
      return range;
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

function wordRangeInOperand(operand: MipsOperandAst, position: Position): Range | undefined {
  if (!containsWordPosition(operand.range, position)) {
    return undefined;
  }
  if (operand.kind === 'memory') {
    return wordRangeInOperand(operand.offset, position) ?? wordRangeInOperand(operand.base, position);
  }
  if (operand.kind === 'expression') {
    return wordRangeInExpressionOperand(operand, position);
  }
  if (operand.kind === 'string') {
    return undefined;
  }
  return containsWordPosition(operand.range, position) ? operand.range : undefined;
}

function wordRangeInExpressionOperand(operand: MipsOperandAst, position: Position): Range | undefined {
  for (const reference of collectMipsOperandReferences(operand, { includeRegisters: true })) {
    if (containsWordPosition(reference.range, position)) {
      return reference.range;
    }
  }

  const quotedRanges = quotedLiteralRanges(operand.text, '"');
  const charLiteralRanges = quotedLiteralRanges(operand.text, '\'');
  for (const charRange of charLiteralRanges) {
    const text = operand.text.slice(charRange.start, charRange.end);
    if (isCharLiteral(text) && containsRelativeRange(operand.range, charRange, position)) {
      return relativeRange(operand.range, charRange);
    }
  }

  const ignoredRanges = [...quotedRanges, ...charLiteralRanges];
  for (const numericRange of getNumericLikeRanges(operand.text)) {
    if (ignoredRanges.some((range) => rangesOverlap(range, numericRange))) {
      continue;
    }
    if (containsRelativeRange(operand.range, numericRange, position)) {
      return relativeRange(operand.range, numericRange);
    }
  }
  return undefined;
}

function containsWordPosition(range: Range, position: Position): boolean {
  return range.start.line === position.line
    && range.end.line === position.line
    && range.start.character < range.end.character
    && position.character >= range.start.character
    && position.character <= range.end.character;
}

function containsRelativeRange(base: Range, span: { start: number; end: number }, position: Position): boolean {
  return containsWordPosition(relativeRange(base, span), position);
}

function relativeRange(base: Range, span: { start: number; end: number }): Range {
  return Range.create(
    base.start.line,
    base.start.character + span.start,
    base.start.line,
    base.start.character + span.end
  );
}

function quotedLiteralRanges(text: string, quote: '"' | '\''): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start: number | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start === undefined) {
      if (char === quote) {
        start = index;
        escaped = false;
      }
      continue;
    }
    if (char === quote && !escaped) {
      ranges.push({ start, end: index + 1 });
      start = undefined;
      escaped = false;
      continue;
    }
    escaped = char === '\\' && !escaped;
    if (char !== '\\') {
      escaped = false;
    }
  }
  if (start !== undefined) {
    ranges.push({ start, end: text.length });
  }
  return ranges;
}

function rangesOverlap(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start < right.end && right.start < left.end;
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
