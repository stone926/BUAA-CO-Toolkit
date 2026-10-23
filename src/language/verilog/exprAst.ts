// @index expr-ast — 递归下降表达式解析器，40+节点类型AST
import { evaluateIntegralConstant, integralConstant, integerConstantValue, VERILOG_EVALUATION_LIMITS } from './typedConstants';
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
      kind: 'real';
      digits: string;
      value?: undefined;
    }
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
  const result = parser.isAtEnd(new Set()) ? expression : parser.wrapUnexpectedTrailingTokens(expression);
  if (!expressionWithinBudget(result)) {
    return { kind: 'errorExpression', message: 'Expression exceeds analysis budget.', children: [], start: result.start, end: result.end };
  }
  return result;
}

function expressionWithinBudget(expression: VerilogExpressionAst): boolean {
  const pending: { node: unknown; depth: number }[] = [{ node: expression, depth: 0 }];
  let steps = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++steps > VERILOG_EVALUATION_LIMITS.steps || depth > VERILOG_EVALUATION_LIMITS.depth) { return false; }
    if (!node || typeof node !== 'object') { continue; }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) { for (const item of child) { if (item && typeof item === 'object') { pending.push({ node: item, depth: depth + 1 }); } } }
      else if (child && typeof child === 'object') { pending.push({ node: child, depth: depth + 1 }); }
    }
  }
  return true;
}

export function verilogExpressionHasError(expression: VerilogExpressionAst | undefined): boolean {
  const pending: { node: VerilogExpressionAst; depth: number }[] = expression ? [{ node: expression, depth: 0 }] : [];
  let steps = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++steps > VERILOG_EVALUATION_LIMITS.steps || depth >= VERILOG_EVALUATION_LIMITS.depth || node.kind === 'errorExpression' || node.missing?.length) { return true; }
    const add = (...nodes: VerilogExpressionAst[]) => { for (const child of nodes) { pending.push({ node: child, depth: depth + 1 }); } };
    switch (node.kind) {
      case 'parenthesizedExpression': add(node.expression); break;
      case 'unaryExpression': add(node.argument); break;
      case 'binaryExpression': add(node.left, node.right); break;
      case 'conditionalExpression': add(node.condition, node.whenTrue, node.whenFalse); break;
      case 'concatenation': add(...node.elements); break;
      case 'multipleConcatenation': add(node.repeat, ...node.elements); break;
      case 'selectExpression': {
        add(node.target); const select = node.select;
        if (select.missing?.length) { return true; }
        if (select.kind === 'bitSelect') { add(select.index); }
        else if (select.kind === 'rangeSelect') { add(select.left, select.right); }
        else { add(select.base, select.width); } break;
      }
      case 'callExpression': add(...node.args); break;
      case 'memberExpression': add(node.target); break;
    }
  }
  return false;
}

export function parseVerilogNumberLiteral(value: string): ParsedVerilogNumberLiteral | undefined {
  value = value.replace(/\s+/g, '');
  if (/^[0-9][0-9_]*(?:\.[0-9][0-9_]*(?:[eE][+-]?[0-9][0-9_]*)?|[eE][+-]?[0-9][0-9_]*)$/.test(value)) {
    // Real values participate in parsing/references, not integer folding or bit widths.
    return { kind: 'real', digits: value.replace(/_/g, '') };
  }
  const apostrophe = value.indexOf("'");
  if (apostrophe < 0) {
    if (!allDecimalDigits(value)) {
      return undefined;
    }
    const digits = value.split('_').join('');
    if (digits.length > VERILOG_EVALUATION_LIMITS.bits) { return { kind: 'decimal', digits }; }
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
  const validDigits = base === 'b' ? /^[01xz?]+$/i : base === 'o' ? /^[0-7xz?]+$/i : base === 'h' ? /^[0-9a-fxz?]+$/i : /^(?:[0-9]+|[xz?]+)$/i;
  if (!validDigits.test(digits) || size === 0) {
    return undefined;
  }
  return {
    kind: 'based',
    size,
    signed,
    base,
    digits,
    value: digits.length > VERILOG_EVALUATION_LIMITS.bits ? undefined : basedDigitsToBigInt(base, digits)
  };
}

export function evalVerilogIntegerConstant(
  expression: VerilogExpressionAst,
  resolveIdentifier?: VerilogConstantResolver,
  resolveWidth?: VerilogConstantWidthResolver
): bigint | undefined {
  return integerConstantValue(evaluateIntegralConstant(expression, {
    identifier: (name) => { const value = resolveIdentifier?.(name); const width = resolveWidth?.({ kind: 'identifier', name, start: 0, end: 0 }) ?? 32; return value === undefined ? undefined : integralConstant(value, width, value < 0n); },
    type: (node) => { if (node.kind !== 'identifier') { return undefined; } const width = resolveWidth?.(node); return width === undefined ? undefined : { width, signed: (resolveIdentifier?.(node.name) ?? 0n) < 0n }; }
  }));
}

function tokenizeExpression(text: string): VerilogToken[] {
  return lexVerilog(text).tokens.filter((token) => token.kind !== 'comment' && token.kind !== 'eof');
}

class ExpressionParser {
  private index = 0;
  private depth = 0;
  private steps = 0;

  constructor(private readonly tokens: VerilogToken[]) {}

  parseExpression(minBindingPower: number, stopValues: Set<string>): VerilogExpressionAst | undefined {
    if (++this.steps > VERILOG_EVALUATION_LIMITS.steps || this.depth >= VERILOG_EVALUATION_LIMITS.depth) {
      const start = this.currentOffset();
      this.index = this.tokens.length;
      return this.errorExpression('Expression exceeds analysis budget.', start, this.currentOffset(), []);
    }
    this.depth++;
    try { return this.parseExpressionInner(minBindingPower, stopValues); } finally { this.depth--; }
  }

  private parseExpressionInner(minBindingPower: number, stopValues: Set<string>): VerilogExpressionAst | undefined {
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
