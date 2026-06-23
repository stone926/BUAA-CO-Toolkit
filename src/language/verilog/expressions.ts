import {
  evalVerilogIntegerConstant,
  parseVerilogExpression,
  ParsedVerilogNumberLiteral,
  VerilogConstantResolver,
  VerilogExpressionAst
} from './exprAst';
import { VerilogDecl, VerilogModule } from './model';

export interface WidthInfo {
  width?: number;
  minWidth?: number;
  flexible?: boolean;
}

export type VerilogConstantOverrides = ReadonlyMap<string, bigint>;

export function widthOfDecl(decl: VerilogDecl, module?: VerilogModule, overrides?: VerilogConstantOverrides): WidthInfo {
  const rangeWidth = widthFromRange(decl.width, module, overrides);
  if (rangeWidth !== undefined) {
    return { width: rangeWidth };
  }
  if (decl.inferredWidth !== undefined) {
    const inferred: WidthInfo = { width: decl.inferredWidth };
    if (decl.inferredMinWidth !== undefined) {
      inferred.minWidth = decl.inferredMinWidth;
    }
    if (decl.inferredFlexible !== undefined) {
      inferred.flexible = decl.inferredFlexible;
    }
    return inferred;
  }
  if (decl.kind === 'integer' || decl.kind === 'time') {
    return { width: 32 };
  }
  return { width: 1 };
}

export function widthOfExpression(expression: string, module: VerilogModule): WidthInfo {
  return widthOfExpressionAst(parseVerilogExpression(expression), module);
}

export function widthOfConstantInitializer(expression: string): WidthInfo {
  return widthOfExpressionAst(parseVerilogExpression(expression), undefined);
}

export function shouldReportWidthMismatch(expected: WidthInfo, actual: WidthInfo): boolean {
  if (!expected.width || !actual.width) {
    return false;
  }
  // Only flag truncation: assigning a narrower value to a wider target is normal
  // zero/sign-extension. Flexible arithmetic widths compare by their meaningful minimum.
  const actualMinimum = actual.flexible ? (actual.minWidth ?? actual.width) : actual.width;
  return actualMinimum > expected.width;
}

export function widthOfExpressionAst(expression: VerilogExpressionAst | undefined, module: VerilogModule | undefined, overrides?: VerilogConstantOverrides): WidthInfo {
  if (!expression) {
    return {};
  }
  switch (expression.kind) {
    case 'numberLiteral':
      return literalWidth(expression.parsed);
    case 'stringLiteral':
      return {};
    case 'identifier':
      return module ? widthOfIdentifier(expression.name, module, overrides) : {};
    case 'memberExpression':
      return {};
    case 'parenthesizedExpression':
      return widthOfExpressionAst(expression.expression, module, overrides);
    case 'callExpression':
      return widthOfCall(expression, module, overrides);
    case 'selectExpression':
      return widthOfSelect(expression, module, overrides);
    case 'concatenation':
      return widthOfConcatenation(expression.elements, module, overrides);
    case 'multipleConcatenation':
      return widthOfMultipleConcatenation(expression, module, overrides);
    case 'conditionalExpression':
      return maxWidth(
        widthOfExpressionAst(expression.whenTrue, module, overrides),
        widthOfExpressionAst(expression.whenFalse, module, overrides)
      );
    case 'unaryExpression': {
      const operand = widthOfExpressionAst(expression.argument, module, overrides);
      if (expression.operator === '~' || expression.operator === '+' || expression.operator === '-') {
        return operand;
      }
      return { width: 1 };
    }
    case 'binaryExpression':
      if (isShiftOperator(expression.operator)) {
        return flexibleWidth(widthOfExpressionAst(expression.left, module, overrides));
      }
      if (isOneBitBinaryOperator(expression.operator)) {
        return { width: 1 };
      }
      return binaryOperatorWidth(
        widthOfExpressionAst(expression.left, module, overrides),
        widthOfExpressionAst(expression.right, module, overrides)
      );
    default:
      return {};
  }
}

