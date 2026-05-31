import { VerilogDecl, VerilogModule } from './model';
import {
  isWrappedByParens,
  splitTernary,
  splitTopLevelCommaSpans,
  splitTopLevelOperator,
  stripCommentsAndStrings
} from './textUtils';

export interface WidthInfo {
  width?: number;
  minWidth?: number;
  flexible?: boolean;
}

export function widthOfDecl(decl: VerilogDecl): WidthInfo {
  const rangeWidth = widthFromRange(decl.width);
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
  let text = stripCommentsAndStrings(expression).trim();
  while (isWrappedByParens(text)) {
    text = text.slice(1, -1).trim();
  }
  if (!text) {
    return {};
  }

  const ternary = splitTernary(text);
  if (ternary) {
    return maxWidth(widthOfExpression(ternary.whenTrue, module), widthOfExpression(ternary.whenFalse, module));
  }

  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim();
    const repeat = inner.match(/^(\d+)\s*\{([\s\S]*)\}$/);
    if (repeat) {
      const count = Number(repeat[1]);
      const repeated = widthOfExpression(repeat[2], module).width;
      return repeated !== undefined ? { width: count * repeated } : {};
    }
    let width = 0;
    for (const part of splitTopLevelCommaSpans(inner)) {
      const partWidth = widthOfExpression(part.text, module).width;
      if (partWidth === undefined) {
        return {};
      }
      width += partWidth;
    }
    return { width };
  }

  const shifted = splitTopLevelOperator(text, ['<<<', '>>>', '<<', '>>']);
  if (shifted) {
    return widthOfExpression(shifted.left, module);
  }

  const comparison = splitTopLevelOperator(text, ['==', '!=', '<=', '>=', '<', '>', '&&', '||']);
  if (comparison) {
    return { width: 1 };
  }

  const binary = splitTopLevelOperator(text, ['+', '-', '^', '|', '&', '*', '/', '%']);
  if (binary) {
    return maxWidth(widthOfExpression(binary.left, module), widthOfExpression(binary.right, module));
  }

  if (/^[!~&|^]+/.test(text)) {
    const operator = text.match(/^[!~&|^]+/)?.[0] ?? '';
    const operand = widthOfExpression(text.slice(operator.length), module);
    return operator === '~' ? operand : { width: 1 };
  }

  const rangeMatch = text.match(/^([A-Za-z_]\w*)\s*\[\s*(\d+)\s*(?::\s*(\d+)\s*)?\]$/);
  if (rangeMatch) {
    if (rangeMatch[3] !== undefined) {
      return { width: Math.abs(Number(rangeMatch[2]) - Number(rangeMatch[3])) + 1 };
    }
    return { width: 1 };
  }

  const literal = literalWidth(text);
  if (literal.width !== undefined) {
    return literal;
  }

  const identifier = text.match(/^[A-Za-z_]\w*$/);
  if (identifier) {
    const decl = module.declarations.get(identifier[0]);
    return decl ? widthOfDecl(decl) : {};
  }

  return {};
}

export function widthOfConstantInitializer(expression: string): WidthInfo {
  let text = stripCommentsAndStrings(expression).trim();
  while (isWrappedByParens(text)) {
    text = text.slice(1, -1).trim();
  }
  if (!text) {
    return {};
  }

  const ternary = splitTernary(text);
  if (ternary) {
    return maxWidth(widthOfConstantInitializer(ternary.whenTrue), widthOfConstantInitializer(ternary.whenFalse));
  }

  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim();
    const repeat = inner.match(/^(\d+)\s*\{([\s\S]*)\}$/);
    if (repeat) {
      const count = Number(repeat[1]);
      const repeated = widthOfConstantInitializer(repeat[2]).width;
      return repeated !== undefined ? { width: count * repeated } : {};
    }
    let width = 0;
    for (const part of splitTopLevelCommaSpans(inner)) {
      const partWidth = widthOfConstantInitializer(part.text).width;
      if (partWidth === undefined) {
        return {};
      }
      width += partWidth;
    }
    return { width };
  }

  const shifted = splitTopLevelOperator(text, ['<<<', '>>>', '<<', '>>']);
  if (shifted) {
    return widthOfConstantInitializer(shifted.left);
  }

  const comparison = splitTopLevelOperator(text, ['==', '!=', '<=', '>=', '<', '>', '&&', '||']);
  if (comparison) {
    return { width: 1 };
  }

  const binary = splitTopLevelOperator(text, ['+', '-', '^', '|', '&', '*', '/', '%']);
  if (binary) {
    return maxWidth(widthOfConstantInitializer(binary.left), widthOfConstantInitializer(binary.right));
  }

  const sign = text.match(/^[+-]\s*([\s\S]+)$/);
  if (sign) {
    return widthOfConstantInitializer(sign[1]);
  }

  if (/^[!~&|^]+/.test(text)) {
    const operator = text.match(/^[!~&|^]+/)?.[0] ?? '';
    const operand = widthOfConstantInitializer(text.slice(operator.length));
    return operator === '~' ? operand : { width: 1 };
  }

  return literalWidth(text);
}

export function shouldReportWidthMismatch(expected: WidthInfo, actual: WidthInfo): boolean {
  if (!expected.width || !actual.width || expected.width === actual.width) {
    return false;
  }
  if (actual.flexible && (actual.minWidth ?? actual.width) <= expected.width) {
    return false;
  }
  return true;
}

function widthFromRange(width?: string): number | undefined {
  if (!width) {
    return undefined;
  }
  const match = width.match(/^\[\s*(\d+)\s*:\s*(\d+)\s*\]$/);
  if (!match) {
    return undefined;
  }
  return Math.abs(Number(match[1]) - Number(match[2])) + 1;
}

function literalWidth(text: string): WidthInfo {
  const based = text.match(/^(\d+)?\s*'\s*[sS]?\s*([bBoOdDhH])\s*([0-9a-fA-F_xXzZ?]+)$/);
  if (based) {
    if (based[1]) {
      return { width: Number(based[1]) };
    }
    const digits = based[3].replace(/_/g, '');
    const base = based[2].toLowerCase();
    const bitsPerDigit = base === 'b' ? 1 : base === 'o' ? 3 : base === 'h' ? 4 : undefined;
    const minWidth = bitsPerDigit ? Math.max(1, digits.length * bitsPerDigit) : minimalBitsForDecimal(digits);
    return { width: Math.max(32, minWidth), minWidth, flexible: true };
  }
  if (/^\d+$/.test(text)) {
    const minWidth = minimalBitsForDecimal(text);
    return { width: Math.max(32, minWidth), minWidth, flexible: true };
  }
  return {};
}

function minimalBitsForDecimal(text: string): number {
  try {
    const value = BigInt(text);
    if (value === 0n) {
      return 1;
    }
    return value.toString(2).length;
  } catch {
    return 32;
  }
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
