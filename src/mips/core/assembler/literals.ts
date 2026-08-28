// @index mips-core — 严格汇编器字面量解析：整数、字符与字符串转义（纯 TS）

export interface ParsedInteger {
  /** Numeric value, normalized to signed 32-bit. */
  readonly value: number;
}

const maximumInteger = 0xffff_ffffn;
const minimumInteger = -0x8000_0000n;

export function parseIntegerLiteral(text: string): number | undefined {
  const parsed = tryParseIntegerLiteral(text);
  return parsed === undefined ? undefined : Number(parsed);
}

export function parseNonNegativeIntegerLiteral(text: string): number | undefined {
  const parsed = tryParseIntegerLiteral(text);
  return parsed !== undefined && parsed >= 0n && parsed <= maximumInteger
    ? Number(parsed)
    : undefined;
}

function tryParseIntegerLiteral(text: string): bigint | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let index = 0;
  let sign = 1n;
  if (trimmed[index] === '-') {
    sign = -1n;
    index++;
  } else if (trimmed[index] === '+') {
    index++;
  }
  if (index >= trimmed.length) return undefined;
  const magnitude = parseMagnitude(trimmed, index);
  if (magnitude === undefined) return undefined;
  const value = sign * magnitude.value;
  if (value < minimumInteger || value > maximumInteger) return undefined;
  return BigInt.asIntN(32, value);
}

function parseMagnitude(text: string, index: number): { value: bigint; end: number } | undefined {
  if (text[index] === '0' && index + 1 < text.length) {
    const prefix = text[index + 1].toLowerCase();
    if (prefix === 'x') return parseDigits(text, index + 2, 16);
    if (prefix === 'b') return parseDigits(text, index + 2, 2);
    const parsed = parseDigits(text, index + 1, 8);
    if (parsed !== undefined && parsed.end > index + 1) return parsed;
    // A bare 0 is decimal.
    if (index + 1 === text.length || !isDecimalDigit(text[index + 1])) {
      return { value: 0n, end: index + 1 };
    }
  }
  return parseDigits(text, index, 10);
}

function parseDigits(text: string, index: number, radix: number): { value: bigint; end: number } | undefined {
  if (index >= text.length) return undefined;
  let value = 0n;
  let cursor = index;
  while (cursor < text.length) {
    const digit = digitValue(text[cursor]);
    if (digit === undefined || digit >= radix) break;
    value = value * BigInt(radix) + BigInt(digit);
    cursor++;
  }
  if (cursor === index) return undefined;
  return { value, end: cursor };
}

function digitValue(char: string): number | undefined {
  if (char >= '0' && char <= '9') return char.charCodeAt(0) - 48;
  const lower = char.toLowerCase();
  if (lower >= 'a' && lower <= 'f') return lower.charCodeAt(0) - 87;
  return undefined;
}

function isDecimalDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

/** Parse a MIPS character literal such as 'A', '\n', '\'', or '\101'. */
export function parseCharacterLiteral(text: string): number | undefined {
  const value = text.trim();
  if (value.length < 3 || value[0] !== "'" || value[value.length - 1] !== "'") return undefined;
  const body = value.slice(1, -1);
  if (!body) return undefined;
  if (body[0] !== '\\') {
    return body.length === 1 ? body.charCodeAt(0) : undefined;
  }
  if (body.length === 2) {
    return escapedCharacterValue(body[1]);
  }
  if (body.length === 4
    && body[1] >= '0' && body[1] <= '7'
    && body[2] >= '0' && body[2] <= '7'
    && body[3] >= '0' && body[3] <= '7') {
    const parsed = (body.charCodeAt(1) - 48) * 64 + (body.charCodeAt(2) - 48) * 8 + (body.charCodeAt(3) - 48);
    return parsed <= 255 ? parsed : undefined;
  }
  return undefined;
}

function escapedCharacterValue(char: string): number | undefined {
  switch (char) {
    case 'n': return 10;
    case 't': return 9;
    case 'r': return 13;
    case 'b': return 8;
    case 'f': return 12;
    case '0': return 0;
    case '\\': return 92;
    case "'": return 39;
    case '"': return 34;
    default: return undefined;
  }
}

/** Decode a quoted MIPS string into UTF-8 bytes (MARS source semantics are byte-oriented). */
export function parseStringLiteralBytes(text: string): Uint8Array | undefined {
  const value = text.trim();
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return undefined;
  const bytes: number[] = [];
  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index];
    if (char !== '\\') {
      const encoded = utf8EncodeCodePoint(value.codePointAt(index)!);
      bytes.push(...encoded);
      if (value.codePointAt(index)! > 0xffff) index++;
      continue;
    }
    index++;
    if (index >= value.length - 1) return undefined;
    const escaped = value[index];
    if (escaped >= '0' && escaped <= '7') {
      let octal = escaped;
      while (octal.length < 3 && index + 1 < value.length - 1
        && value[index + 1] >= '0' && value[index + 1] <= '7') {
        octal += value[++index];
      }
      const byte = Number.parseInt(octal, 8);
      if (byte > 255) return undefined;
      bytes.push(byte);
      continue;
    }
    const simple = escapedCharacterValue(escaped);
    if (simple === undefined) return undefined;
    bytes.push(simple);
  }
  return Uint8Array.from(bytes);
}

function utf8EncodeCodePoint(codePoint: number): number[] {
  if (codePoint <= 0x7f) return [codePoint];
  if (codePoint <= 0x7ff) return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)];
  if (codePoint <= 0xffff) {
    return [
      0xe0 | (codePoint >> 12),
      0x80 | ((codePoint >> 6) & 0x3f),
      0x80 | (codePoint & 0x3f)
    ];
  }
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f)
  ];
}
