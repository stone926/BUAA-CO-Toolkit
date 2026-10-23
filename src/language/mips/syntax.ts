// @index mips-lsp — Tolerant editor syntax adapting canonical core lexer tokens
import { findCommentIndex, tokenizeCode } from '../../mips/core/assembler/syntax';
export { findCommentIndex } from '../../mips/core/assembler/syntax';
import { FormattingOptions, Range } from 'vscode-languageserver/node';
import { parseCharLiteral } from './literals';

export {
  getNumericLikeRanges,
  getStringRanges,
  integerFitsRange,
  isCharLiteral,
  isFloatLiteral,
  isIntegerLiteral,
  isNonNegativeIntegerLiteral,
  isSymbolLike,
  parseCharLiteral,
  parseIntegerLiteral,
  signed32ImmediateValue
} from './literals';

export function stripComment(line: string): string {
  const idx = findCommentIndex(line);
  return idx >= 0 ? line.slice(0, idx) : line;
}

export function parseMacroArguments(text: string): string[] {
  return parseMacroArgumentNodes(text).map((arg) => arg.text);
}

export function parseMacroArgumentNodes(text: string, baseOffset = 0): MipsParsedMacroArgument[] {
  let normalizedStart = leadingWhitespaceLength(text);
  let normalizedEnd = trimRightIndex(text, text.length);
  let normalized = text.slice(normalizedStart, normalizedEnd);
  if (isBalancedOuterParenText(normalized)) {
    const innerStart = normalizedStart + 1;
    const innerEnd = normalizedEnd - 1;
    const innerText = text.slice(innerStart, innerEnd);
    const innerLeading = leadingWhitespaceLength(innerText);
    const innerTrimmedEnd = trimRightIndex(innerText, innerText.length);
    normalizedStart = innerStart + innerLeading;
    normalizedEnd = innerStart + innerTrimmedEnd;
    normalized = text.slice(normalizedStart, normalizedEnd);
  }
  if (!normalized) {
    return [];
  }
  return splitMipsMacroArgumentSpans(normalized)
    .map((arg) => {
      const leading = leadingWhitespaceLength(arg.text);
      const end = trimRightIndex(arg.text, arg.text.length);
      return {
        text: arg.text.slice(leading, end),
        range: {
          start: baseOffset + normalizedStart + arg.start + leading,
          end: baseOffset + normalizedStart + arg.start + end
        }
      };
    })
    .filter((arg) => arg.text.length > 0);
}

export type MipsParsedTokenKind =
  | 'identifier'
  | 'directive'
  | 'register'
  | 'macroParameter'
  | 'number'
  | 'string'
  | 'comment'
  | 'punctuation'
  | 'operator'
  | 'unknown';

export interface MipsParsedToken {
  kind: MipsParsedTokenKind;
  value: string;
  line: number;
  start: number;
  end: number;
}

export interface MipsParsedRange {
  start: number;
  end: number;
}

export interface MipsParsedLabel {
  name: string;
  range: MipsParsedRange;
  colonRange: MipsParsedRange;
}

export interface MipsParsedOperand {
  text: string;
  range: MipsParsedRange;
}

export interface MipsParsedMacroArgument {
  text: string;
  range: MipsParsedRange;
}

export interface MipsParsedExecutable {
  kind: 'directive' | 'instructionOrMacro';
  mnemonic: string;
  lowerMnemonic: string;
  range: MipsParsedRange;
  operandText: string;
  operandRange?: MipsParsedRange;
  operands: MipsParsedOperand[];
}

export interface MipsParsedBaseLine {
  line: number;
  text: string;
  tokens: MipsParsedToken[];
  comment?: MipsParsedToken;
}

export interface MipsParsedBlankLine extends MipsParsedBaseLine {
  kind: 'blank';
}

export interface MipsParsedCommentLine extends MipsParsedBaseLine {
  kind: 'comment';
}

export interface MipsParsedStatementLine extends MipsParsedBaseLine {
  kind: 'statement';
  code: string;
  labels: MipsParsedLabel[];
  executable?: MipsParsedExecutable;
}

