// @index mips-core — 严格汇编器常量表达式：32 位补码求值与符号解析回调（纯 TS）

import { parseCharacterLiteral, parseIntegerLiteral } from './literals';
import { s32 } from '../values';

/**
 * Symbol resolver used by both layout pass 1 and relocation pass 2. Returning
 * `undefined` means "not yet known"; the caller decides whether that is a
 * forward reference or a hard undefined-symbol error.
 */
export interface ExpressionSymbolResolver {
  resolve(name: string): number | undefined;
}

export interface ExpressionEvaluation {
  readonly ok: boolean;
  /** Signed 32-bit evaluation. */
  readonly value?: number;
  readonly unresolvedSymbols?: readonly string[];
  readonly error?: string;
}

interface Token {
  readonly kind: 'number' | 'identifier' | 'operator' | 'left' | 'right' | 'end';
  readonly text: string;
  readonly offset: number;
}

const operatorPrecedence: Readonly<Record<string, number>> = {
  '|': 1,
  '^': 2,
  '&': 3,
  '<<': 4,
  '>>': 4,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7
};

export function evaluateExpression(
  text: string,
  resolver: ExpressionSymbolResolver,
  options: { readonly unresolvedIsError?: boolean } = {}
): ExpressionEvaluation {
  const tokens = tokenizeExpression(text);
  if (tokens.error) return { ok: false, error: tokens.error };
  const parser = new ExpressionParser(tokens.value!, resolver, options.unresolvedIsError === true);
  return parser.parse();
}

export function isExpressionText(text: string): boolean {
  const value = text.trim();
  return value.length > 0 && !value.startsWith('"') && !value.startsWith("'")
    && !/^[+-]?(?:0x[0-9a-f]+|0b[01]+|\d+)$/i.test(value.replace(/_/g, ''));
}

function tokenizeExpression(text: string): { value?: Token[]; error?: string } {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '(') {
      tokens.push({ kind: 'left', text: char, offset: index });
      index++;
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'right', text: char, offset: index });
      index++;
      continue;
    }
    if (char === '<' && text[index + 1] === '<') {
      tokens.push({ kind: 'operator', text: '<<', offset: index });
      index += 2;
      continue;
    }
    if (char === '>' && text[index + 1] === '>') {
      tokens.push({ kind: 'operator', text: '>>', offset: index });
      index += 2;
      continue;
    }
    if ('+-*/%&|^~'.includes(char)) {
      tokens.push({ kind: 'operator', text: char, offset: index });
      index++;
      continue;
    }
    if (char === "'") {
      const end = readQuoted(text, index, "'");
      if (end < 0) return { error: `unterminated character literal at offset ${index}` };
      const parsed = parseCharacterLiteral(text.slice(index, end));
      if (parsed === undefined) return { error: `invalid character literal ${text.slice(index, end)}` };
      tokens.push({ kind: 'number', text: String(parsed), offset: index });
      index = end;
      continue;
    }
    if (isNumberStart(text, index)) {
      const end = readNumber(text, index);
      const parsed = parseIntegerLiteral(text.slice(index, end));
      if (parsed === undefined) return { error: `invalid integer literal ${text.slice(index, end)}` };
      tokens.push({ kind: 'number', text: String(parsed), offset: index });
      index = end;
      continue;
    }
    if (isIdentifierStart(char)) {
      const end = readIdentifier(text, index);
      tokens.push({ kind: 'identifier', text: text.slice(index, end), offset: index });
      index = end;
      continue;
    }
    return { error: `unexpected character ${JSON.stringify(char)} at offset ${index}` };
  }
  tokens.push({ kind: 'end', text: '', offset: text.length });
  return { value: tokens };
}

class ExpressionParser {
  private index = 0;
  private readonly unresolved = new Set<string>();

  constructor(
    private readonly tokens: readonly Token[],
    private readonly resolver: ExpressionSymbolResolver,
    private readonly unresolvedIsError: boolean
  ) {}

  parse(): ExpressionEvaluation {
    try {
      const value = this.parseBinary(1);
      if (this.current.kind !== 'end') {
        return { ok: false, error: `unexpected token ${this.current.text}` };
      }
      if (this.unresolved.size) {
        return { ok: false, unresolvedSymbols: [...this.unresolved].sort() };
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private parseBinary(minPrecedence: number): number {
    let left = this.parseUnary();
    while (true) {
      const operator = this.current;
      if (operator.kind !== 'operator') break;
      const precedence = operatorPrecedence[operator.text];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.index++;
      const right = this.parseBinary(precedence + 1);
      left = applyBinary(operator.text, left, right);
    }
    return left;
  }

  private parseUnary(): number {
    const token = this.current;
    if (token.kind === 'operator' && (token.text === '-' || token.text === '+' || token.text === '~')) {
      this.index++;
      const operand = this.parseUnary();
      if (token.text === '-') return s32(-operand);
      if (token.text === '~') return s32(~operand);
      return s32(operand);
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.current;
    if (token.kind === 'number') {
      this.index++;
      return Number(token.text) | 0;
    }
    if (token.kind === 'identifier') {
      this.index++;
      const resolved = this.resolver.resolve(token.text);
      if (resolved === undefined) {
        if (this.unresolvedIsError) {
          throw new Error(`undefined symbol ${token.text}`);
        }
        this.unresolved.add(token.text);
        return 0;
      }
      return s32(resolved);
    }
    if (token.kind === 'left') {
      this.index++;
      const value = this.parseBinary(1);
      if (this.current.kind !== 'right') {
        throw new Error('missing closing parenthesis');
      }
      this.index++;
      return value;
    }
    if (token.kind === 'end') {
      throw new Error('unexpected end of expression');
    }
    throw new Error(`unexpected token ${token.text}`);
  }

  private get current(): Token {
    return this.tokens[this.index] ?? { kind: 'end', text: '', offset: 0 };
  }
}

function applyBinary(operator: string, left: number, right: number): number {
  const lhs = left | 0;
  const rhs = right | 0;
  switch (operator) {
    case '+': return s32(lhs + rhs);
    case '-': return s32(lhs - rhs);
    case '*': return s32(Math.imul(lhs, rhs));
    case '/':
      if (rhs === 0) throw new Error('division by zero in constant expression');
      return (lhs / rhs) | 0;
    case '%':
      if (rhs === 0) throw new Error('remainder by zero in constant expression');
      return lhs % rhs;
    case '<<': return s32(lhs << (rhs & 31));
    case '>>': return lhs >> (rhs & 31);
    case '&': return s32(lhs & rhs);
    case '|': return s32(lhs | rhs);
    case '^': return s32(lhs ^ rhs);
    default: throw new Error(`unsupported operator ${operator}`);
  }
}

function readQuoted(text: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index++) {
    if (!escaped && text[index] === quote) return index + 1;
    escaped = !escaped && text[index] === '\\';
    if (escaped && text[index] === '\\' && index + 1 < text.length) {
      // Handled by the next loop iteration.
    }
  }
  return -1;
}

function readNumber(text: string, start: number): number {
  let index = start;
  if (text[index] === '-' || text[index] === '+') index++;
  if (text[index] === '0' && index + 1 < text.length && (text[index + 1] === 'x' || text[index + 1] === 'X' || text[index + 1] === 'b' || text[index + 1] === 'B')) {
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
    || char === '_' || char === '.' || char === '$';
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || (char >= '0' && char <= '9');
}

function readIdentifier(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length && isIdentifierPart(text[index])) index++;
  return index;
}

function isWordCharacter(char: string): boolean {
  return isAsciiDigit(char) || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_';
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}
