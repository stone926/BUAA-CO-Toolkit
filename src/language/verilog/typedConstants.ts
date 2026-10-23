// @index verilog-typed-constants — bounded four-state, width- and signedness-aware integral constant evaluation
import type { ParsedVerilogNumberLiteral, VerilogExpressionAst } from './exprAst';

export const VERILOG_EVALUATION_LIMITS = Object.freeze({ bits: 4096, depth: 128, steps: 16384 });
export interface VerilogIntegralType { width: number; signed: boolean; }
export interface VerilogIntegralConstant extends VerilogIntegralType {
  /** Unsigned bit pattern; signed interpretation is exposed by integerConstantValue. */
  bits: bigint;
  packedRange?: { left: number; right: number };
  xMask: bigint;
  zMask: bigint;
}
export interface VerilogEvaluationContext {
  steps: number;
  depth: number;
  types?: WeakMap<VerilogExpressionAst, VerilogIntegralType | undefined>;
  identifiers?: WeakMap<VerilogExpressionAst, VerilogIntegralConstant | undefined>;
}
export interface VerilogTypedResolver {
  /** Values after enclosing width/signedness context has been applied. */
  onValue?(expression: VerilogExpressionAst, value: VerilogIntegralConstant): void;
  identifier?(name: string, context: VerilogEvaluationContext, expression: VerilogExpressionAst): VerilogIntegralConstant | undefined;
  type?(expression: VerilogExpressionAst): VerilogIntegralType | undefined;
}
export function validIntegralWidth(width: number | undefined): width is number {
  return width !== undefined && Number.isSafeInteger(width) && width > 0 && width <= VERILOG_EVALUATION_LIMITS.bits;
}
export function integralMask(width: number): bigint {
  return validIntegralWidth(width) ? (1n << BigInt(width)) - 1n : 0n;
}
export function integralConstant(value: bigint, width: number, signed: boolean): VerilogIntegralConstant | undefined {
  if (!validIntegralWidth(width)) { return undefined; }
  return { bits: value & integralMask(width), width, signed, xMask: 0n, zMask: 0n };
}
export function integerConstantValue(value: VerilogIntegralConstant | undefined): bigint | undefined {
  if (!value || value.xMask || value.zMask) { return undefined; }
  return value.signed && (value.bits & (1n << BigInt(value.width - 1))) !== 0n
    ? value.bits - (1n << BigInt(value.width)) : value.bits;
}
export function resizeIntegralConstant(value: VerilogIntegralConstant, width: number, signed: boolean, signExtend = value.signed): VerilogIntegralConstant | undefined {
  if (!validIntegralWidth(width)) { return undefined; }
  const mask = integralMask(width);
  const extension = width > value.width && signExtend ? mask ^ integralMask(value.width) : 0n;
  const sign = 1n << BigInt(value.width - 1);
  return {
    width, signed,
    bits: (value.bits | ((value.bits & sign) ? extension : 0n)) & mask,
    xMask: (value.xMask | ((value.xMask & sign) ? extension : 0n)) & mask,
    zMask: (value.zMask | ((value.zMask & sign) ? extension : 0n)) & mask
  };
}
export function literalIntegralConstant(parsed: ParsedVerilogNumberLiteral | undefined): VerilogIntegralConstant | undefined {
  if (!parsed || parsed.kind === 'real') { return undefined; }
  const minimum = parsed.value === undefined ? (parsed.kind === 'based' ? parsed.digits.length * (parsed.base === 'h' ? 4 : parsed.base === 'o' ? 3 : 1) : 32)
    : Math.max(1, parsed.value.toString(2).length);
  const width = parsed.kind === 'based' ? parsed.size ?? Math.max(32, minimum) : Math.max(32, minimum + 1);
  const signed = parsed.kind === 'decimal' || parsed.signed;
  if (!validIntegralWidth(width)) { return undefined; }
  if (parsed.value !== undefined) { return integralConstant(parsed.value, width, signed); }
  if (parsed.kind !== 'based' || !/[xz?]/i.test(parsed.digits)) { return undefined; }
  if (parsed.base === 'd') {
    return { width, signed, bits: 0n, xMask: /x/i.test(parsed.digits) ? integralMask(width) : 0n, zMask: /x/i.test(parsed.digits) ? 0n : integralMask(width) };
  }
  const digitWidth = parsed.base === 'h' ? 4 : parsed.base === 'o' ? 3 : 1;
  if (parsed.digits.length * digitWidth > VERILOG_EVALUATION_LIMITS.bits) { return undefined; }
  let bits = 0n, xMask = 0n, zMask = 0n;
  for (const digit of parsed.digits.toLowerCase()) {
    bits <<= BigInt(digitWidth); xMask <<= BigInt(digitWidth); zMask <<= BigInt(digitWidth);
    if (digit === 'x') { xMask |= integralMask(digitWidth); }
    else if (digit === 'z' || digit === '?') { zMask |= integralMask(digitWidth); }
    else { const n = parseInt(digit, parsed.base === 'h' ? 16 : parsed.base === 'o' ? 8 : 2); if (!Number.isFinite(n)) { return undefined; } bits |= BigInt(n); }
  }
  const rawWidth = parsed.digits.length * digitWidth;
  const first = parsed.digits[0].toLowerCase();
  if (width > rawWidth && /[xz?]/.test(first)) {
    const extension = integralMask(width) ^ integralMask(rawWidth);
    if (first === 'x') { xMask |= extension; } else { zMask |= extension; }
  }
  const mask = integralMask(width);
  return { width, signed, bits: bits & mask, xMask: xMask & mask, zMask: zMask & mask };
}
export function evaluateIntegralConstant(expression: VerilogExpressionAst | undefined, resolver: VerilogTypedResolver = {}, context: VerilogEvaluationContext = { steps: 0, depth: 0 }, expectedWidth?: number, expectedSigned?: boolean): VerilogIntegralConstant | undefined {
  if (!expression || ++context.steps > VERILOG_EVALUATION_LIMITS.steps || context.depth >= VERILOG_EVALUATION_LIMITS.depth || expression.missing?.length) { return undefined; }
  context.depth++;
  try {
    const value = evaluate(expression, resolver, context, expectedWidth, expectedSigned);
    if (!value) { return undefined; }
    const converted = expectedWidth && expectedWidth >= value.width
      ? resizeIntegralConstant(value, expectedWidth, expectedSigned ?? value.signed, expectedSigned ?? value.signed)
      : expectedSigned === undefined ? value : { ...value, signed: expectedSigned };
    if (converted) { resolver.onValue?.(expression, converted); }
    return converted;
  } catch { return undefined; } finally { context.depth--; }
}
function evaluate(expression: VerilogExpressionAst, resolver: VerilogTypedResolver, context: VerilogEvaluationContext, expectedWidth?: number, expectedSigned?: boolean): VerilogIntegralConstant | undefined {
  const child = (node: VerilogExpressionAst | undefined, width?: number, signed?: boolean) => evaluateIntegralConstant(node, resolver, context, width, signed);
  switch (expression.kind) {
    case 'numberLiteral': return literalIntegralConstant(expression.parsed);
    case 'identifier': return resolvedIdentifier(expression, resolver, context);
    case 'parenthesizedExpression': return child(expression.expression, expectedWidth, expectedSigned);
    // The bundled compiler uses typical values unless an explicit -T mode is selected.
    case 'mintypmaxExpression': return child(expression.typical, expectedWidth, expectedSigned);
    case 'callExpression': {
      if (expression.args.length !== 1) { return undefined; }
      const arg = child(expression.args[0]); if (!arg) { return undefined; }
      if (expression.callee === '$signed' || expression.callee === '$unsigned') { return { ...arg, signed: expression.callee === '$signed' }; }
      if (expression.callee === '$clog2') { const value = integerConstantValue(arg); return value === undefined || value <= 0n ? undefined : integralConstant(BigInt((value - 1n).toString(2).length) - (value === 1n ? 1n : 0n), 32, true); }
      return undefined;
    }
    case 'unaryExpression': {
      const contextDetermined = ['+', '-', '~'].includes(expression.operator);
      const arg = child(expression.argument, contextDetermined ? expectedWidth : undefined, contextDetermined ? expectedSigned : undefined); if (!arg) { return undefined; }
      const value = integerConstantValue(arg);
      const result = (n: bigint) => integralConstant(n, arg.width, arg.signed);
      if (expression.operator === '+') { return arg; }
      if (expression.operator === '~') { return { ...arg, bits: ~arg.bits & integralMask(arg.width) & ~(arg.xMask | arg.zMask), xMask: arg.xMask | arg.zMask, zMask: 0n }; }
      if (expression.operator === '-') { return value === undefined ? unknown(arg.width, arg.signed) : result(-value); }
      if (expression.operator === '!') { return booleanConstant(arg.bits !== 0n ? false : value === undefined ? undefined : true); }
      if (value === undefined) {
        const unknownBits = arg.xMask | arg.zMask;
        const knownOne = arg.bits & ~unknownBits;
        const knownZero = integralMask(arg.width) & ~(arg.bits | unknownBits);
        let controlled: boolean | undefined;
        if (expression.operator.includes('&') && knownZero) { controlled = false; }
        else if (expression.operator.includes('|') && knownOne) { controlled = true; }
        if (controlled === undefined) { return unknown(1, false); }
        if (expression.operator.startsWith('~')) { controlled = !controlled; }
        return booleanConstant(controlled);
      }
      let reduction: bigint;
      if (expression.operator.includes('&')) { reduction = arg.bits === integralMask(arg.width) ? 1n : 0n; }
      else if (expression.operator.includes('|')) { reduction = arg.bits !== 0n ? 1n : 0n; }
      else { let bits = arg.bits; reduction = 0n; while (bits) { reduction ^= bits & 1n; bits >>= 1n; } }
      if (expression.operator.startsWith('~') || expression.operator === '^~') { reduction ^= 1n; }
      return integralConstant(reduction, 1, false);
    }
    case 'binaryExpression': {
      const leftType = inferType(expression.left, resolver, context), rightType = inferType(expression.right, resolver, context);
      if (!leftType || !rightType) { return undefined; }
      const logical = expression.operator === '&&' || expression.operator === '||';
      const comparison = ['==', '!=', '===', '!==', '<', '<=', '>', '>='].includes(expression.operator);
      const shift = ['<<', '<<<', '>>', '>>>', '**'].includes(expression.operator);
      const naturalSigned = shift ? leftType.signed : leftType.signed && rightType.signed;
      const signed = comparison || logical ? naturalSigned : expectedSigned ?? naturalSigned;
      const width = Math.max(comparison || logical ? 0 : expectedWidth ?? 0, leftType.width, shift ? 0 : rightType.width);
      const left = child(expression.left, logical ? undefined : width, logical ? undefined : signed);
      const right = child(expression.right, shift || logical ? undefined : width, shift || logical ? undefined : signed);
      return left && right ? binary(expression.operator, left, right) : undefined;
    }
    case 'conditionalExpression': {
      const type = inferType(expression, resolver, context);
      if (!type) { return undefined; }
      const width = Math.max(type.width, expectedWidth ?? 0), signed = expectedSigned ?? type.signed;
      const condition = child(expression.condition), a = child(expression.whenTrue, width, signed), b = child(expression.whenFalse, width, signed);
      if (!condition || !a || !b) { return undefined; }
      const conditionValue = integerConstantValue(condition);
      if (condition.bits !== 0n || conditionValue !== undefined) { return condition.bits !== 0n ? a : b; }
      const same = ~(a.bits ^ b.bits | a.xMask ^ b.xMask | a.zMask ^ b.zMask) & integralMask(width);
      return { width, signed, bits: a.bits & same, xMask: (a.xMask & same) | (integralMask(width) ^ same), zMask: a.zMask & same };
    }
    case 'concatenation': return concatenate(expression.elements.map((element) => child(element)));
    case 'multipleConcatenation': {
      const repeat = integerConstantValue(child(expression.repeat)), value = concatenate(expression.elements.map((element) => child(element)));
      if (repeat === undefined || !value || repeat <= 0n || repeat * BigInt(value.width) > BigInt(VERILOG_EVALUATION_LIMITS.bits)) { return undefined; }
      const values = Array.from({ length: Number(repeat) }, () => value); return concatenate(values);
    }
    case 'selectExpression': {
      const target = child(expression.target); if (!target) { return undefined; }
      const bounds = target.packedRange ?? { left: target.width - 1, right: 0 };
      const descending = bounds.left >= bounds.right;
      let right: bigint | undefined, width: bigint | undefined;
      if (expression.select.kind === 'bitSelect') { right = integerConstantValue(child(expression.select.index)); width = 1n; }
      else if (expression.select.kind === 'rangeSelect') {
        const a = integerConstantValue(child(expression.select.left)), b = integerConstantValue(child(expression.select.right));
        if (a === undefined || b === undefined || (a !== b && (a > b) !== descending)) { return undefined; }
        right = b; width = (a > b ? a - b : b - a) + 1n;
      } else {
        const base = integerConstantValue(child(expression.select.base)); width = integerConstantValue(child(expression.select.width));
        if (base === undefined || width === undefined) { return undefined; }
        const low = expression.select.direction === '+:' ? base : base - width + 1n;
        const high = low + width - 1n;
        right = descending ? low : high;
      }
      if (right === undefined || width === undefined || !validIntegralWidth(Number(width))) { return undefined; }
      let bits = 0n, xMask = 0n, zMask = 0n;
      const step = descending ? 1n : -1n;
      for (let offset = 0n; offset < width; offset++) {
        if (++context.steps > VERILOG_EVALUATION_LIMITS.steps) { return undefined; }
        const index = right + offset * step;
        const source = descending ? index - BigInt(bounds.right) : BigInt(bounds.right) - index;
        const outputBit = 1n << offset;
        if (source < 0n || source >= BigInt(target.width)) { xMask |= outputBit; continue; }
        const sourceBit = 1n << source;
        if (target.bits & sourceBit) { bits |= outputBit; }
        if (target.xMask & sourceBit) { xMask |= outputBit; }
        if (target.zMask & sourceBit) { zMask |= outputBit; }
      }
      return { width: Number(width), signed: false, bits, xMask, zMask };
    }
    default: return undefined;
  }
}
function resolvedIdentifier(expression: Extract<VerilogExpressionAst, { kind: 'identifier' }>, resolver: VerilogTypedResolver, context: VerilogEvaluationContext): VerilogIntegralConstant | undefined {
  const cache = context.identifiers ??= new WeakMap();
  if (cache.has(expression)) { return cache.get(expression); }
  // A sentinel also bounds recursive/cyclic macro and parameter references.
  cache.set(expression, undefined);
  const value = resolver.identifier?.(expression.name, context, expression);
  cache.set(expression, value);
  return value;
}