export type MipsParsedLine = MipsParsedBlankLine | MipsParsedCommentLine | MipsParsedStatementLine;

export interface MipsParsedDocument {
  kind: 'document';
  lines: MipsParsedLine[];
}

interface TextSpan {
  text: string;
  start: number;
  end: number;
}

export function parseMipsSourceDocument(text: string): MipsParsedDocument {
  return {
    kind: 'document',
    lines: text.split(/\r?\n/).map((line, lineNumber) => parseMipsSourceLine(line, lineNumber))
  };
}

export function parseMipsSourceLine(text: string, lineNumber = 0): MipsParsedLine {
  const commentIndex = findCommentIndex(text);
  const code = commentIndex >= 0 ? text.slice(0, commentIndex) : text;
  const comment = commentIndex >= 0
    ? makeToken('comment', text.slice(commentIndex), lineNumber, commentIndex, text.length)
    : undefined;
  const tokens = tokenizeMipsCode(code, lineNumber);
  if (comment) {
    tokens.push(comment);
  }
  if (!code.trim()) {
    return comment
      ? { kind: 'comment', line: lineNumber, text, tokens, comment }
      : { kind: 'blank', line: lineNumber, text, tokens };
  }

  let position = skipAsciiWhitespace(code, 0);
  const labels: MipsParsedLabel[] = [];
  while (position < code.length) {
    const label = readMipsSymbol(code, position, true);
    if (!label || code[label.end] !== ':') {
      break;
    }
    labels.push({
      name: label.text,
      range: { start: label.start, end: label.end },
      colonRange: { start: label.end, end: label.end + 1 }
    });
    position = skipAsciiWhitespace(code, label.end + 1);
  }

  const mnemonic = readMipsSymbol(code, position, false);
  const executable = mnemonic
    ? makeExecutable(code, lineNumber, mnemonic)
    : undefined;
  return {
    kind: 'statement',
    line: lineNumber,
    text,
    code,
    tokens,
    comment,
    labels,
    executable
  };
}

export function mipsParsedTokenRange(token: MipsParsedToken): Range {
  return Range.create(token.line, token.start, token.line, token.end);
}

export function mipsParsedRange(line: number, range: MipsParsedRange): Range {
  return Range.create(line, range.start, line, range.end);
}

/** The LSP adapts offset tokens from the assembler lexer while retaining incomplete-source diagnostics. */
function tokenizeMipsCode(code: string, lineNumber: number): MipsParsedToken[] {
  return tokenizeCode(code, '', 0).map(token => {
    const kind: MipsParsedTokenKind = token.kind === 'macro-parameter' ? 'macroParameter'
      : token.kind === 'character' ? (parseCharLiteral(token.text) === undefined ? 'unknown' : 'number')
      : token.text === '$' ? 'unknown' : token.kind;
    return makeToken(kind, token.text, lineNumber, token.startOffset, token.endOffset);
  });
}

function makeExecutable(code: string, lineNumber: number, mnemonic: TextSpan): MipsParsedExecutable {
  const operandStart = skipAsciiWhitespace(code, mnemonic.end);
  const operandEnd = trimRightIndex(code, code.length);
  const operandText = operandStart < operandEnd ? code.slice(operandStart, operandEnd) : '';
  return {
    kind: mnemonic.text.startsWith('.') ? 'directive' : 'instructionOrMacro',
    mnemonic: mnemonic.text,
    lowerMnemonic: mnemonic.text.toLowerCase(),
    range: { start: mnemonic.start, end: mnemonic.end },
    operandText,
    operandRange: operandText ? { start: operandStart, end: operandEnd } : undefined,
    operands: operandText ? parseMipsOperandNodes(operandText, operandStart) : []
  };
}

