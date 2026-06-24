import { isIdentifierLike, lexVerilog, VerilogToken } from './lexer';

export type VerilogExpressionAst =
  | VerilogNumberLiteralAst
  | VerilogStringLiteralAst
  | VerilogIdentifierAst
  | VerilogUnaryExpressionAst
  | VerilogBinaryExpressionAst
  | VerilogConditionalExpressionAst
  | VerilogConcatenationAst
  | VerilogMultipleConcatenationAst
  | VerilogSelectExpressionAst
  | VerilogCallExpressionAst
  | VerilogMemberExpressionAst
  | VerilogParenthesizedExpressionAst
  | VerilogErrorExpressionAst;

export interface VerilogExpressionBase {
  start: number;
  end: number;
  missing?: VerilogMissingTokenAst[];
}

export interface VerilogMissingTokenAst extends VerilogExpressionBase {
  kind: 'missingToken';
  expected: string;
  message: string;
}

export interface VerilogErrorExpressionAst extends VerilogExpressionBase {
  kind: 'errorExpression';
  message: string;
  children: VerilogExpressionAst[];
  unexpectedToken?: string;
}

export interface VerilogNumberLiteralAst extends VerilogExpressionBase {
  kind: 'numberLiteral';
  raw: string;
  parsed?: ParsedVerilogNumberLiteral;
}

export interface VerilogStringLiteralAst extends VerilogExpressionBase {
  kind: 'stringLiteral';
  raw: string;
}

export interface VerilogIdentifierAst extends VerilogExpressionBase {
  kind: 'identifier';
  name: string;
}

export interface VerilogUnaryExpressionAst extends VerilogExpressionBase {
  kind: 'unaryExpression';
  operator: string;
  argument: VerilogExpressionAst;
}

export interface VerilogBinaryExpressionAst extends VerilogExpressionBase {
  kind: 'binaryExpression';
  operator: string;
  operatorStart: number;
  operatorEnd: number;
  left: VerilogExpressionAst;
  right: VerilogExpressionAst;
}

export interface VerilogConditionalExpressionAst extends VerilogExpressionBase {
  kind: 'conditionalExpression';
  condition: VerilogExpressionAst;
  whenTrue: VerilogExpressionAst;
  whenFalse: VerilogExpressionAst;
}

export interface VerilogConcatenationAst extends VerilogExpressionBase {
  kind: 'concatenation';
  elements: VerilogExpressionAst[];
}

export interface VerilogMultipleConcatenationAst extends VerilogExpressionBase {
  kind: 'multipleConcatenation';
  repeat: VerilogExpressionAst;
  elements: VerilogExpressionAst[];
}

export interface VerilogSelectExpressionAst extends VerilogExpressionBase {
  kind: 'selectExpression';
  target: VerilogExpressionAst;
  select: VerilogBitSelectAst | VerilogRangeSelectAst | VerilogIndexedPartSelectAst;
}

export interface VerilogBitSelectAst extends VerilogExpressionBase {
  kind: 'bitSelect';
  index: VerilogExpressionAst;
}

export interface VerilogRangeSelectAst extends VerilogExpressionBase {
  kind: 'rangeSelect';
  left: VerilogExpressionAst;
  right: VerilogExpressionAst;
}

export interface VerilogIndexedPartSelectAst extends VerilogExpressionBase {
  kind: 'indexedPartSelect';
  base: VerilogExpressionAst;
  direction: '+:' | '-:';
  width: VerilogExpressionAst;
}

export interface VerilogCallExpressionAst extends VerilogExpressionBase {
  kind: 'callExpression';
  callee: string;
  system: boolean;
  args: VerilogExpressionAst[];
}

export interface VerilogMemberExpressionAst extends VerilogExpressionBase {
  kind: 'memberExpression';
  target: VerilogExpressionAst;
  member: string;
}

export interface VerilogParenthesizedExpressionAst extends VerilogExpressionBase {
  kind: 'parenthesizedExpression';
  expression: VerilogExpressionAst;
}

export type ParsedVerilogNumberLiteral =
  | {
      kind: 'decimal';
      digits: string;
      value?: bigint;
    }
  | {
      kind: 'based';
      size?: number;
      signed: boolean;
      base: 'b' | 'o' | 'd' | 'h';
      digits: string;
      value?: bigint;
    };

export type VerilogConstantResolver = (name: string) => bigint | undefined;
export type VerilogConstantWidthResolver = (expression: VerilogExpressionAst) => number | undefined;

const prefixOperators = new Set(['!', '~', '&', '|', '^', '+', '-', '~&', '~|', '~^', '^~']);

interface BinaryBindingPower {
  left: number;
  right: number;
}

