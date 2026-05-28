export function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== '\\') {
      inString = !inString;
    }
    if (char === '#' && !inString) {
      return line.slice(0, index);
    }
  }
  return line;
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
  return normalized
    .split(',')
    .map((operand) => operand.trim())
    .filter(Boolean);
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

export function formatMipsLine(line: string): string {
  const commentIndex = findCommentIndex(line);
  const code = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const comment = commentIndex >= 0 ? line.slice(commentIndex).trimEnd() : '';
  if (!code.trim()) {
    return comment ? comment : '';
  }
  const trimmed = code.trim().replace(/\s*,\s*/g, ', ');
  const formattedCode = /^[A-Za-z_.$][\w.$]*:/.test(trimmed) || trimmed.startsWith('.') ? trimmed : `    ${trimmed}`;
  if (!comment) {
    return formattedCode;
  }
  return `${formattedCode.padEnd(Math.max(formattedCode.length + 1, 32))}${comment}`;
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

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
