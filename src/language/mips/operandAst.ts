export interface MipsMemoryOperandAst {
  kind: 'memory';
  offset: string;
  base: string;
}

export function parseMipsMemoryOperand(text: string): MipsMemoryOperandAst | undefined {
  const trimmed = trimAscii(text);
  if (!trimmed.endsWith(')')) {
    return undefined;
  }

  const open = matchingMemoryOpenParen(trimmed);
  if (open < 0) {
    return undefined;
  }

  const base = trimAscii(trimmed.slice(open + 1, trimmed.length - 1));
  if (!base || containsParen(base)) {
    return undefined;
  }

  return {
    kind: 'memory',
    offset: trimAscii(trimmed.slice(0, open)) || '0',
    base
  };
}

export function isMipsMacroArgumentTokenText(text: string): boolean {
  const trimmed = trimAscii(text);
  return isMipsStringLiteralText(trimmed)
    || isMipsCharLiteralText(trimmed)
    || isMipsSymbolToken(trimmed);
}

export function splitFormatMnemonic(format: string): { mnemonic: string; operands: string } | undefined {
  const trimmed = trimAscii(format);
  const end = firstAsciiWhitespace(trimmed);
  if (end < 0) {
    return undefined;
  }
  return {
    mnemonic: trimmed.slice(0, end),
    operands: trimAscii(trimmed.slice(end))
  };
}

export function stripLeadingDollar(text: string): string {
  return text.startsWith('$') ? text.slice(1) : text;
}

function matchingMemoryOpenParen(text: string): number {
  let depth = 0;
  let candidate = -1;
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
      if (depth === 0) {
        candidate = index;
      }
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth < 0) {
        return -1;
      }
      if (depth === 0 && index !== text.length - 1) {
        candidate = -1;
      }
    }
  }

  return depth === 0 ? candidate : -1;
}

function containsParen(text: string): boolean {
  for (const char of text) {
    if (char === '(' || char === ')') {
      return true;
    }
  }
  return false;
}

export function isMipsStringLiteralText(text: string): boolean {
  if (text.length < 2 || text[0] !== '"' || text[text.length - 1] !== '"') {
    return false;
  }
  return quotedLiteralHasValidBody(text, '"');
}

function isMipsCharLiteralText(text: string): boolean {
  if (text.length < 3 || text[0] !== '\'' || text[text.length - 1] !== '\'') {
    return false;
  }
  if (!quotedLiteralHasValidBody(text, '\'')) {
    return false;
  }
  let units = 0;
  for (let index = 1; index < text.length - 1; index++) {
    if (text[index] === '\\') {
      index++;
    }
    units++;
  }
  return units === 1;
}

function quotedLiteralHasValidBody(text: string, quote: string): boolean {
  let escaped = false;
  for (let index = 1; index < text.length - 1; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) {
      return false;
    }
  }
  return !escaped;
}

function isMipsSymbolToken(text: string): boolean {
  if (!text) {
    return false;
  }
  let start = 0;
  if (text[0] === '%' || text[0] === '$') {
    start = 1;
  }
  if (!isMipsSymbolStart(text[start] ?? '')) {
    return false;
  }
  for (let index = start + 1; index < text.length; index++) {
    if (!isMipsSymbolPart(text[index])) {
      return false;
    }
  }
  return true;
}

function firstAsciiWhitespace(text: string): number {
  for (let index = 0; index < text.length; index++) {
    if (isAsciiWhitespace(text[index])) {
      return index;
    }
  }
  return -1;
}

function trimAscii(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isAsciiWhitespace(text[start])) {
    start++;
  }
  while (end > start && isAsciiWhitespace(text[end - 1])) {
    end--;
  }
  return text.slice(start, end);
}

function isMipsSymbolStart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_' || char === '.' || char === '$';
}

function isMipsSymbolPart(char: string): boolean {
  return isMipsSymbolStart(char) || (char >= '0' && char <= '9');
}

function isAsciiWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f' || char === '\v';
}