const binaryBindingPowers = new Map<string, BinaryBindingPower>([
  ['||', leftAssociative(2)],
  ['&&', leftAssociative(3)],
  ['|', leftAssociative(4)],
  ['^', leftAssociative(5)],
  ['^~', leftAssociative(5)],
  ['~^', leftAssociative(5)],
  ['&', leftAssociative(6)],
  ['==', leftAssociative(7)],
  ['!=', leftAssociative(7)],
  ['===', leftAssociative(7)],
  ['!==', leftAssociative(7)],
  ['<', leftAssociative(8)],
  ['<=', leftAssociative(8)],
  ['>', leftAssociative(8)],
  ['>=', leftAssociative(8)],
  ['<<', leftAssociative(9)],
  ['>>', leftAssociative(9)],
  ['<<<', leftAssociative(9)],
  ['>>>', leftAssociative(9)],
  ['+', leftAssociative(10)],
  ['-', leftAssociative(10)],
  ['*', leftAssociative(11)],
  ['/', leftAssociative(11)],
  ['%', leftAssociative(11)],
  ['**', rightAssociative(12)]
]);

const prefixBindingPower = 13;
const conditionalBindingPower = 1;

export function parseVerilogExpression(text: string): VerilogExpressionAst | undefined {
  return parseVerilogExpressionTokens(tokenizeExpression(text));
}

export function parseVerilogExpressionTokens(rawTokens: VerilogToken[]): VerilogExpressionAst | undefined {
  const tokens = rawTokens.filter((token) => token.kind !== 'comment' && token.kind !== 'eof');
  if (!tokens.length) {
    return undefined;
  }
  const parser = new ExpressionParser(tokens);
  const expression = parser.parseExpression(0, new Set());
  if (!expression) {
    return undefined;
  }
  return parser.isAtEnd(new Set()) ? expression : parser.wrapUnexpectedTrailingTokens(expression);
}

export function verilogExpressionHasError(expression: VerilogExpressionAst | undefined): boolean {
  if (!expression) {
    return false;
  }
  if (expression.kind === 'errorExpression' || expression.missing?.length) {
    return true;
  }
  switch (expression.kind) {
    case 'parenthesizedExpression':
      return verilogExpressionHasError(expression.expression);
    case 'unaryExpression':
      return verilogExpressionHasError(expression.argument);
    case 'binaryExpression':
      return verilogExpressionHasError(expression.left) || verilogExpressionHasError(expression.right);
    case 'conditionalExpression':
      return verilogExpressionHasError(expression.condition) ||
        verilogExpressionHasError(expression.whenTrue) ||
        verilogExpressionHasError(expression.whenFalse);
    case 'concatenation':
      return expression.elements.some(verilogExpressionHasError);
    case 'multipleConcatenation':
      return verilogExpressionHasError(expression.repeat) || expression.elements.some(verilogExpressionHasError);
    case 'selectExpression': {
      if (verilogExpressionHasError(expression.target)) {
        return true;
      }
      const select = expression.select;
      if (select.missing?.length) {
        return true;
      }
      if (select.kind === 'bitSelect') {
        return verilogExpressionHasError(select.index);
      }
      if (select.kind === 'rangeSelect') {
        return verilogExpressionHasError(select.left) || verilogExpressionHasError(select.right);
      }
      return verilogExpressionHasError(select.base) || verilogExpressionHasError(select.width);
    }
    case 'callExpression':
      return expression.args.some(verilogExpressionHasError);
    case 'memberExpression':
      return verilogExpressionHasError(expression.target);
    default:
      return false;
  }
}

export function parseVerilogNumberLiteral(value: string): ParsedVerilogNumberLiteral | undefined {
  const apostrophe = value.indexOf("'");
  if (apostrophe < 0) {
    if (!allDecimalDigits(value)) {
      return undefined;
    }
    const digits = value.split('_').join('');
    return { kind: 'decimal', digits, value: decimalDigitsToBigInt(digits) };
  }

  const sizeText = value.slice(0, apostrophe);
  const size = sizeText ? decimalStringToNumber(sizeText) : undefined;
  if (sizeText && size === undefined) {
    return undefined;
  }

  let index = apostrophe + 1;
  const signed = value[index] === 's' || value[index] === 'S';
  if (signed) {
    index++;
  }
  const base = value[index]?.toLowerCase();
  if (!isBasedLiteralBase(base)) {
    return undefined;
  }
  const digits = value.slice(index + 1).split('_').join('');
  if (!digits) {
    return undefined;
  }
  return {
    kind: 'based',
    size,
    signed,
    base,
    digits,
    value: basedDigitsToBigInt(base, digits)
  };
}

