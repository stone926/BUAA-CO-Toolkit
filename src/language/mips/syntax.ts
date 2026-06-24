import { Range } from 'vscode-languageserver/node';
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

export function parseOperands(text: string): string[] {
  if (!text) {
    return [];
  }
  let normalized = text.trim();
  if (normalized.startsWith('(') && normalized.endsWith(')')) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (!normalized) {
    return [];
  }
  return splitMipsCommaOperands(normalized);
}

export function parseMacroArguments(text: string): string[] {
  const normalized = stripBalancedOuterParens(text.trim()).trim();
  if (!normalized) {
    return [];
  }
  return splitMipsMacroArgumentSpans(normalized)
    .map((arg) => arg.text.trim())
    .filter(Boolean);
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

export type CstRange = MipsParsedRange;
export type MipsCstTokenKind = MipsParsedTokenKind;
export type MipsCstToken = MipsParsedToken;
export type MipsCstLabel = MipsParsedLabel;
export type MipsCstOperand = MipsParsedOperand;
export type MipsCstExecutable = MipsParsedExecutable;
export type MipsCstBaseLine = MipsParsedBaseLine;
export type MipsCstBlankLine = MipsParsedBlankLine;
export type MipsCstCommentLine = MipsParsedCommentLine;
export type MipsCstStatementLine = MipsParsedStatementLine;
export type MipsCstLine = MipsParsedLine;
export type MipsCstDocument = MipsParsedDocument;

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

export function parseMipsCstDocument(text: string): MipsCstDocument {
  return parseMipsSourceDocument(text);
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

export function parseMipsCstLine(text: string, lineNumber = 0): MipsCstLine {
  return parseMipsSourceLine(text, lineNumber);
}

export function mipsParsedTokenRange(token: MipsParsedToken): Range {
  return Range.create(token.line, token.start, token.line, token.end);
}

export function mipsCstTokenRange(token: MipsCstToken): Range {
  return mipsParsedTokenRange(token);
}

export function mipsParsedRange(line: number, range: MipsParsedRange): Range {
  return Range.create(line, range.start, line, range.end);
}

export function mipsCstRange(line: number, range: CstRange): Range {
  return mipsParsedRange(line, range);
}

function tokenizeMipsCode(code: string, lineNumber: number): MipsParsedToken[] {
  const tokens: MipsParsedToken[] = [];
  let index = 0;
  while (index < code.length) {
    const char = code[index];
    if (isAsciiWhitespace(char)) {
      index++;
      continue;
    }
    if (char === '"') {
      const end = readStringEnd(code, index);
      tokens.push(makeToken('string', code.slice(index, end), lineNumber, index, end));
      index = end;
      continue;
    }
    if (char === '\'') {
      const end = readCharLiteralEnd(code, index);
      const value = code.slice(index, end);
      tokens.push(makeToken(parseCharLiteral(value) === undefined ? 'unknown' : 'number', value, lineNumber, index, end));
      index = end;
      continue;
    }
    if (char === '%' && isMipsIdentifierStart(code[index + 1] ?? '')) {
      const end = readMipsIdentifierEnd(code, index + 1);
      tokens.push(makeToken('macroParameter', code.slice(index, end), lineNumber, index, end));
      index = end;
      continue;
    }
    if (char === '$') {
      const end = readRegisterEnd(code, index + 1);
      tokens.push(makeToken('register', code.slice(index, end), lineNumber, index, end));
      index = end;
      continue;
    }
    if (char === '.' && isMipsIdentifierStart(code[index + 1] ?? '')) {
      const end = readMipsIdentifierEnd(code, index + 1);
      tokens.push(makeToken('directive', code.slice(index, end), lineNumber, index, end));
      index = end;
      continue;
    }
    if (isNumberStart(code, index)) {
      const end = readNumberEnd(code, index);
      tokens.push(makeToken('number', code.slice(index, end), lineNumber, index, end));
      index = end;
      continue;
    }
    if (isMipsIdentifierStart(char)) {
      const end = readMipsIdentifierEnd(code, index + 1);
      tokens.push(makeToken('identifier', code.slice(index, end), lineNumber, index, end));
      index = end;
      continue;
    }
    if (char === ',' || char === ':' || char === '(' || char === ')') {
      tokens.push(makeToken('punctuation', char, lineNumber, index, index + 1));
      index++;
      continue;
    }
    if (isOperatorChar(char)) {
      tokens.push(makeToken('operator', char, lineNumber, index, index + 1));
      index++;
      continue;
    }
    tokens.push(makeToken('unknown', char, lineNumber, index, index + 1));
    index++;
  }
  return tokens;
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

function parseMipsOperandNodes(text: string, baseOffset: number): MipsParsedOperand[] {
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

function readNumberEnd(text: string, start: number): number {
  let index = start;
  if ((text[index] === '+' || text[index] === '-') && isAsciiDigit(text[index + 1] ?? '')) {
    index++;
  }
  while (index < text.length && isNumberPart(text[index])) {
    index++;
  }
  return index;
}

function readStringEnd(text: string, start: number): number {
  let index = start + 1;
  let escaped = false;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' && !escaped) {
      return index + 1;
    }
    escaped = char === '\\' && !escaped;
    if (char !== '\\') {
      escaped = false;
    }
    index++;
  }
  return text.length;
}

function readCharLiteralEnd(text: string, start: number): number {
  let index = start + 1;
  let escaped = false;
  while (index < text.length) {
    const char = text[index];
    if (char === '\'' && !escaped) {
      return index + 1;
    }
    escaped = char === '\\' && !escaped;
    if (char !== '\\') {
      escaped = false;
    }
    index++;
  }
  return text.length;
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

function stripBalancedOuterParens(text: string): string {
  if (!text.startsWith('(') || !text.endsWith(')')) {
    return text;
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
        return text;
      }
    }
  }
  return depth === 0 ? text.slice(1, -1) : text;
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

function isNumberStart(text: string, index: number): boolean {
  const char = text[index];
  return isAsciiDigit(char) || ((char === '+' || char === '-') && isAsciiDigit(text[index + 1] ?? ''));
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

function isNumberPart(char: string): boolean {
  return isAsciiDigit(char)
    || (char >= 'A' && char <= 'F')
    || (char >= 'a' && char <= 'f')
    || char === 'x'
    || char === 'X'
    || char === 'b'
    || char === 'B'
    || char === '_';
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isAsciiWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f' || char === '\v';
}

function isOperatorChar(char: string): boolean {
  return char === '+' || char === '-' || char === '*' || char === '/' || char === '<' || char === '>' || char === '=' || char === '&' || char === '|' || char === '^' || char === '~';
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
}

export interface MipsCommentLine {
  kind: 'comment';
  comment: string;
}

export interface MipsStatementLine {
  kind: 'statement';
  labels: string[];
  executable?: MipsExecutableNode;
  comment?: string;
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
    lines: text.split(/\r?\n/).map(parseMipsFormatLine)
  };
}

export function printMipsFormatDocument(ast: MipsFormatDocument, eol = '\n'): string {
  let macroDepth = 0;
  return ast.lines.map((line) => {
    if (isMipsDirective(line, '.end_macro')) {
      macroDepth = Math.max(0, macroDepth - 1);
    }
    const formatted = printMipsFormatLineWithContext(line, macroDepth > 0);
    if (isMipsDirective(line, '.macro')) {
      macroDepth++;
    }
    return formatted;
  }).join(eol);
}

export function parseMipsFormatLine(line: string): MipsFormatLine {
  const parsed = parseMipsSourceLine(line, 0);
  if (parsed.kind === 'blank') {
    return { kind: 'blank' };
  }
  if (parsed.kind === 'comment') {
    return { kind: 'comment', comment: normalizeMipsComment(parsed.comment?.value ?? '') };
  }
  return {
    kind: 'statement',
    labels: parsed.labels.map((label) => label.name),
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

export function printMipsFormatLine(line: MipsFormatLine): string {
  return printMipsFormatLineWithContext(line, false);
}

function printMipsFormatLineWithContext(line: MipsFormatLine, indentDirectives: boolean): string {
  if (line.kind === 'blank') {
    return '';
  }
  if (line.kind === 'comment') {
    return line.comment;
  }
  const formattedCode = printMipsStatement(line, indentDirectives);
  if (!line.comment) {
    return formattedCode;
  }
  return `${formattedCode.padEnd(Math.max(formattedCode.length + 1, 32))}${line.comment}`;
}

export function formatMipsLine(line: string): string {
  return printMipsFormatLine(parseMipsFormatLine(line));
}

function printMipsStatement(line: MipsStatementLine, indentDirectives: boolean): string {
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
    : `    ${executable}`;
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
  return splitMipsCommaOperandSpans(text)
    .map((operand) => operand.trim())
    .join(', ');
}

function splitMipsCommaOperands(text: string): string[] {
  return splitMipsCommaOperandSpans(text)
    .map((operand) => operand.trim())
    .filter(Boolean);
}

function splitMipsCommaOperandSpans(text: string): string[] {
  const operands: string[] = [];
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
      operands.push(text.slice(start, index));
      start = index + 1;
    }
  }
  operands.push(text.slice(start));
  return operands;
}

function isMipsDirective(line: MipsFormatLine, directive: string): boolean {
  return line.kind === 'statement'
    && line.executable?.kind === 'directive'
    && line.executable.mnemonic.toLowerCase() === directive;
}

export function findCommentIndex(line: string): number {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (inString) {
      if (char === '"' && !escaped) {
        inString = false;
        escaped = false;
        continue;
      }
      escaped = char === '\\' && !escaped;
      if (char !== '\\') {
        escaped = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }
    if (char === '#') {
      return index;
    }
  }
  return -1;
}

export function isInsideAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}