export function parseMipsOperandNodes(text: string, baseOffset: number): MipsParsedOperand[] {
  const leading = leadingWhitespaceLength(text);
  const trailingEnd = trimRightIndex(text, text.length);
  let normalized = text.slice(leading, trailingEnd);
  let normalizedOffset = baseOffset + leading;
  if (normalized.startsWith('(') && normalized.endsWith(')')) {
    normalized = normalized.slice(1, -1).trim();
    normalizedOffset = baseOffset + leading + 1 + leadingWhitespaceLength(text.slice(leading + 1, trailingEnd - 1));
  }
  if (!normalized) {
    return [];
  }
  return splitMipsCommaOperandSpansWithOffsets(normalized).map((operand) => {
    const operandLeading = leadingWhitespaceLength(operand.text);
    const operandEnd = trimRightIndex(operand.text, operand.text.length);
    return {
      text: operand.text.slice(operandLeading, operandEnd),
      range: {
        start: normalizedOffset + operand.start + operandLeading,
        end: normalizedOffset + operand.start + operandEnd
      }
    };
  }).filter((operand) => operand.text.length > 0);
}

function makeToken(kind: MipsParsedTokenKind, value: string, line: number, start: number, end: number): MipsParsedToken {
  return { kind, value, line, start, end };
}

function readMipsSymbol(text: string, start: number, allowMacroParameter: boolean): TextSpan | undefined {
  const char = text[start];
  if (allowMacroParameter && char === '%' && isMipsIdentifierStart(text[start + 1] ?? '')) {
    const end = readMipsIdentifierEnd(text, start + 2);
    return { text: text.slice(start, end), start, end };
  }
  if (char === '$') {
    const end = readRegisterEnd(text, start + 1);
    return end > start + 1 ? { text: text.slice(start, end), start, end } : undefined;
  }
  if (char === '.' && isMipsIdentifierStart(text[start + 1] ?? '')) {
    const end = readMipsIdentifierEnd(text, start + 2);
    return { text: text.slice(start, end), start, end };
  }
  if (!isMipsIdentifierStart(char)) {
    return undefined;
  }
  const end = readMipsIdentifierEnd(text, start + 1);
  return { text: text.slice(start, end), start, end };
}

function readMipsIdentifierEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length && isMipsIdentifierPart(text[index])) {
    index++;
  }
  return index;
}

function readRegisterEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length && isRegisterPart(text[index])) {
    index++;
  }
  return index;
}

function splitMipsCommaOperandSpansWithOffsets(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;
  let paren = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === '"' && !escaped) {
        inString = false;
        escaped = false;
      } else if (char !== '\\') {
        escaped = false;
      } else {
        escaped = !escaped;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }
    if (char === '(') {
      paren++;
      continue;
    }
    if (char === ')') {
      paren = Math.max(0, paren - 1);
      continue;
    }
    if (char === ',' && paren === 0) {
      spans.push({ text: text.slice(start, index), start, end: index });
      start = index + 1;
    }
  }
  spans.push({ text: text.slice(start), start, end: text.length });
  return spans;
}

function splitMipsMacroArgumentSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === '"' && !escaped) {
        inString = false;
        escaped = false;
      } else if (char !== '\\') {
        escaped = false;
      } else {
        escaped = !escaped;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }
    if (char !== ',' && !isAsciiWhitespace(char)) {
      continue;
    }
    const textPart = text.slice(start, index);
    if (textPart.trim()) {
      spans.push({ text: textPart, start, end: index });
    }
    start = index + 1;
  }
  const tail = text.slice(start);
  if (tail.trim()) {
    spans.push({ text: tail, start, end: text.length });
  }
  return spans;
}

function isBalancedOuterParenText(text: string): boolean {
  if (!text.startsWith('(') || !text.endsWith(')')) {
    return false;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === '"' && !escaped) {
        inString = false;
        escaped = false;
      } else if (char !== '\\') {
        escaped = false;
      } else {
        escaped = !escaped;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0 && index !== text.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

function skipAsciiWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && isAsciiWhitespace(text[index])) {
    index++;
  }
  return index;
}