export function evalVerilogIntegerConstant(
  expression: VerilogExpressionAst,
  resolveIdentifier?: VerilogConstantResolver,
  resolveWidth?: VerilogConstantWidthResolver
): bigint | undefined {
  switch (expression.kind) {
    case 'numberLiteral':
      return expression.parsed?.value;
    case 'identifier':
      return resolveIdentifier?.(expression.name);
    case 'parenthesizedExpression':
      return evalVerilogIntegerConstant(expression.expression, resolveIdentifier, resolveWidth);
    case 'unaryExpression':
      return evalUnaryConstant(
        expression.operator,
        evalVerilogIntegerConstant(expression.argument, resolveIdentifier, resolveWidth),
        constantWidth(expression.argument, resolveIdentifier, resolveWidth)
      );
    case 'binaryExpression':
      return evalBinaryConstant(
        expression.operator,
        evalVerilogIntegerConstant(expression.left, resolveIdentifier, resolveWidth),
        evalVerilogIntegerConstant(expression.right, resolveIdentifier, resolveWidth)
      );
    case 'conditionalExpression': {
      const condition = evalVerilogIntegerConstant(expression.condition, resolveIdentifier, resolveWidth);
      if (condition === undefined) {
        return undefined;
      }
      return evalVerilogIntegerConstant(condition === 0n ? expression.whenFalse : expression.whenTrue, resolveIdentifier, resolveWidth);
    }
    case 'callExpression':
      return evalCallConstant(expression, resolveIdentifier, resolveWidth);
    case 'concatenation':
      return evalConcatenationConstant(expression.elements, resolveIdentifier, resolveWidth);
    case 'multipleConcatenation':
      return evalMultipleConcatenationConstant(expression, resolveIdentifier, resolveWidth);
    case 'selectExpression':
      return evalSelectConstant(expression, resolveIdentifier, resolveWidth);
    case 'errorExpression':
      return undefined;
    default:
      return undefined;
  }
}

function tokenizeExpression(text: string): VerilogToken[] {
  return lexVerilog(text).tokens.filter((token) => token.kind !== 'comment' && token.kind !== 'eof');
}

class ExpressionParser {
  private index = 0;

  constructor(private readonly tokens: VerilogToken[]) {}

  parseExpression(minBindingPower: number, stopValues: Set<string>): VerilogExpressionAst | undefined {
    if (this.isAtEnd(stopValues)) {
      return this.missingExpression('expression');
    }

    let left = this.parsePrefix(stopValues);
    if (!left) {
      return this.missingExpression('expression');
    }
    left = this.parsePostfix(left);

    while (!this.isAtEnd(stopValues)) {
      const token = this.peek();
      if (!token) {
        break;
      }
      if (this.isSplitIndexedPartSelectSeparator(token, stopValues)) {
        break;
      }

      if (token.value === '?') {
        if (conditionalBindingPower < minBindingPower) {
          break;
        }
        this.consume();
        const whenTrue = this.parseExpression(0, withStop(stopValues, ':'));
        const missing: VerilogMissingTokenAst[] = [];
        if (this.peek()?.value === ':') {
          this.consume();
        } else {
          missing.push(this.missingToken(':', whenTrue?.end ?? left.end));
        }
        const whenFalse = this.parseExpression(conditionalBindingPower, stopValues);
        left = {
          kind: 'conditionalExpression',
          condition: left,
          whenTrue: whenTrue ?? this.missingExpression('expression'),
          whenFalse: whenFalse ?? this.missingExpression('expression'),
          start: left.start,
          end: (whenFalse ?? whenTrue ?? left).end,
          missing: missing.length ? missing : undefined
        };
        continue;
      }

      const binding = binaryBindingPowers.get(token.value);
      if (!binding || binding.left < minBindingPower) {
        break;
      }
      this.consume();
      const right = this.parseExpression(binding.right, stopValues);
      left = {
        kind: 'binaryExpression',
        operator: token.value,
        operatorStart: token.start,
        operatorEnd: token.end,
        left,
        right: right ?? this.missingExpression('expression'),
        start: left.start,
        end: (right ?? token).end
      };
    }

    return left;
  }

  isAtEnd(stopValues: Set<string>): boolean {
    const token = this.peek();
    return !token || stopValues.has(token.value);
  }

  private parsePrefix(stopValues: Set<string>): VerilogExpressionAst | undefined {
    const token = this.peek();
    if (!token || stopValues.has(token.value)) {
      return undefined;
    }
    if (prefixOperators.has(token.value)) {
      this.consume();
      const argument = this.parseExpression(prefixBindingPower, stopValues);
      return {
        kind: 'unaryExpression',
        operator: token.value,
        argument: argument ?? this.missingExpression('expression'),
        start: token.start,
        end: (argument ?? token).end
      };
    }
    return this.parsePrimary(stopValues);
  }

  private parsePrimary(stopValues: Set<string>): VerilogExpressionAst | undefined {
    const token = this.peek();
    if (!token || stopValues.has(token.value)) {
      return undefined;
    }

    if (token.kind === 'number') {
      this.consume();
      return {
        kind: 'numberLiteral',
        raw: token.value,
        parsed: parseVerilogNumberLiteral(token.value),
        start: token.start,
        end: token.end
      };
    }

    if (token.kind === 'string') {
      this.consume();
      return {
        kind: 'stringLiteral',
        raw: token.value,
        start: token.start,
        end: token.end
      };
    }

    if (token.kind === 'systemIdentifier' || isIdentifierLike(token.kind)) {
      this.consume();
      if (this.peek()?.value === '(') {
        return this.parseCall(token);
      }
      return {
        kind: 'identifier',
        name: token.value,
        start: token.start,
        end: token.end
      };
    }

    if (token.value === '(') {
      return this.parseParenthesized();
    }

    if (token.value === '{') {
      return this.parseConcatenation();
    }

    this.consume();
    return this.errorExpression(`Unexpected token '${token.value}' in expression.`, token.start, token.end, [], token.value);
  }