export function evalExpressionConstant(expression: string, module?: VerilogModule): bigint | undefined {
  return evalExpressionAstConstant(parseVerilogExpression(expression), module);
}

export function evalExpressionAstConstant(expression: VerilogExpressionAst | undefined, module?: VerilogModule, overrides?: VerilogConstantOverrides): bigint | undefined {
  if (!expression) {
    return undefined;
  }
  return evalVerilogIntegerConstant(expression, module ? constantResolverForModule(module, overrides) : undefined);
}

function widthFromRange(width: string | undefined, module?: VerilogModule, overrides?: VerilogConstantOverrides): number | undefined {
  if (!width) {
    return undefined;
  }
  const inner = bracketContents(width);
  if (inner === undefined) {
    return undefined;
  }
  const separator = topLevelRangeColon(inner);
  if (separator < 0) {
    return undefined;
  }
  const left = parseVerilogExpression(inner.slice(0, separator));
  const right = parseVerilogExpression(inner.slice(separator + 1));
  const leftValue = constNumber(left, module, overrides);
  const rightValue = constNumber(right, module, overrides);
  return leftValue === undefined || rightValue === undefined
    ? undefined
    : Math.abs(leftValue - rightValue) + 1;
}

function widthOfIdentifier(name: string, module: VerilogModule, overrides?: VerilogConstantOverrides): WidthInfo {
  const decl = module.declarations.get(name);
  return decl ? widthOfDecl(decl, module, overrides) : {};
}

function widthOfCall(expression: Extract<VerilogExpressionAst, { kind: 'callExpression' }>, module: VerilogModule | undefined, overrides?: VerilogConstantOverrides): WidthInfo {
  if (passThroughSystemFunction(expression.callee) && expression.args.length === 1) {
    return widthOfExpressionAst(expression.args[0], module, overrides);
  }
  return {};
}

function widthOfSelect(expression: Extract<VerilogExpressionAst, { kind: 'selectExpression' }>, module: VerilogModule | undefined, overrides?: VerilogConstantOverrides): WidthInfo {
  switch (expression.select.kind) {
    case 'bitSelect':
      return { width: 1 };
    case 'rangeSelect': {
      const left = constNumber(expression.select.left, module, overrides);
      const right = constNumber(expression.select.right, module, overrides);
      return left === undefined || right === undefined ? {} : { width: Math.abs(left - right) + 1 };
    }
    case 'indexedPartSelect': {
      const width = constNumber(expression.select.width, module, overrides);
      return width === undefined ? {} : { width };
    }
    default:
      return widthOfExpressionAst(expression.target, module, overrides);
  }
}

function widthOfConcatenation(elements: VerilogExpressionAst[], module: VerilogModule | undefined, overrides?: VerilogConstantOverrides): WidthInfo {
  let width = 0;
  for (const element of elements) {
    const elementWidth = widthOfExpressionAst(element, module, overrides).width;
    if (elementWidth === undefined) {
      return {};
    }
    width += elementWidth;
  }
  return { width };
}

function widthOfMultipleConcatenation(
  expression: Extract<VerilogExpressionAst, { kind: 'multipleConcatenation' }>,
  module: VerilogModule | undefined,
  overrides?: VerilogConstantOverrides
): WidthInfo {
  const repeat = constNumber(expression.repeat, module, overrides);
  if (repeat === undefined || repeat < 0) {
    return {};
  }
  const repeated = widthOfConcatenation(expression.elements, module, overrides).width;
  return repeated === undefined ? {} : { width: repeat * repeated };
}

function literalWidth(parsed: ParsedVerilogNumberLiteral | undefined): WidthInfo {
  if (!parsed) {
    return {};
  }
  if (parsed.kind === 'based') {
    if (parsed.size !== undefined) {
      return { width: parsed.size };
    }
    const minWidth = minWidthOfBasedDigits(parsed.base, parsed.digits);
    return { width: Math.max(32, minWidth), minWidth };
  }
  const minWidth = minimalBitsForInteger(parsed.value);
  return { width: Math.max(32, minWidth), minWidth };
}