function leadingWhitespaceLength(text: string): number {
  return skipAsciiWhitespace(text, 0);
}

function trimRightIndex(text: string, end: number): number {
  let index = end;
  while (index > 0 && isAsciiWhitespace(text[index - 1])) {
    index--;
  }
  return index;
}

function isMipsIdentifierStart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_' || char === '$';
}

function isMipsIdentifierPart(char: string): boolean {
  return isMipsIdentifierStart(char) || isAsciiDigit(char) || char === '.';
}

function isRegisterPart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || isAsciiDigit(char) || char === '_';
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isAsciiWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f' || char === '\v';
}

export interface MipsFormatDocument {
  kind: 'document';
  lines: MipsFormatLine[];
}

export type MipsFormatLine =
  | MipsBlankLine
  | MipsCommentLine
  | MipsStatementLine;

export interface MipsBlankLine {
  kind: 'blank';
  trailingWhitespace?: string;
}

export interface MipsCommentLine {
  kind: 'comment';
  comment: string;
  trailingWhitespace?: string;
}

export interface MipsStatementLine {
  kind: 'statement';
  labels: string[];
  executable?: MipsExecutableNode;
  comment?: string;
  /** Keep incomplete or unsupported source intact instead of printing a partial AST. */
  raw?: string;
  trailingWhitespace?: string;
}

export interface MipsExecutableNode {
  kind: 'directive' | 'instruction';
  mnemonic: string;
  operandText: string;
  operands: string[];
}

export function parseMipsFormatDocument(text: string): MipsFormatDocument {
  return {
    kind: 'document',
    lines: text.split(/\r\n|\r|\n/).map(parseMipsFormatLine)
  };
}

export function printMipsFormatDocument(ast: MipsFormatDocument, eol = '\n', options?: FormattingOptions): string {
  let macroDepth = 0;
  return ast.lines.map((line) => {
    if (isMipsDirective(line, '.end_macro')) {
      macroDepth = Math.max(0, macroDepth - 1);
    }
    const formatted = printMipsFormatLineWithContext(line, macroDepth > 0, options);
    if (isMipsDirective(line, '.macro')) {
      macroDepth++;
    }
    return formatted;
  }).join(eol);
}

export function parseMipsFormatLine(line: string): MipsFormatLine {
  const parsed = parseMipsSourceLine(line, 0);
  const trailingWhitespace = line.match(/[\t ]+$/)?.[0];
  if (parsed.kind === 'blank') {
    return { kind: 'blank', trailingWhitespace };
  }
  if (parsed.kind === 'comment') {
    return { kind: 'comment', comment: normalizeMipsComment(parsed.comment?.value ?? ''), trailingWhitespace };
  }
  return {
    kind: 'statement',
    labels: parsed.labels.map((label) => label.name),
    raw: hasUnprintedSource(parsed) ? line : undefined,
    trailingWhitespace,
    executable: parsed.executable
      ? {
        kind: parsed.executable.kind === 'directive' ? 'directive' : 'instruction',
        mnemonic: parsed.executable.mnemonic,
        operandText: normalizeMipsOperandText(parsed.executable.operandText),
        operands: parsed.executable.operands.map((operand) => operand.text)
      }
      : undefined,
    comment: parsed.comment ? normalizeMipsComment(parsed.comment.value) : undefined
  };
}

