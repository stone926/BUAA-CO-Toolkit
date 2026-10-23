import {
  parseVerilogExpression,
  ParsedVerilogNumberLiteral,
  VerilogExpressionAst,
  verilogExpressionHasError
} from './exprAst';
import { VerilogDecl, VerilogDeclDimension, VerilogModule } from './model';
import type { Position } from 'vscode-languageserver-types';
import { containsPosition, containsRange } from '../common/lsp';
import { evaluateIntegralConstant, integralConstant, integerConstantValue, resizeIntegralConstant, validIntegralWidth, VERILOG_EVALUATION_LIMITS, VerilogIntegralConstant, VerilogEvaluationContext } from './typedConstants';

export interface WidthInfo {
  width?: number;
  signed?: boolean;
  unpackedDimensions?: VerilogDeclDimension[];
  minWidth?: number;
  flexible?: boolean;
}

/** Legacy numeric map plus lossless values for signed, sized and X/Z overrides. */
export interface VerilogConstantContext {
  width: number;
  /** Enclosing operator signedness; assignments normally supply only width. */
  signed?: boolean;
}

export type VerilogConstantOverrides = ReadonlyMap<string, bigint> & {
  readonly typedValues?: ReadonlyMap<string, VerilogIntegralConstant>;
};

const activeDeclarationWidths = new Set<VerilogDecl>();
export function widthOfDecl(decl: VerilogDecl, module?: VerilogModule, overrides?: VerilogConstantOverrides): WidthInfo {
  if (activeDeclarationWidths.has(decl) || activeDeclarationWidths.size >= VERILOG_EVALUATION_LIMITS.depth) { return {}; }
  activeDeclarationWidths.add(decl);
  try { return widthOfDeclaration(decl, module, overrides); }
  finally { activeDeclarationWidths.delete(decl); }
}
function widthOfDeclaration(decl: VerilogDecl, module?: VerilogModule, overrides?: VerilogConstantOverrides): WidthInfo {
  const valueType = decl.functionReturnType ?? decl.valueType ?? decl.kind;
  if (valueType === 'real' || valueType === 'realtime' || decl.kind === 'task') {
    return {};
  }
  const rangeWidth = decl.widthAst?.length === 2
    ? widthBetween(decl.widthAst[0], decl.widthAst[1], module, overrides)
    : widthFromRange(decl.width, module, overrides);
  if (rangeWidth !== undefined) {
    return { width: rangeWidth };
  }
  // A macro or unresolved parameter is not a scalar declaration.
  if (decl.width) {
    return {};
  }
  if (valueType === 'time') {
    return { width: 64 };
  }
  if (valueType === 'integer') {
    return { width: 32 };
  }
  const overrideType = overrides?.typedValues?.get(decl.name);
  if (overrideType) { return { width: overrideType.width }; }
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
  return { width: 1 };
}

export function widthOfExpression(expression: string, module: VerilogModule): WidthInfo {
  return widthOfExpressionAst(parseVerilogExpression(expression), module);
}

export function shouldReportWidthMismatch(expected: WidthInfo, actual: WidthInfo): boolean {
  if (!expected.width || !actual.width) {
    return false;
  }
  // Only flag truncation: assigning a narrower value to a wider target is normal
  // zero/sign-extension. Flexible arithmetic widths compare by their meaningful minimum.
  const actualMinimum = actual.minWidth ?? actual.width;
  return actualMinimum > expected.width;
}

