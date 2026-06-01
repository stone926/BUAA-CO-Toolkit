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
  const normalized = text.trim().replace(/^\(/, '').replace(/\)$/, '').trim();
  if (!normalized) {
    return [];
  }
  const args: string[] = [];
  let start = 0;
  let inString = false;
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === '"' && normalized[index - 1] !== '\\') {
      inString = !inString;
    }
    if (!inString && (char === ',' || /\s/.test(char))) {
      const arg = normalized.slice(start, index).trim();
      if (arg) {
        args.push(arg);
      }
      start = index + 1;
    }
  }
  const tail = normalized.slice(start).trim();
  if (tail) {
    args.push(tail);
  }
  return args;
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
  const commentIndex = findCommentIndex(line);
  const code = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const comment = commentIndex >= 0 ? line.slice(commentIndex).trimEnd() : '';
  if (!code.trim()) {
    return comment ? { kind: 'comment', comment } : { kind: 'blank' };
  }

  let rest = code.trim();
  const labels: string[] = [];
  while (true) {
    const labelMatch = /^([A-Za-z_.$%][\w.$%]*):/.exec(rest);
    if (!labelMatch) {
      break;
    }
    labels.push(labelMatch[1]);
    rest = rest.slice(labelMatch[0].length).trimStart();
  }

  const tokenMatch = /^([A-Za-z_.$][\w.$]*|\.[A-Za-z_][\w.]*)([\s\S]*)$/.exec(rest);
  const executable = tokenMatch
    ? {
      kind: tokenMatch[1].startsWith('.') ? 'directive' as const : 'instruction' as const,
      mnemonic: tokenMatch[1],
      operandText: normalizeMipsOperandText(tokenMatch[2].trim()),
      operands: parseOperands(tokenMatch[2].trim())
    }
    : undefined;

  return {
    kind: 'statement',
    labels,
    executable,
    comment: comment || undefined
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
  return executable.operandText
    ? `${executable.mnemonic} ${executable.operandText}`
    : executable.mnemonic;
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
      escaped = char === '\\' && !escaped;
      if (char === '"' && !escaped) {
        inString = false;
      } else if (char !== '\\') {
        escaped = false;
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
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== '\\') {
      inString = !inString;
    }
    if (char === '#' && !inString) {
      return index;
    }
  }
  return -1;
}

export function getStringRanges(code: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start: number | undefined;
  for (let index = 0; index < code.length; index++) {
    if (code[index] !== '"' || code[index - 1] === '\\') {
      continue;
    }
    if (start === undefined) {
      start = index;
    } else {
      ranges.push({
        start,
        end: index + 1
      });
      start = undefined;
    }
  }
  if (start !== undefined) {
    ranges.push({
      start,
      end: code.length
    });
  }
  return ranges;
}

export function getNumericLikeRanges(code: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const regex = /[-+]?(?:0[xX][\w]+|0[bB][\w]+|0\d+|\b\d+\b)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code))) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return ranges;
}

export function isInsideAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

export function isIntegerLiteral(value: string): boolean {
  return parseIntegerLiteral(value) !== undefined;
}

export function isNonNegativeIntegerLiteral(value: string): boolean {
  const parsed = parseIntegerLiteral(value);
  return parsed !== undefined && parsed >= 0;
}

export function parseIntegerLiteral(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^[-+]?(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|0[0-7]+|\d+)$/.test(trimmed)) {
    return undefined;
  }
  const sign = trimmed.startsWith('-') ? -1n : 1n;
  const unsigned = trimmed.replace(/^[-+]/, '');
  if (/^0\d+$/.test(unsigned) && !/^0[0-7]+$/.test(unsigned)) {
    return undefined;
  }
  let magnitude: bigint;
  if (/^0[xX]/.test(unsigned)) {
    magnitude = BigInt(unsigned);
  } else if (/^0[bB]/.test(unsigned)) {
    magnitude = BigInt(unsigned);
  } else if (/^0[0-7]+$/.test(unsigned) && unsigned.length > 1) {
    magnitude = BigInt(`0o${unsigned.slice(1)}`);
  } else {
    magnitude = BigInt(unsigned);
  }
  const parsed = sign * magnitude;
  if (parsed < -2147483648n || parsed > 0xffffffffn) {
    return undefined;
  }
  return Number(parsed);
}

export function isFloatLiteral(value: string): boolean {
  return /^[-+]?(?:(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+|\d+)$/.test(value.trim());
}

export function isCharLiteral(value: string): boolean {
  return /^'(?:[^'\\]|\\.)'$/.test(value.trim());
}

export function isSymbolLike(value: string): boolean {
  return /^[A-Za-z_.$][\w.$]*$/.test(value);
}

export function signed32ImmediateValue(value: number): number {
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

export function integerFitsRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}