  private parsePostfix(expression: VerilogExpressionAst): VerilogExpressionAst {
    let current = expression;
    while (true) {
      const token = this.peek();
      if (!token) {
        return current;
      }
      if (token.value === '[') {
        const selected = this.parseSelect(current);
        if (!selected) {
          return current;
        }
        current = selected;
        continue;
      }
      if (token.value === '.') {
        const member = this.parseMember(current);
        if (!member) {
          return current;
        }
        current = member;
        continue;
      }
      return current;
    }
  }

  private parseParenthesized(): VerilogExpressionAst | undefined {
    const open = this.consume();
    const expression = this.parseExpression(0, new Set([')']));
    if (!open) {
      return undefined;
    }
    const close = this.peek()?.value === ')' ? this.consume() : undefined;
    const missing = close ? undefined : [this.missingToken(')', expression?.end ?? open.end)];
    return {
      kind: 'parenthesizedExpression',
      expression: expression ?? this.missingExpression('expression'),
      start: open.start,
      end: close?.end ?? expression?.end ?? open.end,
      missing
    };
  }

  private parseCall(callee: VerilogToken): VerilogExpressionAst | undefined {
    const open = this.consume();
    if (!open || open.value !== '(') {
      return undefined;
    }
    const args: VerilogExpressionAst[] = [];
    while (this.peek() && this.peek()?.value !== ')') {
      const arg = this.parseExpression(0, new Set([',', ')']));
      if (arg) {
        args.push(arg);
      }
      if (this.peek()?.value === ',') {
        this.consume();
        continue;
      }
      break;
    }
    const close = this.peek()?.value === ')' ? this.consume() : undefined;
    const missing = close ? undefined : [this.missingToken(')', args[args.length - 1]?.end ?? open.end)];
    return {
      kind: 'callExpression',
      callee: callee.value,
      system: callee.kind === 'systemIdentifier',
      args,
      start: callee.start,
      end: close?.end ?? args[args.length - 1]?.end ?? open.end,
      missing
    };
  }

  private parseConcatenation(): VerilogExpressionAst | undefined {
    const open = this.consume();
    if (!open || open.value !== '{') {
      return undefined;
    }
    const first = this.parseExpression(0, new Set([',', '}'])) ?? this.missingExpression('expression');

    if (this.peek()?.value === '{') {
      this.consume();
      const elements = this.parseExpressionList('}');
      const innerClose = this.peek()?.value === '}' ? this.consume() : undefined;
      const outerClose = this.peek()?.value === '}' ? this.consume() : undefined;
      const lastEnd = innerClose?.end ?? elements?.[elements.length - 1]?.end ?? first.end;
      const missing = [
        ...(innerClose ? [] : [this.missingToken('}', lastEnd)]),
        ...(outerClose ? [] : [this.missingToken('}', lastEnd)])
      ];
      return {
        kind: 'multipleConcatenation',
        repeat: first,
        elements: elements ?? [this.missingExpression('expression')],
        start: open.start,
        end: outerClose?.end ?? innerClose?.end ?? lastEnd,
        missing: missing.length ? missing : undefined
      };
    }

    const elements = [first];
    while (this.peek()?.value === ',') {
      this.consume();
      const element = this.parseExpression(0, new Set([',', '}']));
      elements.push(element ?? this.missingExpression('expression'));
    }
    const close = this.peek()?.value === '}' ? this.consume() : undefined;
    const missing = close ? undefined : [this.missingToken('}', elements[elements.length - 1].end)];
    return {
      kind: 'concatenation',
      elements,
      start: open.start,
      end: close?.end ?? elements[elements.length - 1].end,
      missing
    };
  }

  private parseExpressionList(closeValue: string): VerilogExpressionAst[] | undefined {
    const elements: VerilogExpressionAst[] = [];
    while (this.peek() && this.peek()?.value !== closeValue) {
      const element = this.parseExpression(0, new Set([',', closeValue]));
      if (element) {
        elements.push(element);
      }
      if (this.peek()?.value === ',') {
        this.consume();
        continue;
      }
      break;
    }
    return elements.length ? elements : undefined;
  }