let widthDepth = 0;
let widthSteps = 0;
export function widthOfExpressionAst(expression: VerilogExpressionAst | undefined, module: VerilogModule | undefined, overrides?: VerilogConstantOverrides, position?: Position): WidthInfo {
  if (widthDepth === 0) { widthSteps = 0; if (verilogExpressionHasError(expression)) { return {}; } }
  if (++widthSteps > VERILOG_EVALUATION_LIMITS.steps || widthDepth >= VERILOG_EVALUATION_LIMITS.depth) { return {}; }
  widthDepth++;
  try { return widthOfExpressionInternal(expression, position && module ? moduleAtScope(module, position) : module, overrides); }
  finally { widthDepth--; }
}
function widthOfExpressionInternal(expression: VerilogExpressionAst | undefined, module: VerilogModule | undefined, overrides?: VerilogConstantOverrides): WidthInfo {
  if (!expression || expression.kind === 'errorExpression' || expression.missing?.length) {
    return {};
  }
  switch (expression.kind) {
    case 'numberLiteral':
      return literalWidth(expression.parsed);
    case 'stringLiteral':
      return {};
    case 'identifier':
      return module ? widthOfIdentifier(expression.name, module, overrides, expression.start) : {};
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
      if (isShiftOperator(expression.operator) || expression.operator === '**') {
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

export function evalExpressionAstConstant(expression: VerilogExpressionAst | undefined, module?: VerilogModule, overrides?: VerilogConstantOverrides, position?: Position, context?: number | VerilogConstantContext): bigint | undefined {
  return integerConstantValue(evalExpressionAstTypedConstant(expression, module, overrides, position, context));
}

/** Preserve X/Z independently from numeric folding, and carry declaration type through references. */
export function evalExpressionAstTypedConstant(expression: VerilogExpressionAst | undefined, module?: VerilogModule, overrides?: VerilogConstantOverrides, position?: Position, expectedType?: number | VerilogConstantContext, onValue?: (expression: VerilogExpressionAst, value: VerilogIntegralConstant) => void): VerilogIntegralConstant | undefined {
  if (!expression) { return undefined; }
  const scoped = module && position ? moduleAtScope(module, position) : module;
  const evaluating = new Set<VerilogDecl>();
  const evaluate = (node: VerilogExpressionAst | undefined, context?: VerilogEvaluationContext, expectedWidth?: number, expectedSigned?: boolean): VerilogIntegralConstant | undefined => evaluateIntegralConstant(node, {
    onValue,
    identifier: (name, budget, node) => {
      if (name.startsWith('`')) { return evaluate(scoped?.macroExpressions?.get(node.start), budget); }
      const decl = scoped?.declarations.get(name);
      if (!decl || (decl.kind !== 'parameter' && decl.kind !== 'localparam') || evaluating.has(decl)) { return undefined; }
      evaluating.add(decl);
      try {
        const declaredWidth = hasDeclaredIntegralWidth(decl) ? widthOfDecl(decl, scoped, overrides).width : undefined;
        if (hasDeclaredIntegralWidth(decl) && !validIntegralWidth(declaredWidth)) { return undefined; }
        const overridden = overrides?.get(name);
        const typedOverride = overrides?.typedValues?.get(name);
        const initial = typedOverride ?? (overridden !== undefined
          ? integralConstant(overridden, declaredWidth ?? Math.max(32, overridden.toString(2).replace('-', '').length + (overridden < 0n ? 1 : 0)), declarationSigned(decl))
          : decl.initializer ? evaluate(decl.initializerAst ?? parseVerilogExpression(decl.initializer), budget, declaredWidth)
          : decl.constantValue !== undefined ? integralConstant(decl.constantValue, widthOfDecl(decl, scoped, overrides).width ?? 32, declarationSigned(decl)) : undefined);
        if (!initial) { return undefined; }
        const converted = hasDeclaredIntegralType(decl)
          ? resizeIntegralConstant(initial, declaredWidth ?? initial.width, declarationSigned(decl))
          : initial;
        if (converted && decl.widthAst?.length === 2) {
          const left = integerConstantValue(evaluate(decl.widthAst[0], budget)), right = integerConstantValue(evaluate(decl.widthAst[1], budget));
          if (left !== undefined && right !== undefined && left >= Number.MIN_SAFE_INTEGER && left <= Number.MAX_SAFE_INTEGER && right >= Number.MIN_SAFE_INTEGER && right <= Number.MAX_SAFE_INTEGER) {
            return { ...converted, packedRange: { left: Number(left), right: Number(right) } };
          }
        }
        // An implicit parameter inherits width/sign, but receives the default [width-1:0] range.
        return converted ? { ...converted, packedRange: undefined } : undefined;
      } finally { evaluating.delete(decl); }
    }
  }, context, expectedWidth, expectedSigned);
  return evaluate(expression, undefined, typeof expectedType === 'number' ? expectedType : expectedType?.width, typeof expectedType === 'number' ? undefined : expectedType?.signed);
}

/** Value of one original AST node after evaluating its complete enclosing expression. */
export function evalExpressionAstWithin(root: VerilogExpressionAst | undefined, target: VerilogExpressionAst, module?: VerilogModule, position?: Position, expectedType?: number | VerilogConstantContext): VerilogIntegralConstant | undefined {
  let selected: VerilogIntegralConstant | undefined;
  const result = evalExpressionAstTypedConstant(root, module, undefined, position, expectedType, (expression, value) => {
    if (expression === target) { selected = value; }
  });
  return result ? selected : undefined;
}

export function convertTypedConstantForDecl(value: VerilogIntegralConstant, decl: VerilogDecl, module?: VerilogModule, overrides?: VerilogConstantOverrides): VerilogIntegralConstant | undefined {
  if (!hasDeclaredIntegralType(decl)) { return value; }
  const width = hasDeclaredIntegralWidth(decl) ? widthOfDecl(decl, module, overrides).width : value.width;
  return validIntegralWidth(width) ? resizeIntegralConstant(value, width, declarationSigned(decl)) : undefined;
}

export function convertConstantForDecl(value: bigint, decl: VerilogDecl, module?: VerilogModule, overrides?: VerilogConstantOverrides): bigint | undefined {
  if (!hasDeclaredIntegralType(decl)) { return value; }
  const width = widthOfDecl(decl, module, overrides).width;
  return validIntegralWidth(width) ? integerConstantValue(integralConstant(value, width, declarationSigned(decl))) : undefined;
}
export function hasDeclaredIntegralWidth(decl: VerilogDecl): boolean { return Boolean(decl.width || decl.valueType || decl.kind === 'integer' || decl.kind === 'time'); }
function hasDeclaredIntegralType(decl: VerilogDecl): boolean { return Boolean(decl.width || decl.valueType || decl.signed !== undefined || decl.kind === 'integer' || decl.kind === 'time'); }
function declarationSigned(decl: VerilogDecl): boolean { return decl.signed ?? ((decl.functionReturnType ?? decl.valueType ?? decl.kind) === 'integer'); }

export function resolveDeclarationAt(module: VerilogModule, name: string, position?: Position): VerilogDecl | undefined {
  if (!position) { return module.declarations.get(name); }
  let result = module.declarations.get(name), owner: { range: import('vscode-languageserver-types').Range } | undefined;
  for (const scope of [...module.generateBlocks, ...(module.lexicalScopes ?? [])]) {
    if (!containsPosition(scope.range, position) || (owner && !containsRange(owner.range, scope.range))) { continue; }
    const decl = scope.declarations.find((item) => item.name === name);
    if (decl) { result = decl; owner = scope; }
  }
  return result;
}
function moduleAtScope(module: VerilogModule, position: Position): VerilogModule {
  const declarations = new Map(module.declarations);
  const names = new Set([...module.generateBlocks, ...(module.lexicalScopes ?? [])].filter((scope) => containsPosition(scope.range, position)).flatMap((scope) => scope.declarations.map((decl) => decl.name)));
  for (const name of names) { const decl = resolveDeclarationAt(module, name, position); if (decl) { declarations.set(name, decl); } }
  return { ...module, declarations };
}

export function typeOfExpressionAst(expression: VerilogExpressionAst | undefined, module?: VerilogModule, overrides?: VerilogConstantOverrides, position?: Position): WidthInfo {
  const scoped = module && position ? moduleAtScope(module, position) : module;
  return expressionType(expression, scoped, overrides, 0);
}
function expressionType(expression: VerilogExpressionAst | undefined, module: VerilogModule | undefined, overrides: VerilogConstantOverrides | undefined, depth: number): WidthInfo {
  if (!expression || depth >= VERILOG_EVALUATION_LIMITS.depth) { return {}; }
  const child = (node: VerilogExpressionAst) => expressionType(node, module, overrides, depth + 1);
  const width = widthOfExpressionAst(expression, module, overrides);
  switch (expression.kind) {
    case 'identifier': { const decl = module?.declarations.get(expression.name); return { ...width, signed: decl ? hasDeclaredIntegralType(decl) ? declarationSigned(decl) : evalExpressionAstTypedConstant(expression, module, overrides)?.signed : undefined, unpackedDimensions: decl?.unpackedDimensions }; }
    case 'numberLiteral': return { ...width, signed: expression.parsed?.kind === 'decimal' || (expression.parsed?.kind === 'based' && expression.parsed.signed) };
    case 'parenthesizedExpression': return child(expression.expression);
    case 'selectExpression': { const target = child(expression.target); return { ...width, signed: target.unpackedDimensions?.length ? target.signed : false, unpackedDimensions: expression.select.kind === 'bitSelect' && target.unpackedDimensions?.length ? target.unpackedDimensions.slice(1) : undefined }; }
    case 'callExpression': return { ...width, signed: expression.callee === '$signed' ? true : expression.callee === '$unsigned' ? false : declarationSigned(module?.declarations.get(expression.callee) ?? { kind: 'integer' } as VerilogDecl) };
    case 'unaryExpression': return { ...width, signed: ['+', '-', '~'].includes(expression.operator) && child(expression.argument).signed };
    case 'binaryExpression': return { ...width, signed: !isOneBitBinaryOperator(expression.operator) && Boolean(child(expression.left).signed && (isShiftOperator(expression.operator) || expression.operator === '**' || child(expression.right).signed)) };
    case 'conditionalExpression': return { ...width, signed: Boolean(child(expression.whenTrue).signed && child(expression.whenFalse).signed) };
    default: return { ...width, signed: false };
  }
}

/** Legality does not require a two-state numeric result (X/Z and constant functions are legal). */
export function classifyExpressionConstant(expression: VerilogExpressionAst | undefined, module?: VerilogModule, overrides?: VerilogConstantOverrides, position?: Position): 'constant' | 'nonConstant' | 'unknown' {
  const scoped = module && position ? moduleAtScope(module, position) : module;
  const active = new Set<VerilogDecl>(); let steps = 0;
  const visit = (node: VerilogExpressionAst | undefined, depth = 0): 'constant' | 'nonConstant' | 'unknown' => {
    if (!node || depth >= VERILOG_EVALUATION_LIMITS.depth || ++steps > VERILOG_EVALUATION_LIMITS.steps) { return 'unknown'; }
    const combine = (nodes: VerilogExpressionAst[]) => { const values = nodes.map((item) => visit(item, depth + 1)); return values.includes('nonConstant') ? 'nonConstant' : values.includes('unknown') ? 'unknown' : 'constant'; };
    if (node.missing?.length) { return 'unknown'; }
    switch (node.kind) {
      case 'numberLiteral': return node.parsed ? 'constant' : 'unknown';
      case 'stringLiteral': return 'constant';
      case 'identifier': { if (node.name.startsWith('`')) { return visit(scoped?.macroExpressions?.get(node.start), depth + 1); } if (overrides?.has(node.name) || overrides?.typedValues?.has(node.name)) { return 'constant'; } const decl = scoped?.declarations.get(node.name); if (!decl) { return 'unknown'; } if (decl.kind !== 'parameter' && decl.kind !== 'localparam') { return 'nonConstant'; } if (active.has(decl)) { return 'nonConstant'; } if (!decl.initializer) { return decl.constantValue !== undefined ? 'constant' : 'unknown'; } active.add(decl); const result = visit(decl.initializerAst ?? parseVerilogExpression(decl.initializer), depth + 1); active.delete(decl); return result; }
      case 'parenthesizedExpression': return visit(node.expression, depth + 1);
      case 'unaryExpression': return visit(node.argument, depth + 1);
      case 'binaryExpression': return combine([node.left, node.right]);
      case 'conditionalExpression': return combine([node.condition, node.whenTrue, node.whenFalse]);
      case 'concatenation': return combine(node.elements);
      case 'multipleConcatenation': return combine([node.repeat, ...node.elements]);
      case 'selectExpression': return combine([node.target, ...(node.select.kind === 'bitSelect' ? [node.select.index] : node.select.kind === 'rangeSelect' ? [node.select.left, node.select.right] : [node.select.base, node.select.width])]);
      case 'callExpression': { const decl = scoped?.declarations.get(node.callee); return decl?.constantFunction === false ? 'nonConstant' : ['$signed', '$unsigned', '$clog2'].includes(node.callee) || decl?.kind === 'function' ? combine(node.args) : node.system ? 'nonConstant' : 'unknown'; }
      default: return 'unknown';
    }
  };
  return visit(expression);
}
export function isConstantExpressionAst(expression: VerilogExpressionAst | undefined, module?: VerilogModule, position?: Position): boolean { return classifyExpressionConstant(expression, module, undefined, position) === 'constant'; }

function widthBetween(left: VerilogExpressionAst | undefined, right: VerilogExpressionAst | undefined, module?: VerilogModule, overrides?: VerilogConstantOverrides): number | undefined {
  const a = constNumber(left, module, overrides), b = constNumber(right, module, overrides);
  const width = a === undefined || b === undefined ? undefined : Math.abs(a - b) + 1;
  return validIntegralWidth(width) ? width : undefined;
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
  return widthBetween(left, right, module, overrides);
}

function widthOfIdentifier(name: string, module: VerilogModule, overrides?: VerilogConstantOverrides, start?: number): WidthInfo {
  if (name.startsWith('`')) { return widthOfExpressionAst(start === undefined ? undefined : module.macroExpressions?.get(start), module, overrides); }
  const decl = module.declarations.get(name);
  return decl ? widthOfDecl(decl, module, overrides) : {};
}

function widthOfCall(expression: Extract<VerilogExpressionAst, { kind: 'callExpression' }>, module: VerilogModule | undefined, overrides?: VerilogConstantOverrides): WidthInfo {
  if (passThroughSystemFunction(expression.callee) && expression.args.length === 1) {
    return widthOfExpressionAst(expression.args[0], module, overrides);
  }
  if (integerSystemFunction(expression.callee)) {
    return { width: 32 };
  }
  const decl = module?.declarations.get(expression.callee);
  return decl?.kind === 'function' ? widthOfDecl(decl, module, overrides) : {};
}

function widthOfSelect(expression: Extract<VerilogExpressionAst, { kind: 'selectExpression' }>, module: VerilogModule | undefined, overrides?: VerilogConstantOverrides): WidthInfo {
  switch (expression.select.kind) {
    case 'bitSelect':
      if ((typeOfExpressionAst(expression.target, module).unpackedDimensions?.length ?? 0) > 0) {
        return widthOfExpressionAst(expression.target, module, overrides);
      }
      return { width: 1 };
    case 'rangeSelect': {
      const left = constNumber(expression.select.left, module, overrides);
      const right = constNumber(expression.select.right, module, overrides);
      return left === undefined || right === undefined || !validIntegralWidth(Math.abs(left - right) + 1) ? {} : { width: Math.abs(left - right) + 1 };
    }
    case 'indexedPartSelect': {
      const width = constNumber(expression.select.width, module, overrides);
      return validIntegralWidth(width) ? { width } : {};
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
    if (!validIntegralWidth(width)) { return {}; }
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
  return repeated === undefined || !validIntegralWidth(repeat * repeated) ? {} : { width: repeat * repeated };
}

function literalWidth(parsed: ParsedVerilogNumberLiteral | undefined): WidthInfo {
  if (!parsed || parsed.kind === 'real') {
    return {};
  }
  if (parsed.kind === 'based') {
    const minWidth = parsed.value === undefined
      ? minWidthOfBasedDigits(parsed.base, parsed.digits)
      : minimalBitsForInteger(parsed.value);
    if (parsed.size !== undefined) {
      return validIntegralWidth(parsed.size) ? { width: parsed.size, minWidth: Math.min(parsed.size, minWidth) } : {};
    }
    const width = Math.max(32, minWidth);
    return validIntegralWidth(width) ? { width, minWidth } : {};
  }
  const minWidth = minimalBitsForInteger(parsed.value);
  const width = Math.max(32, minWidth + 1);
  return validIntegralWidth(width) ? { width, minWidth } : {};
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

function integerSystemFunction(value: string): boolean {
  return value === '$clog2';
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
