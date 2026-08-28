// @index mips-core — 严格汇编器操作数解析：GPR/CP0/内存操作数与表达式形态（纯 TS）

import { SourceSpan } from './diagnostics';
import { parseGprRegister, parseCp0Register } from './registers';

export type ParsedOperandKind =
  | { readonly kind: 'register'; readonly register: number }
  | { readonly kind: 'cp0'; readonly register: number }
  | {
      readonly kind: 'memory';
      readonly baseRegister: number;
      readonly offsetText: string;
      readonly offsetSpan: SourceSpan;
    }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'character'; readonly text: string }
  | { readonly kind: 'immediate'; readonly text: string }
  | { readonly kind: 'macro-parameter'; readonly text: string };

export type ParsedInstructionOperand =
  | { readonly kind: 'register'; readonly register: number; readonly span: SourceSpan }
  | { readonly kind: 'cp0'; readonly register: number; readonly span: SourceSpan }
  | {
      readonly kind: 'memory';
      readonly baseRegister: number;
      readonly offsetText: string;
      readonly offsetSpan: SourceSpan;
      readonly span: SourceSpan;
    }
  | { readonly kind: 'string'; readonly text: string; readonly span: SourceSpan }
  | { readonly kind: 'character'; readonly text: string; readonly span: SourceSpan }
  | { readonly kind: 'immediate'; readonly text: string; readonly span: SourceSpan }
  | { readonly kind: 'macro-parameter'; readonly text: string; readonly span: SourceSpan };

export function parseInstructionOperand(text: string, span: SourceSpan): ParsedInstructionOperand {
  const trimmed = text.trim();
  if (trimmed.startsWith('%')) {
    return { kind: 'macro-parameter', text: trimmed, span };
  }
  const register = parseGprRegister(trimmed);
  if (register !== undefined) {
    return { kind: 'register', register, span };
  }
  const cp0 = parseCp0Register(trimmed);
  if (cp0 !== undefined) {
    return { kind: 'cp0', register: cp0, span };
  }
  if (trimmed.startsWith('"')) {
    return { kind: 'string', text: trimmed, span };
  }
  if (trimmed.startsWith("'")) {
    return { kind: 'character', text: trimmed, span };
  }
  const memory = parseMemoryOperand(text, span);
  if (memory) {
    return { ...memory, span };
  }
  return { kind: 'immediate', text: trimmed, span };
}

export function parseMemoryOperand(
  text: string,
  span: SourceSpan
): Extract<ParsedOperandKind, { kind: 'memory' }> | undefined {
  let value = text.trim();
  if (value.startsWith('(') && value.endsWith(')')) {
    value = `0${value}`;
  }
  if (!value.endsWith(')')) return undefined;
  const open = matchingBaseOpenParen(value);
  if (open < 0) return undefined;
  const baseText = value.slice(open + 1, -1).trim();
  const baseRegister = parseGprRegister(baseText);
  if (baseRegister === undefined) return undefined;
  const offsetText = value.slice(0, open).trim();
  const leading = leadingWhitespaceLength(text);
  return {
    kind: 'memory',
    baseRegister,
    offsetText: offsetText || '0',
    offsetSpan: {
      sourceId: span.sourceId,
      startOffset: span.startOffset + leading,
      endOffset: span.startOffset + leading + (offsetText || '0').length
    }
  };
}

/** Find the `(` that opens the trailing `($base)` group, skipping expression parentheses. */
function matchingBaseOpenParen(text: string): number {
  let depth = 0;
  let quoted: '"' | "'" | undefined;
  let escaped = false;
  for (let index = text.length - 2; index >= 0; index--) {
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
    if (char === ')') {
      depth++;
      continue;
    }
    if (char === '(') {
      if (depth === 0) return index;
      depth--;
    }
  }
  return -1;
}

function leadingWhitespaceLength(text: string): number {
  let index = 0;
  while (index < text.length && /\s/.test(text[index])) index++;
  return index;
}