  private parseSelect(target: VerilogExpressionAst): VerilogExpressionAst | undefined {
    const open = this.consume();
    if (!open || open.value !== '[') {
      return undefined;
    }
    const first = this.parseExpression(0, new Set([']', ':', '+:', '-:'])) ?? this.missingExpression('expression');

    const separator = this.peek();
    if (separator?.value === ']') {
      const close = this.consume();
      return {
        kind: 'selectExpression',
        target,
        select: {
          kind: 'bitSelect',
          index: first,
          start: open.start,
          end: close?.end ?? first.end
        },
        start: target.start,
        end: close?.end ?? first.end
      };
    }

    if (separator?.value === ':') {
      this.consume();
      const right = this.parseExpression(0, new Set([']'])) ?? this.missingExpression('expression');
      const close = this.peek()?.value === ']' ? this.consume() : undefined;
      const missing = close ? undefined : [this.missingToken(']', right.end)];
      return {
        kind: 'selectExpression',
        target,
        select: {
          kind: 'rangeSelect',
          left: first,
          right,
          start: open.start,
          end: close?.end ?? right.end,
          missing
        },
        start: target.start,
        end: close?.end ?? right.end,
        missing
      };
    }

    const direction = this.readIndexedPartSelectDirection();
    if (direction) {
      const width = this.parseExpression(0, new Set([']'])) ?? this.missingExpression('expression');
      const close = this.peek()?.value === ']' ? this.consume() : undefined;
      const missing = close ? undefined : [this.missingToken(']', width.end)];
      return {
        kind: 'selectExpression',
        target,
        select: {
          kind: 'indexedPartSelect',
          base: first,
          direction,
          width,
          start: open.start,
          end: close?.end ?? width.end,
          missing
        },
        start: target.start,
        end: close?.end ?? width.end,
        missing
      };
    }

    const missing = [this.missingToken(']', first.end)];
    return {
      kind: 'selectExpression',
      target,
      select: {
        kind: 'bitSelect',
        index: first,
        start: open.start,
        end: first.end,
        missing
      },
      start: target.start,
      end: first.end,
      missing
    };
  }

  private parseMember(target: VerilogExpressionAst): VerilogExpressionAst | undefined {
    const dot = this.consume();
    const member = this.peek();
    if (!member || !isIdentifierLike(member.kind)) {
      return this.errorExpression('Expected member name after dot.', target.start, dot?.end ?? target.end, [target]);
    }
    this.consume();
    return {
      kind: 'memberExpression',
      target,
      member: member.value,
      start: target.start,
      end: member.end
    };
  }

  private readIndexedPartSelectDirection(): '+:' | '-:' | undefined {
    const token = this.peek();
    if (token?.value === '+:' || token?.value === '-:') {
      this.consume();
      return token.value;
    }
    if ((token?.value === '+' || token?.value === '-') && this.tokens[this.index + 1]?.value === ':') {
      this.consume();
      this.consume();
      return token.value === '+' ? '+:' : '-:';
    }
    return undefined;
  }

  private isSplitIndexedPartSelectSeparator(token: VerilogToken, stopValues: Set<string>): boolean {
    return (token.value === '+' || token.value === '-') &&
      this.tokens[this.index + 1]?.value === ':' &&
      (stopValues.has('+:') || stopValues.has('-:'));
  }

  private peek(): VerilogToken | undefined {
    return this.tokens[this.index];
  }

  private consume(): VerilogToken | undefined {
    return this.tokens[this.index++];
  }

  wrapUnexpectedTrailingTokens(expression: VerilogExpressionAst): VerilogExpressionAst {
    const token = this.peek();
    if (!token) {
      return expression;
    }
    return this.errorExpression(`Unexpected token '${token.value}' after expression.`, expression.start, lastToken(this.tokens).end, [expression], token.value);
  }

  private missingExpression(expected: string): VerilogErrorExpressionAst {
    const token = this.peek();
    if (token) {
      return this.errorExpression(`Expected ${expected}.`, token.start, token.start, [], undefined, [this.missingToken(expected, token.start)]);
    }
    const offset = this.currentOffset();
    return this.errorExpression(`Expected ${expected}.`, offset, offset, [], undefined, [this.missingToken(expected, offset)]);
  }

  private missingToken(expected: string, offset: number): VerilogMissingTokenAst {
    return {
      kind: 'missingToken',
      expected,
      message: `Missing token '${expected}'.`,
      start: offset,
      end: offset
    };
  }

  private errorExpression(
    message: string,
    start: number,
    end: number,
    children: VerilogExpressionAst[],
    unexpectedToken?: string,
    missing?: VerilogMissingTokenAst[]
  ): VerilogErrorExpressionAst {
    return {
      kind: 'errorExpression',
      message,
      children,
      unexpectedToken,
      missing,
      start,
      end
    };
  }

  private currentOffset(): number {
    return this.peek()?.start ?? this.tokens[this.index - 1]?.end ?? this.tokens[0]?.start ?? 0;
  }
}

function lastToken(tokens: VerilogToken[]): VerilogToken {
  return tokens[tokens.length - 1];
}

function leftAssociative(power: number): BinaryBindingPower {
  return { left: power, right: power + 1 };
}