/** Determine self-determined types before applying a parent expression's context. */
function inferType(expression: VerilogExpressionAst, resolver: VerilogTypedResolver, context: VerilogEvaluationContext): VerilogIntegralType | undefined {
  const cache = context.types ??= new WeakMap();
  if (cache.has(expression)) { return cache.get(expression); }
  if (++context.steps > VERILOG_EVALUATION_LIMITS.steps || context.depth >= VERILOG_EVALUATION_LIMITS.depth) { return undefined; }
  cache.set(expression, undefined); context.depth++;
  try {
    const explicit = resolver.type?.(expression);
    if (explicit && validIntegralWidth(explicit.width)) { cache.set(expression, explicit); return explicit; }
    const child = (node: VerilogExpressionAst) => inferType(node, resolver, context);
    const common = (a: VerilogIntegralType | undefined, b: VerilogIntegralType | undefined) => a && b ? { width: Math.max(a.width, b.width), signed: a.signed && b.signed } : undefined;
    let type: VerilogIntegralType | undefined;
    switch (expression.kind) {
      case 'numberLiteral': type = literalIntegralConstant(expression.parsed); break;
      case 'identifier': type = resolvedIdentifier(expression, resolver, context); break;
      case 'parenthesizedExpression': type = child(expression.expression); break;
      case 'mintypmaxExpression': type = child(expression.typical); break;
      case 'unaryExpression': type = ['+', '-', '~'].includes(expression.operator) ? child(expression.argument) : { width: 1, signed: false }; break;
      case 'binaryExpression': type = ['==', '!=', '===', '!==', '<', '<=', '>', '>=', '&&', '||'].includes(expression.operator) ? { width: 1, signed: false }
        : ['<<', '<<<', '>>', '>>>', '**'].includes(expression.operator) ? child(expression.left) : common(child(expression.left), child(expression.right)); break;
      case 'conditionalExpression': type = common(child(expression.whenTrue), child(expression.whenFalse)); break;
      case 'callExpression': { const arg = expression.args.length === 1 ? child(expression.args[0]) : undefined; type = expression.callee === '$clog2' ? { width: 32, signed: true } : arg && ['$signed', '$unsigned'].includes(expression.callee) ? { ...arg, signed: expression.callee === '$signed' } : undefined; break; }
      case 'concatenation': case 'multipleConcatenation': {
        let width = 0; for (const element of expression.elements) { const value = child(element); if (!value) { width = 0; break; } width += value.width; }
        if (expression.kind === 'multipleConcatenation') { const repeat = integerConstantValue(evaluateIntegralConstant(expression.repeat, resolver, context)); width = repeat === undefined || repeat > BigInt(VERILOG_EVALUATION_LIMITS.bits) || repeat <= 0n ? 0 : width * Number(repeat); }
        type = validIntegralWidth(width) ? { width, signed: false } : undefined; break;
      }
      case 'selectExpression': {
        let width: number | undefined;
        if (expression.select.kind === 'bitSelect') { width = 1; }
        else if (expression.select.kind === 'indexedPartSelect') { const value = integerConstantValue(evaluateIntegralConstant(expression.select.width, resolver, context)); width = value === undefined ? undefined : Number(value); }
        else { const a = integerConstantValue(evaluateIntegralConstant(expression.select.left, resolver, context)), b = integerConstantValue(evaluateIntegralConstant(expression.select.right, resolver, context)); width = a === undefined || b === undefined ? undefined : Number((a > b ? a - b : b - a) + 1n); }
        type = validIntegralWidth(width) ? { width, signed: false } : undefined; break;
      }
    }
    if (type && !validIntegralWidth(type.width)) { type = undefined; }
    cache.set(expression, type); return type;
  } finally { context.depth--; }
}

