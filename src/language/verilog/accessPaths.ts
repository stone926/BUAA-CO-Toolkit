// @index access-paths — Scope-bound lvalue identities and selected array/bit regions
import { Position } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { VerilogExpressionAst } from './exprAst';
import { evalExpressionAstConstant, resolveDeclarationAt, widthOfDecl } from './expressions';
import { VERILOG_EVALUATION_LIMITS } from './typedConstants';
import type { VerilogDecl, VerilogModule } from './model';

export interface AccessInterval { low: bigint; high: bigint }
export interface VerilogAccessPath {
  name: string;
  identity: string;
  declaration?: VerilogDecl;
  arrays: Array<AccessInterval | undefined>;
  bits?: AccessInterval;
}

export function declarationAtPosition(module: VerilogModule, name: string, position: Position): VerilogDecl | undefined {
  return resolveDeclarationAt(module, name, position);
}

/** Macro bodies retain their original locations, but names bind at the use site. */
export function expressionAccessPaths(document: TextDocument, module: VerilogModule, expression: VerilogExpressionAst, bindingPosition?: Position, depth = 0): VerilogAccessPath[] {
  if (depth >= VERILOG_EVALUATION_LIMITS.depth) return [];
  if (expression.kind === 'identifier' && expression.name.startsWith('`')) {
    const expanded = module.macroExpressions?.get(expression.start);
    return expanded ? expressionAccessPaths(document, module, expanded, bindingPosition ?? document.positionAt(expression.start), depth + 1) : [];
  }
  if (expression.kind === 'parenthesizedExpression') return expressionAccessPaths(document, module, expression.expression, bindingPosition, depth + 1);
  if (expression.kind === 'concatenation') return expression.elements.flatMap((element) => expressionAccessPaths(document, module, element, bindingPosition, depth + 1));
  const access = expressionAccessPath(document, module, expression, bindingPosition, depth);
  return access ? [access] : [];
}

export function expressionAccessPath(document: TextDocument, module: VerilogModule, expression: VerilogExpressionAst, bindingPosition?: Position, depth = 0): VerilogAccessPath | undefined {
  if (depth >= VERILOG_EVALUATION_LIMITS.depth) return undefined;
  const selects: Extract<VerilogExpressionAst, { kind: 'selectExpression' }>[] = [];
  let root = expression;
  while (root.kind === 'selectExpression' || root.kind === 'parenthesizedExpression') {
    if (root.kind === 'parenthesizedExpression') { root = root.expression; }
    else { selects.unshift(root); root = root.target; }
  }
  // Hierarchical references are not aliases of a same-named local net.
  if (root.kind !== 'identifier') { return undefined; }
  const position = bindingPosition ?? document.positionAt(root.start);
  if (root.name.startsWith('`')) {
    let expanded = module.macroExpressions?.get(root.start);
    if (!expanded) return undefined;
    // A bound view composes use-site selects without altering either source AST.
    for (const select of selects) expanded = { ...select, target: expanded };
    return expressionAccessPath(document, module, expanded, position, depth + 1);
  }
  const declaration = declarationAtPosition(module, root.name, position);
  const dimensions = declaration?.unpackedDimensions?.length ?? 0;
  const arrays: Array<AccessInterval | undefined> = [];
  let bits: AccessInterval | undefined;
  for (let index = 0; index < selects.length; index++) {
    const selected = selectInterval(selects[index], module, position);
    if (index < dimensions) { arrays.push(selected); }
    else { bits = selected; }
  }
  if (selects.length <= dimensions && declaration) {
    const width = widthOfDecl(declaration, module).width;
    if (width !== undefined) { bits = { low: 0n, high: BigInt(width - 1) }; }
    // Whole-vector writes use its declared coordinates, including [8:1].
    const packed = declaration.widthAst;
    if (packed?.length === 2) {
      const left = evalExpressionAstConstant(packed[0], module);
      const right = evalExpressionAstConstant(packed[1], module);
      if (left !== undefined && right !== undefined) { bits = orderedInterval(left, right); }
    }
  }
  const selected = declaration?.selectionRange;
  return {
    name: root.name,
    identity: selected ? `${root.name}@${selected.start.line}:${selected.start.character}` : root.name,
    declaration, arrays, bits
  };
}

export function selectInterval(expression: Extract<VerilogExpressionAst, { kind: 'selectExpression' }>, module: VerilogModule, position?: Position): AccessInterval | undefined {
  const select = expression.select;
  if (select.kind === 'bitSelect') {
    const index = evalExpressionAstConstant(select.index, module, undefined, position);
    return index === undefined ? undefined : { low: index, high: index };
  }
  if (select.kind === 'rangeSelect') {
    const left = evalExpressionAstConstant(select.left, module, undefined, position);
    const right = evalExpressionAstConstant(select.right, module, undefined, position);
    return left === undefined || right === undefined ? undefined : orderedInterval(left, right);
  }
  const base = evalExpressionAstConstant(select.base, module, undefined, position);
  const width = evalExpressionAstConstant(select.width, module, undefined, position);
  return base === undefined || width === undefined || width <= 0n ? undefined
    : select.direction === '+:' ? orderedInterval(base, base + width - 1n) : orderedInterval(base - width + 1n, base);
}

export function accessPathsOverlap(left: VerilogAccessPath, right: VerilogAccessPath): boolean {
  return left.identity === right.identity && intervalsOverlap(left.bits, right.bits)
    && left.arrays.every((index, dimension) => intervalsOverlap(index, right.arrays[dimension]));
}

function intervalsOverlap(left: AccessInterval | undefined, right: AccessInterval | undefined): boolean {
  return !left || !right || left.low <= right.high && right.low <= left.high;
}

export function orderedInterval(left: bigint, right: bigint): AccessInterval {
  return left <= right ? { low: left, high: right } : { low: right, high: left };
}

export function declarationIsVariable(decl: VerilogDecl): boolean {
  if (decl.storage) return decl.storage === 'variable';
  return ['reg', 'logic', 'integer', 'real', 'realtime', 'time', 'genvar'].includes(decl.netType ?? decl.kind);
}

export function permitsResolvedDrivers(decl: VerilogDecl | undefined): boolean {
  return decl?.direction === 'inout' || !!decl?.netType && ['tri', 'tri0', 'tri1', 'trireg', 'wand', 'wor', 'triand', 'trior', 'supply0', 'supply1'].includes(decl.netType);
}