function rightAssociative(power: number): BinaryBindingPower {
  return { left: power, right: power };
}

function withStop(values: Set<string>, value: string): Set<string> {
  const next = new Set(values);
  next.add(value);
  return next;
}

function allDecimalDigits(value: string): boolean {
  let sawDigit = false;
  for (const char of value) {
    if (char === '_') {
      continue;
    }
    if (char < '0' || char > '9') {
      return false;
    }
    sawDigit = true;
  }
  return sawDigit;
}

function decimalStringToNumber(value: string): number | undefined {
  if (!allDecimalDigits(value)) {
    return undefined;
  }
  const parsed = Number(value.split('_').join(''));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function decimalDigitsToBigInt(digits: string): bigint | undefined {
  try {
    return BigInt(digits);
  } catch {
    return undefined;
  }
}

function isBasedLiteralBase(char: string | undefined): char is 'b' | 'o' | 'd' | 'h' {
  return char === 'b' || char === 'o' || char === 'd' || char === 'h';
}

function basedDigitsToBigInt(base: 'b' | 'o' | 'd' | 'h', digits: string): bigint | undefined {
  if (/[xXzZ?]/.test(digits)) {
    return undefined;
  }
  try {
    if (base === 'd') {
      return BigInt(digits);
    }
    const radixPrefix = base === 'b' ? '0b' : base === 'o' ? '0o' : '0x';
    return BigInt(`${radixPrefix}${digits}`);
  } catch {
    return undefined;
  }
}

function evalUnaryConstant(operator: string, value: bigint | undefined, width: number | undefined): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }
  switch (operator) {
    case '+':
      return value;
    case '-':
      return -value;
    case '~':
      return width !== undefined ? (~value) & maskForWidth(width) : ~value;
    case '!':
      return value === 0n ? 1n : 0n;
    case '&':
      return width !== undefined && (value & maskForWidth(width)) === maskForWidth(width) ? 1n : 0n;
    case '|':
      return (width !== undefined ? (value & maskForWidth(width)) : value) !== 0n ? 1n : 0n;
    case '^':
      return reductionXor(width !== undefined ? (value & maskForWidth(width)) : value);
    case '~&':
      return evalUnaryConstant('&', value, width) === 1n ? 0n : 1n;
    case '~|':
      return evalUnaryConstant('|', value, width) === 1n ? 0n : 1n;
    case '~^':
    case '^~':
      return evalUnaryConstant('^', value, width) === 1n ? 0n : 1n;
    default:
      return undefined;
  }
}