function unknown(width: number, signed: boolean): VerilogIntegralConstant { return { width, signed, bits: 0n, xMask: integralMask(width), zMask: 0n }; }
function booleanConstant(value: boolean | undefined): VerilogIntegralConstant { return value === undefined ? unknown(1, false) : integralConstant(value ? 1n : 0n, 1, false)!; }
function concatenate(values: (VerilogIntegralConstant | undefined)[]): VerilogIntegralConstant | undefined {
  let bits = 0n, xMask = 0n, zMask = 0n, width = 0;
  for (const value of values) { if (!value || !validIntegralWidth(width + value.width)) { return undefined; } width += value.width; bits = bits << BigInt(value.width) | value.bits; xMask = xMask << BigInt(value.width) | value.xMask; zMask = zMask << BigInt(value.width) | value.zMask; }
  return validIntegralWidth(width) ? { width, signed: false, bits, xMask, zMask } : undefined;
}
function binary(operator: string, left: VerilogIntegralConstant, right: VerilogIntegralConstant): VerilogIntegralConstant | undefined {
  const shift = ['<<', '<<<', '>>', '>>>', '**'].includes(operator);
  const width = shift ? left.width : Math.max(left.width, right.width), signed = shift ? left.signed : left.signed && right.signed;
  const a = resizeIntegralConstant(left, width, signed, signed)!, b = shift ? right : resizeIntegralConstant(right, width, signed, signed)!;
  const av = integerConstantValue(a), bv = integerConstantValue(b);
  const result = (value: bigint) => integralConstant(value, width, signed);
  if (operator === '===' || operator === '!==') { const same = a.bits === b.bits && a.xMask === b.xMask && a.zMask === b.zMask; return booleanConstant(operator === '===' ? same : !same); }
  if (operator === '&&' || operator === '||') {
    const at = a.bits !== 0n ? true : av === undefined ? undefined : false, bt = b.bits !== 0n ? true : bv === undefined ? undefined : false;
    return booleanConstant(operator === '&&' ? at === false || bt === false ? false : at === undefined || bt === undefined ? undefined : true : at === true || bt === true ? true : at === undefined || bt === undefined ? undefined : false);
  }
  if (['&', '|', '^', '^~', '~^'].includes(operator)) {
    const mask = integralMask(width), au = a.xMask | a.zMask, bu = b.xMask | b.zMask;
    const a1 = a.bits & ~au, b1 = b.bits & ~bu, a0 = mask & ~(a.bits | au), b0 = mask & ~(b.bits | bu);
    let bits: bigint, xMask: bigint;
    if (operator === '&') { bits = a1 & b1; xMask = mask & ~(bits | a0 | b0); }
    else if (operator === '|') { bits = a1 | b1; xMask = mask & ~(bits | a0 & b0); }
    else { xMask = au | bu; bits = (operator === '^' ? a.bits ^ b.bits : ~(a.bits ^ b.bits)) & mask & ~xMask; }
    return { width, signed, bits, xMask, zMask: 0n };
  }
  const comparison = ['==', '!=', '<', '<=', '>', '>='].includes(operator);
  if (av === undefined || bv === undefined) { return unknown(comparison ? 1 : width, comparison ? false : signed); }
  switch (operator) {
    case '+': return result(av + bv); case '-': return result(av - bv); case '*': return result(av * bv);
    case '/': return bv === 0n ? unknown(width, signed) : result(av / bv); case '%': return bv === 0n ? unknown(width, signed) : result(av % bv);
    case '==': return booleanConstant(av === bv); case '!=': return booleanConstant(av !== bv); case '<': return booleanConstant(av < bv); case '<=': return booleanConstant(av <= bv); case '>': return booleanConstant(av > bv); case '>=': return booleanConstant(av >= bv);
    case '<<': case '<<<': return bv < 0n ? unknown(width, signed) : bv >= BigInt(width) ? result(0n) : result(a.bits << bv);
    case '>>': case '>>>': return bv < 0n ? unknown(width, signed) : bv >= BigInt(width) ? result(operator === '>>>' && signed && av < 0n ? -1n : 0n) : result((operator === '>>>' && signed ? av : a.bits) >> bv);
    case '**': { if (bv < 0n) { return result(0n); } if (bv > BigInt(VERILOG_EVALUATION_LIMITS.bits)) { return undefined; } let value = 1n, base = a.bits, exponent = bv; const mask = integralMask(width); while (exponent) { if (exponent & 1n) { value = value * base & mask; } base = base * base & mask; exponent >>= 1n; } return result(value); }
    default: return undefined;
  }
}
