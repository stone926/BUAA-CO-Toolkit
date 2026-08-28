// @index mips-core — 严格汇编器行语法：注释/字符串感知 token 与顶层逗号拆分（纯 TS）

import { ExpandedSourceLine } from './sourceGraph';
import { SourceSpan } from './diagnostics';

export type StatementTokenKind =
  | 'identifier'
  | 'directive'
  | 'register'
  | 'macro-parameter'
  | 'number'
  | 'string'
  | 'character'
  | 'punctuation'
  | 'operator'
  | 'unknown';

export interface StatementToken {
  readonly kind: StatementTokenKind;
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface ParsedLabel {
  readonly name: string;
  readonly nameSpan: SourceSpan;
  readonly colonSpan: SourceSpan;
}

export interface ParsedOperand {
  readonly text: string;
  readonly span: SourceSpan;
}

export interface ParsedStatement {
  readonly kind: 'statement';
  readonly sourceId: string;
  readonly line: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
  readonly code: string;
  readonly labels: readonly ParsedLabel[];
  readonly mnemonic?: string;
  readonly mnemonicSpan?: SourceSpan;
  readonly operandText: string;
  readonly operands: readonly ParsedOperand[];
  readonly expansionStack: readonly SourceSpan[];
}

export type ParsedLine =
  | { readonly kind: 'blank' | 'comment'; readonly sourceId: string; readonly line: number; readonly startOffset: number; readonly endOffset: number; readonly text: string }
  | ParsedStatement;

export function parseAssemblerLine(line: ExpandedSourceLine): ParsedLine {
  const commentIndex = findCommentIndex(line.text);
  const code = commentIndex >= 0 ? line.text.slice(0, commentIndex) : line.text;
  if (!code.trim()) {
    return {
      kind: commentIndex >= 0 ? 'comment' : 'blank',
      sourceId: line.sourceId,
      line: line.line,
      startOffset: line.startOffset,
      endOffset: line.endOffset,
      text: line.text
    };
  }

  const tokens = tokenizeCode(code, line.sourceId, line.startOffset);
  let cursor = 0;
  const labels: ParsedLabel[] = [];
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token.kind !== 'identifier') break;
    const colon = tokens[cursor + 1];
    if (!colon || colon.text !== ':') break;
    labels.push({
      name: token.text,
      nameSpan: spanFor(token, line.sourceId),
      colonSpan: spanFor(colon, line.sourceId)
    });
    cursor += 2;
  }
  if (cursor >= tokens.length) {
    return statement(line, code, labels, undefined, '', [], undefined);
  }
  const mnemonic = tokens[cursor];
  if (mnemonic.kind !== 'identifier' && mnemonic.kind !== 'directive'
    && mnemonic.kind !== 'macro-parameter') {
    return statement(line, code, labels, undefined, code.slice(Math.max(0, mnemonic.startOffset - line.startOffset)), [], undefined);
  }
  cursor++;
  const operandLocalStart = cursor < tokens.length
    ? tokens[cursor].startOffset - line.startOffset
    : code.trimEnd().length;
  const operandLocalEnd = code.trimEnd().length;
  const rawOperandText = code.slice(operandLocalStart, operandLocalEnd).trim();
  const operandText = stripOuterMacroParens(rawOperandText);
  const operands = operandText
    ? splitOperandTextRaw(operandText, line.sourceId, line.startOffset + operandLocalStart + (rawOperandText.length - rawOperandText.trimStart().length))
    : [];
  return statement(line, code, labels, mnemonic.text, operandText, operands, {
    sourceId: line.sourceId,
    startOffset: mnemonic.startOffset,
    endOffset: mnemonic.endOffset
  });
}

function statement(
  line: ExpandedSourceLine,
  code: string,
  labels: ParsedLabel[],
  mnemonic: string | undefined,
  operandText: string,
  operands: ParsedOperand[],
  mnemonicSpan: SourceSpan | undefined
): ParsedStatement {
  return {
    kind: 'statement',
    sourceId: line.sourceId,
    line: line.line,
    startOffset: line.startOffset,
    endOffset: line.endOffset,
    text: line.text,
    code,
    labels,
    ...(mnemonic ? { mnemonic, mnemonicSpan } : {}),
    operandText,
    operands,
    expansionStack: line.expansionStack
  };
}

export function tokenizeCode(text: string, sourceId: string, baseOffset: number): StatementToken[] {
  const tokens: StatementToken[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    const start = index;
    if (char === '"') {
      const end = readQuoted(text, index, '"');
      tokens.push({ kind: 'string', text: text.slice(index, end), startOffset: baseOffset + start, endOffset: baseOffset + end });
      index = end;
      continue;
    }
    if (char === "'") {
      const end = readQuoted(text, index, "'");
      tokens.push({ kind: 'character', text: text.slice(index, end), startOffset: baseOffset + start, endOffset: baseOffset + end });
      index = end;
      continue;
    }
    if (char === '%' && isIdentifierStart(text[index + 1] ?? '')) {
      const end = readIdentifier(text, index + 1);
      tokens.push({ kind: 'macro-parameter', text: text.slice(index, end), startOffset: baseOffset + start, endOffset: baseOffset + end });
      index = end;
      continue;
    }
    if (char === '$' && isIdentifierStart(text[index + 1] ?? '')) {
      const end = readIdentifier(text, index + 1);
      tokens.push({ kind: 'register', text: text.slice(index, end), startOffset: baseOffset + start, endOffset: baseOffset + end });
      index = end;
      continue;
    }
    if (char === '.' && isIdentifierStart(text[index + 1] ?? '')) {
      const end = readIdentifier(text, index + 1);
      tokens.push({ kind: 'directive', text: text.slice(index, end), startOffset: baseOffset + start, endOffset: baseOffset + end });
      index = end;
      continue;
    }
    if (isNumberStart(text, index)) {
      const end = readNumber(text, index);
      tokens.push({ kind: 'number', text: text.slice(index, end), startOffset: baseOffset + start, endOffset: baseOffset + end });
      index = end;
      continue;
    }
    if (isIdentifierStart(char)) {
      const end = readIdentifier(text, index + 1);
      tokens.push({ kind: 'identifier', text: text.slice(index, end), startOffset: baseOffset + start, endOffset: baseOffset + end });
      index = end;
      continue;
    }
    if (char === ',' || char === ':' || char === '(' || char === ')') {
      tokens.push({ kind: 'punctuation', text: char, startOffset: baseOffset + start, endOffset: baseOffset + start + 1 });
      index++;
      continue;
    }
    if ('+-*/%&|^~<>'.includes(char)) {
      let end = index + 1;
      if ((char === '<' && text[index + 1] === '<') || (char === '>' && text[index + 1] === '>')) end++;
      tokens.push({ kind: 'operator', text: text.slice(index, end), startOffset: baseOffset + start, endOffset: baseOffset + end });
      index = end;
      continue;
    }
    tokens.push({ kind: 'unknown', text: char, startOffset: baseOffset + start, endOffset: baseOffset + start + 1 });
    index++;
  }
  return tokens;
}