function hasUnprintedSource(line: MipsParsedStatementLine): boolean {
  // The tolerant symbol parser and the assembler lexer must agree on every
  // boundary the printer can replace with whitespace. Otherwise formatting
  // could split a single token (for example `$name.sub:`) into new tokens.
  const boundaries = line.labels.flatMap((label) => [label.range.start, label.range.end, label.colonRange.start, label.colonRange.end]);
  if (line.executable) boundaries.push(line.executable.range.start, line.executable.range.end);
  let boundaryIndex = 0;
  for (const token of line.tokens) {
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex] <= token.start) boundaryIndex++;
    if (boundaryIndex < boundaries.length && boundaries[boundaryIndex] < token.end) return true;
  }
  if (!line.executable) {
    const lastLabel = line.labels[line.labels.length - 1];
    if (line.code.slice(lastLabel?.colonRange.end ?? 0).trim()) return true;
  }
  // An open quote consumes the rest of the line, including its trailing spaces.
  // Preserve that editor buffer until the literal is complete.
  return line.tokens.some((token) => {
    const quote = token.value[0];
    if (token.kind === 'comment' || (quote !== '"' && quote !== "'")) return false;
    if (token.value.length < 2 || !token.value.endsWith(quote)) return true;
    let backslashes = 0;
    for (let index = token.value.length - 2; index >= 0 && token.value[index] === '\\'; index--) backslashes++;
    return backslashes % 2 !== 0;
  });
}

export function printMipsFormatLine(line: MipsFormatLine): string {
  return printMipsFormatLineWithContext(line, false);
}

function printMipsFormatLineWithContext(line: MipsFormatLine, indentDirectives: boolean, options?: FormattingOptions): string {
  const trailing = options?.trimTrailingWhitespace === false ? line.trailingWhitespace ?? '' : '';
  if (line.kind === 'blank') {
    return trailing;
  }
  if (line.kind === 'comment') {
    return line.comment + trailing;
  }
  if (line.raw !== undefined) return line.raw;
  const tabSize = options && Number.isFinite(options.tabSize)
    ? Math.max(1, Math.min(16, Math.floor(options.tabSize)))
    : 4;
  const indent = options?.insertSpaces === false ? '\t' : ' '.repeat(tabSize);
  const formattedCode = printMipsStatement(line, indentDirectives, indent);
  if (!line.comment) {
    return formattedCode + trailing;
  }
  let column = 0;
  for (const char of formattedCode) column = char === '\t' ? column + tabSize - column % tabSize : column + 1;
  return `${formattedCode}${' '.repeat(Math.max(1, 32 - column))}${line.comment}${trailing}`;
}

export function formatMipsLine(line: string): string {
  return printMipsFormatLine(parseMipsFormatLine(line));
}

function printMipsStatement(line: MipsStatementLine, indentDirectives: boolean, indent: string): string {
  const labels = line.labels.map((label) => `${label}:`).join(' ');
  const executable = line.executable ? printMipsExecutable(line.executable) : '';
  if (labels && executable) {
    return `${labels} ${executable}`;
  }
  if (labels) {
    return labels;
  }
  if (!line.executable) {
    return '';
  }
  return line.executable.kind === 'directive' && !indentDirectives
    ? executable
    : `${indent}${executable}`;
}

function printMipsExecutable(executable: MipsExecutableNode): string {
  if (!executable.operandText) {
    return executable.mnemonic;
  }
  if (executable.kind === 'instruction' && executable.operandText.startsWith('(')) {
    return `${executable.mnemonic}${executable.operandText}`;
  }
  return executable.operandText
    ? `${executable.mnemonic} ${executable.operandText}`
    : executable.mnemonic;
}

function normalizeMipsComment(comment: string): string {
  const trimmed = comment.trimEnd();
  if (!trimmed.startsWith('#')) {
    return trimmed;
  }
  const body = trimmed.slice(1).trimStart();
  return body ? `# ${body}` : '#';
}

function normalizeMipsOperandText(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  // The assembler lexer already distinguishes punctuation from both string
  // and character literals, including escaped quotes and macro arguments.
  for (const token of tokenizeCode(text, '', 0)) {
    if (token.kind !== 'punctuation' || token.text !== ',') continue;
    parts.push(text.slice(cursor, token.startOffset).trimEnd(), ',');
    cursor = skipAsciiWhitespace(text, token.endOffset);
    if (cursor < text.length) parts.push(' ');
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function isMipsDirective(line: MipsFormatLine, directive: string): boolean {
  return line.kind === 'statement'
    && line.executable?.kind === 'directive'
    && line.executable.mnemonic.toLowerCase() === directive;
}

export function isInsideAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}