function evalBinaryConstant(operator: string, left: bigint | undefined, right: bigint | undefined): bigint | undefined {
  if (left === undefined || right === undefined) {
    return undefined;
  }
  try {
    switch (operator) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        return right === 0n ? undefined : left / right;
      case '%':
        return right === 0n ? undefined : left % right;
      case '&':
        return left & right;
      case '|':
        return left | right;
      case '^':
      case '^~':
      case '~^':
        return operator === '^' ? left ^ right : ~(left ^ right);
      case '&&':
        return left !== 0n && right !== 0n ? 1n : 0n;
      case '||':
        return left !== 0n || right !== 0n ? 1n : 0n;
      case '==':
      case '===':
        return left === right ? 1n : 0n;
      case '!=':
      case '!==':
        return left !== right ? 1n : 0n;
      case '<':
        return left < right ? 1n : 0n;
      case '<=':
        return left <= right ? 1n : 0n;
      case '>':
        return left > right ? 1n : 0n;
      case '>=':
        return left >= right ? 1n : 0n;
      case '<<':
      case '<<<':
        return shiftLeft(left, right);
      case '>>':
      case '>>>':
        return shiftRight(left, right);
      case '**':
        return power(left, right);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function shiftLeft(left: bigint, right: bigint): bigint | undefined {
  if (right < 0n || right > 1024n) {
    return undefined;
  }
  return left << right;
}

function shiftRight(left: bigint, right: bigint): bigint | undefined {
  if (right < 0n || right > 1024n) {
    return undefined;
  }
  return left >> right;
}

function power(left: bigint, right: bigint): bigint | undefined {
  if (right < 0n || right > 128n) {
    return undefined;
  }
  return left ** right;
}

function evalCallConstant(
  expression: VerilogCallExpressionAst,
  resolveIdentifier?: VerilogConstantResolver,
  resolveWidth?: VerilogConstantWidthResolver
): bigint | undefined {
  const callee = normalizeSystemFunctionName(expression.callee);
  if ((callee === '$signed' || callee === '$unsigned') && expression.args.length === 1) {
    return evalVerilogIntegerConstant(expression.args[0], resolveIdentifier, resolveWidth);
  }
  if (callee === '$clog2' && expression.args.length === 1) {
    const value = evalVerilogIntegerConstant(expression.args[0], resolveIdentifier, resolveWidth);
    return value === undefined || value <= 0n ? undefined : clog2(value);
  }
  return undefined;
}

function evalConcatenationConstant(
  elements: VerilogExpressionAst[],
  resolveIdentifier?: VerilogConstantResolver,
  resolveWidth?: VerilogConstantWidthResolver
): bigint | undefined {
  let result = 0n;
  for (const element of elements) {
    const width = constantWidth(element, resolveIdentifier, resolveWidth);
    const value = evalVerilogIntegerConstant(element, resolveIdentifier, resolveWidth);
    if (width === undefined || value === undefined || width < 0) {
      return undefined;
    }
    result = (result << BigInt(width)) | (value & maskForWidth(width));
  }
  return result;
}

function evalMultipleConcatenationConstant(
  expression: VerilogMultipleConcatenationAst,
  resolveIdentifier?: VerilogConstantResolver,
  resolveWidth?: VerilogConstantWidthResolver
): bigint | undefined {
  const repeat = evalVerilogIntegerConstant(expression.repeat, resolveIdentifier, resolveWidth);
  const repeatedValue = evalConcatenationConstant(expression.elements, resolveIdentifier, resolveWidth);
  const repeatedWidth = constantWidthOfConcatenation(expression.elements, resolveIdentifier, resolveWidth);
  if (repeat === undefined || repeatedValue === undefined || repeatedWidth === undefined || repeat < 0n || repeat > 1024n) {
    return undefined;
  }
  let result = 0n;
  for (let index = 0n; index < repeat; index++) {
    result = (result << BigInt(repeatedWidth)) | (repeatedValue & maskForWidth(repeatedWidth));
  }
  return result;
}

function evalSelectConstant(
  expression: VerilogSelectExpressionAst,
  resolveIdentifier?: VerilogConstantResolver,
  resolveWidth?: VerilogConstantWidthResolver
): bigint | undefined {
  const target = evalVerilogIntegerConstant(expression.target, resolveIdentifier, resolveWidth);
  if (target === undefined) {
    return undefined;
  }
  switch (expression.select.kind) {
    case 'bitSelect': {
      const index = evalVerilogIntegerConstant(expression.select.index, resolveIdentifier, resolveWidth);
      return index === undefined || index < 0n || index > 4096n ? undefined : (target >> index) & 1n;
    }
    case 'rangeSelect': {
      const left = evalVerilogIntegerConstant(expression.select.left, resolveIdentifier, resolveWidth);
      const right = evalVerilogIntegerConstant(expression.select.right, resolveIdentifier, resolveWidth);
      if (left === undefined || right === undefined || left < 0n || right < 0n) {
        return undefined;
      }
      const low = left < right ? left : right;
      const width = absBigInt(left - right) + 1n;
      return width > 4096n ? undefined : (target >> low) & maskForWidth(Number(width));
    }
    case 'indexedPartSelect': {
      const base = evalVerilogIntegerConstant(expression.select.base, resolveIdentifier, resolveWidth);
      const width = evalVerilogIntegerConstant(expression.select.width, resolveIdentifier, resolveWidth);
      if (base === undefined || width === undefined || width <= 0n || width > 4096n) {
        return undefined;
      }
      const low = expression.select.direction === '+:' ? base : base - width + 1n;
      return low < 0n ? undefined : (target >> low) & maskForWidth(Number(width));
    }
    default:
      return undefined;
  }
}

function constantWidth(
  expression: VerilogExpressionAst,
  resolveIdentifier?: VerilogConstantResolver,
  resolveWidth?: VerilogConstantWidthResolver
): number | undefined {
  const resolved = resolveWidth?.(expression);
  if (resolved !== undefined) {
    return resolved;
  }
  switch (expression.kind) {
    case 'numberLiteral':
      return literalWidth(expression.parsed);
    case 'identifier':
      return undefined;
    case 'parenthesizedExpression':
      return constantWidth(expression.expression, resolveIdentifier, resolveWidth);
    case 'callExpression':
      return constantWidthOfCall(expression, resolveIdentifier, resolveWidth);
    case 'selectExpression':
      return constantWidthOfSelect(expression, resolveIdentifier, resolveWidth);
    case 'concatenation':
      return constantWidthOfConcatenation(expression.elements, resolveIdentifier, resolveWidth);
    case 'multipleConcatenation': {
      const repeat = evalVerilogIntegerConstant(expression.repeat, resolveIdentifier, resolveWidth);
      const repeated = constantWidthOfConcatenation(expression.elements, resolveIdentifier, resolveWidth);
      return repeat === undefined || repeat < 0n || repeat > 1024n || repeated === undefined
        ? undefined
        : Number(repeat) * repeated;
    }
    case 'conditionalExpression': {
      const trueWidth = constantWidth(expression.whenTrue, resolveIdentifier, resolveWidth);
      const falseWidth = constantWidth(expression.whenFalse, resolveIdentifier, resolveWidth);
      return trueWidth === undefined || falseWidth === undefined ? trueWidth ?? falseWidth : Math.max(trueWidth, falseWidth);
    }
    case 'unaryExpression':
      return isReductionOperator(expression.operator) ? 1 : constantWidth(expression.argument, resolveIdentifier, resolveWidth);
    case 'binaryExpression':
      if (isComparisonOperator(expression.operator) || expression.operator === '&&' || expression.operator === '||') {
        return 1;
      }
      if (expression.operator === '<<' || expression.operator === '>>' || expression.operator === '<<<' || expression.operator === '>>>') {
        return constantWidth(expression.left, resolveIdentifier, resolveWidth);
      }
      return maxDefined(
        constantWidth(expression.left, resolveIdentifier, resolveWidth),
        constantWidth(expression.right, resolveIdentifier, resolveWidth)
      );
    case 'errorExpression':
      return undefined;
    default:
      return undefined;
  }
}

function constantWidthOfCall(
  expression: VerilogCallExpressionAst,
  resolveIdentifier?: VerilogConstantResolver,
  resolveWidth?: VerilogConstantWidthResolver
): number | undefined {
  const callee = normalizeSystemFunctionName(expression.callee);
  if ((callee === '$signed' || callee === '$unsigned') && expression.args.length === 1) {
    return constantWidth(expression.args[0], resolveIdentifier, resolveWidth);
  }
  if (callee === '$clog2' && expression.args.length === 1) {
    return 32;
  }
  return undefined;
}

function constantWidthOfSelect(
  expression: VerilogSelectExpressionAst,
  resolveIdentifier?: VerilogConstantResolver,
  resolveWidth?: VerilogConstantWidthResolver
): number | undefined {
  switch (expression.select.kind) {
    case 'bitSelect':
      return 1;
    case 'rangeSelect': {
      const left = evalVerilogIntegerConstant(expression.select.left, resolveIdentifier, resolveWidth);
      const right = evalVerilogIntegerConstant(expression.select.right, resolveIdentifier, resolveWidth);
      return left === undefined || right === undefined ? undefined : Number(absBigInt(left - right) + 1n);
    }
    case 'indexedPartSelect': {
      const width = evalVerilogIntegerConstant(expression.select.width, resolveIdentifier, resolveWidth);
      return width === undefined || width < 0n || width > 4096n ? undefined : Number(width);
    }
    default:
      return undefined;
  }
}

function constantWidthOfConcatenation(
  elements: VerilogExpressionAst[],
  resolveIdentifier?: VerilogConstantResolver,
  resolveWidth?: VerilogConstantWidthResolver
): number | undefined {
  let width = 0;
  for (const element of elements) {
    const elementWidth = constantWidth(element, resolveIdentifier, resolveWidth);
    if (elementWidth === undefined) {
      return undefined;
    }
    width += elementWidth;
  }
  return width;
}

function literalWidth(parsed: ParsedVerilogNumberLiteral | undefined): number | undefined {
  if (!parsed) {
    return undefined;
  }
  if (parsed.kind === 'based') {
    return parsed.size ?? Math.max(32, minWidthOfBasedDigits(parsed.base, parsed.digits));
  }
  return Math.max(32, minimalBitsForInteger(parsed.value));
}

function minWidthOfBasedDigits(base: string, digits: string): number {
  if (base === 'b') {
    return Math.max(1, digits.length);
  }
  if (base === 'o') {
    return Math.max(1, digits.length * 3);
  }
  if (base === 'h') {
    return Math.max(1, digits.length * 4);
  }
  return minimalBitsForDecimalText(digits);
}

function minimalBitsForDecimalText(text: string): number {
  try {
    return minimalBitsForInteger(BigInt(text));
  } catch {
    return 32;
  }
}

function minimalBitsForInteger(value: bigint | undefined): number {
  if (value === undefined) {
    return 32;
  }
  if (value === 0n) {
    return 1;
  }
  const magnitude = value < 0n ? -value : value;
  return magnitude.toString(2).length;
}

function maskForWidth(width: number): bigint {
  if (width <= 0) {
    return 0n;
  }
  return (1n << BigInt(width)) - 1n;
}

function reductionXor(value: bigint): bigint {
  let current = value < 0n ? -value : value;
  let parity = 0n;
  while (current !== 0n) {
    parity ^= current & 1n;
    current >>= 1n;
  }
  return parity;
}

function clog2(value: bigint): bigint {
  let result = 0n;
  let current = value - 1n;
  while (current > 0n) {
    current >>= 1n;
    result++;
  }
  return result;
}

function normalizeSystemFunctionName(value: string): string {
  return value.startsWith('$') ? value : `$${value}`;
}

function isReductionOperator(operator: string): boolean {
  return operator === '&' || operator === '|' || operator === '^' || operator === '~&' || operator === '~|' || operator === '~^' || operator === '^~';
}

function isComparisonOperator(operator: string): boolean {
  return operator === '===' || operator === '!==' || operator === '==' || operator === '!=' || operator === '<=' || operator === '>=' || operator === '<' || operator === '>';
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.max(left, right);
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}