function constNumber(expression: VerilogExpressionAst | undefined, module?: VerilogModule, overrides?: VerilogConstantOverrides): number | undefined {
  if (!expression) {
    return undefined;
  }
  const value = evalExpressionAstConstant(expression, module, overrides);
  return value !== undefined && value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
    ? Number(value)
    : undefined;
}

function constantResolverForModule(module: VerilogModule, overrides?: VerilogConstantOverrides): VerilogConstantResolver {
  const evaluating = new Set<string>();
  const resolve: VerilogConstantResolver = (name) => {
    const override = overrides?.get(name);
    if (override !== undefined) {
      return override;
    }
    const decl = module.declarations.get(name);
    if (!decl) {
      return undefined;
    }
    if (!overrides && decl.constantValue !== undefined) {
      return decl.constantValue;
    }
    if ((decl.kind !== 'parameter' && decl.kind !== 'localparam') || !decl.initializer || evaluating.has(name)) {
      return decl.constantValue;
    }
    evaluating.add(name);
    const expression = decl.initializerAst ?? parseVerilogExpression(decl.initializer);
    const value = expression ? evalVerilogIntegerConstant(expression, resolve) : undefined;
    evaluating.delete(name);
    return value ?? decl.constantValue;
  };
  return resolve;
}

function bracketContents(width: string): string | undefined {
  const trimmed = width.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : undefined;
}

function topLevelRangeColon(text: string): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let nestedTernary = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') {
      paren++;
    } else if (char === ')') {
      paren = Math.max(0, paren - 1);
    } else if (char === '[') {
      bracket++;
    } else if (char === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (char === '{') {
      brace++;
    } else if (char === '}') {
      brace = Math.max(0, brace - 1);
    }
    if (paren !== 0 || bracket !== 0 || brace !== 0) {
      continue;
    }
    if (char === '?') {
      nestedTernary++;
    } else if (char === ':') {
      if (nestedTernary > 0) {
        nestedTernary--;
      } else {
        return index;
      }
    }
  }
  return -1;
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

function isShiftOperator(operator: string): boolean {
  return operator === '<<<' || operator === '>>>' || operator === '<<' || operator === '>>';
}

function isOneBitBinaryOperator(operator: string): boolean {
  return operator === '===' ||
    operator === '!==' ||
    operator === '==' ||
    operator === '!=' ||
    operator === '<=' ||
    operator === '>=' ||
    operator === '<' ||
    operator === '>' ||
    operator === '&&' ||
    operator === '||';
}

function passThroughSystemFunction(value: string): boolean {
  return value === '$signed' || value === '$unsigned';
}

// Verilog arithmetic/bitwise/shift results are context-sized in assignments. Treat them as
// flexible so a wider LHS can capture the mathematically wider result without a false truncation.
function binaryOperatorWidth(left: WidthInfo, right: WidthInfo): WidthInfo {
  if (left.width === undefined && right.width === undefined) {
    return {};
  }
  const leftWidth = left.width ?? right.width ?? 0;
  const rightWidth = right.width ?? left.width ?? 0;
  const minWidth = Math.max(left.minWidth ?? leftWidth, right.minWidth ?? rightWidth);
  return { width: Math.max(leftWidth, rightWidth), minWidth, flexible: true };
}

function flexibleWidth(info: WidthInfo): WidthInfo {
  if (info.width === undefined) {
    return {};
  }
  return { width: info.width, minWidth: info.minWidth ?? info.width, flexible: true };
}

function maxWidth(left: WidthInfo, right: WidthInfo): WidthInfo {
  if (left.width === undefined) {
    return right;
  }
  if (right.width === undefined) {
    return left;
  }
  const width = Math.max(left.width, right.width);
  const minWidth = Math.max(left.minWidth ?? left.width, right.minWidth ?? right.width);
  const flexible = Boolean(left.flexible || right.flexible);
  const result: WidthInfo = { width };
  if (flexible || minWidth !== width) {
    result.minWidth = minWidth;
  }
  if (flexible) {
    result.flexible = true;
  }
  return result;
}