function stripOuterMacroParens(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return text;
  let depth = 0;
  let quoted: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (quoted) {
      if (char === quoted && !escaped) quoted = undefined;
      escaped = char === '\\' && !escaped;
      if (char !== '\\') escaped = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quoted = char;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0 && index !== trimmed.length - 1) return text;
    }
  }
  if (depth !== 0) return text;
  return trimmed.slice(1, -1).trim();
}

function splitOperandTextRaw(text: string, sourceId: string, baseOffset: number): ParsedOperand[] {
  return splitOperandText(text, sourceId, baseOffset);
}

export function splitTopLevelOperands(
  code: string,
  sourceId: string,
  lineStartOffset: number,
  localStartOffset: number,
  localEndOffset: number
): ParsedOperand[] {
  return splitOperandTextRaw(
    code.slice(localStartOffset, localEndOffset),
    sourceId,
    lineStartOffset + localStartOffset
  );
}

function splitOperandText(text: string, sourceId: string, baseOffset: number): ParsedOperand[] {
  const result: ParsedOperand[] = [];
  let depth = 0;
  let quoted: '"' | "'" | undefined;
  let escaped = false;
  let start = 0;
  const trimStart = leadingWhitespaceLength(text);
  start = trimStart;
  const end = trimEndIndex(text, text.length);
  for (let index = start; index < end; index++) {
    const char = text[index];
    if (quoted) {
      if (char === quoted && !escaped) quoted = undefined;
      escaped = char === '\\' && !escaped;
      if (char !== '\\') escaped = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quoted = char;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      result.push(operand(text.slice(start, index), sourceId, baseOffset + start));
      start = index + 1;
    }
  }
  if (start < end) {
    result.push(operand(text.slice(start, end), sourceId, baseOffset + start));
  }
  return result.map((item) => ({
    ...item,
    text: item.text.trim()
  })).filter((item) => item.text.length > 0);
}

function operand(rawText: string, sourceId: string, startOffset: number): ParsedOperand {
  const leading = leadingWhitespaceLength(rawText);
  const trailing = trimEndIndex(rawText, rawText.length);
  return {
    text: rawText.slice(leading, trailing),
    span: {
      sourceId,
      startOffset: startOffset + leading,
      endOffset: startOffset + trailing
    }
  };
}

export function findCommentIndex(line: string): number {
  let quoted: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === quoted && !escaped) quoted = undefined;
      escaped = char === '\\' && !escaped;
      if (char !== '\\') escaped = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quoted = char;
      continue;
    }
    if (char === '#') return index;
  }
  return -1;
}

function readQuoted(text: string, start: number, quote: '"' | "'"): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === quote && !escaped) return index + 1;
    escaped = text[index] === '\\' && !escaped;
    if (text[index] !== '\\') escaped = false;
  }
  return text.length;
}

function spanFor(token: StatementToken, sourceId: string): SourceSpan {
  return { sourceId, startOffset: token.startOffset, endOffset: token.endOffset };
}

function readIdentifier(text: string, start: number): number {
  let index = start;
  while (index < text.length && isIdentifierPart(text[index])) index++;
  return index;
}

function readNumber(text: string, start: number): number {
  let index = start;
  if (text[index] === '-' || text[index] === '+') index++;
  if (text[index] === '0' && index + 1 < text.length
    && (text[index + 1] === 'x' || text[index + 1] === 'X' || text[index + 1] === 'b' || text[index + 1] === 'B')) {
    index += 2;
    while (index < text.length && isWordCharacter(text[index])) index++;
    return index;
  }
  while (index < text.length && (isAsciiDigit(text[index]) || text[index] === '_')) index++;
  return index;
}

function isNumberStart(text: string, index: number): boolean {
  if (isAsciiDigit(text[index])) return true;
  return (text[index] === '-' || text[index] === '+')
    && isAsciiDigit(text[index + 1] ?? '');
}

function isIdentifierStart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')
    || char === '_' || char === '$';
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || (char >= '0' && char <= '9') || char === '.';
}

function isWordCharacter(char: string): boolean {
  return isAsciiDigit(char) || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_';
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function leadingWhitespaceLength(text: string): number {
  let index = 0;
  while (index < text.length && /\s/.test(text[index])) index++;
  return index;
}

function trimEndIndex(text: string, end: number): number {
  let index = end;
  while (index > 0 && /\s/.test(text[index - 1])) index--;
  return index;
}
