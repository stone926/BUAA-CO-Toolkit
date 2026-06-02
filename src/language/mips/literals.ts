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
  let index = 0;
  while (index < code.length) {
    const start = numericLikeStart(code, index);
    if (start < 0) {
      index++;
      continue;
    }
    const end = readNumericLikeEnd(code, start);
    ranges.push({ start, end });
    index = end;
  }
  return ranges;
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
  if (!trimmed) {
    return undefined;
  }
  let index = 0;
  const sign = trimmed[index] === '-' ? -1n : 1n;
  if (trimmed[index] === '-' || trimmed[index] === '+') {
    index++;
  }
  const parsedMagnitude = parseUnsignedIntegerMagnitude(trimmed.slice(index));
  if (parsedMagnitude === undefined) {
    return undefined;
  }
  const parsed = sign * parsedMagnitude;
  if (parsed < -2147483648n || parsed > 0xffffffffn) {
    return undefined;
  }
  return Number(parsed);
}

export function isFloatLiteral(value: string): boolean {
  return parseFloatLiteralShape(value.trim());
}

export function isCharLiteral(value: string): boolean {
  const text = value.trim();
  if (text.length < 3 || text[0] !== '\'' || text[text.length - 1] !== '\'') {
    return false;
  }
  let units = 0;
  for (let index = 1; index < text.length - 1; index++) {
    if (text[index] === '\\') {
      index++;
      if (index >= text.length - 1) {
        return false;
      }
    } else if (text[index] === '\'') {
      return false;
    }
    units++;
  }
  return units === 1;
}

export function isSymbolLike(value: string): boolean {
  if (!value || !(isMipsIdentifierStart(value[0]) || value[0] === '.')) {
    return false;
  }
  for (let index = 1; index < value.length; index++) {
    if (!isMipsIdentifierPart(value[index])) {
      return false;
    }
  }
  return true;
}

export function signed32ImmediateValue(value: number): number {
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

export function integerFitsRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

function numericLikeStart(text: string, index: number): number {
  const char = text[index];
  if ((char === '-' || char === '+') && isAsciiDigit(text[index + 1] ?? '')) {
    return index;
  }
  return isAsciiDigit(char) ? index : -1;
}

function readNumericLikeEnd(text: string, start: number): number {
  let index = start;
  if (text[index] === '-' || text[index] === '+') {
    index++;
  }
  if (text[index] === '0' && (text[index + 1] === 'x' || text[index + 1] === 'X' || text[index + 1] === 'b' || text[index + 1] === 'B')) {
    index += 2;
    while (index < text.length && isAsciiWord(text[index])) {
      index++;
    }
    return index;
  }
  while (index < text.length && isAsciiWord(text[index])) {
    index++;
  }
  return index;
}

function parseUnsignedIntegerMagnitude(text: string): bigint | undefined {
  if (!text) {
    return undefined;
  }
  if (text.length > 2 && text[0] === '0' && (text[1] === 'x' || text[1] === 'X')) {
    return parseDigits(text.slice(2), 16);
  }
  if (text.length > 2 && text[0] === '0' && (text[1] === 'b' || text[1] === 'B')) {
    return parseDigits(text.slice(2), 2);
  }
  if (text.length > 1 && text[0] === '0') {
    return parseDigits(text.slice(1), 8);
  }
  return parseDigits(text, 10);
}

function parseDigits(text: string, radix: number): bigint | undefined {
  if (!text) {
    return undefined;
  }
  let value = 0n;
  for (const char of text) {
    const digit = digitValue(char);
    if (digit === undefined || digit >= radix) {
      return undefined;
    }
    value = value * BigInt(radix) + BigInt(digit);
  }
  return value;
}

function parseFloatLiteralShape(text: string): boolean {
  let index = 0;
  if (text[index] === '-' || text[index] === '+') {
    index++;
  }
  const mantissaStart = index;
  const beforeDot = readDecimalDigits(text, index);
  index = beforeDot;
  let hasDot = false;
  if (text[index] === '.') {
    hasDot = true;
    index++;
  }
  const fractionStart = index;
  const afterDot = readDecimalDigits(text, index);
  const mantissaDigits = beforeDot > mantissaStart || afterDot > fractionStart;
  index = afterDot;
  let hasExponent = false;
  if (text[index] === 'e' || text[index] === 'E') {
    hasExponent = true;
    index++;
    if (text[index] === '-' || text[index] === '+') {
      index++;
    }
    const exponentEnd = readDecimalDigits(text, index);
    if (exponentEnd === index) {
      return false;
    }
    index = exponentEnd;
  }
  return index === text.length && mantissaDigits && (hasDot || hasExponent || beforeDot > mantissaStart);
}

function readDecimalDigits(text: string, start: number): number {
  let index = start;
  while (index < text.length && isAsciiDigit(text[index])) {
    index++;
  }
  return index;
}

function digitValue(char: string): number | undefined {
  if (char >= '0' && char <= '9') {
    return char.charCodeAt(0) - '0'.charCodeAt(0);
  }
  const lower = char.toLowerCase();
  if (lower >= 'a' && lower <= 'f') {
    return lower.charCodeAt(0) - 'a'.charCodeAt(0) + 10;
  }
  return undefined;
}

function isMipsIdentifierStart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_' || char === '$';
}

function isMipsIdentifierPart(char: string): boolean {
  return isMipsIdentifierStart(char) || isAsciiDigit(char) || char === '.';
}

function isAsciiWord(char: string): boolean {
  return isAsciiDigit(char)
    || (char >= 'A' && char <= 'Z')
    || (char >= 'a' && char <= 'z')
    || char === '_';
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}
