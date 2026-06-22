import { VerilogExpressionAst } from './exprAst';

export interface VerilogExpressionMatch {
  expression: VerilogExpressionAst;
  parent?: VerilogExpressionAst;
}

export function childrenOfVerilogExpression(expression: VerilogExpressionAst): VerilogExpressionAst[] {
  switch (expression.kind) {
    case 'parenthesizedExpression':
      return [expression.expression];
    case 'unaryExpression':
      return [expression.argument];
    case 'binaryExpression':
      return [expression.left, expression.right];
    case 'conditionalExpression':
      return [expression.condition, expression.whenTrue, expression.whenFalse];
    case 'concatenation':
      return expression.elements;
    case 'multipleConcatenation':
      return [expression.repeat, ...expression.elements];
    case 'selectExpression': {
      const select = expression.select;
      if (select.kind === 'bitSelect') {
        return [expression.target, select.index];
      }
      if (select.kind === 'rangeSelect') {
        return [expression.target, select.left, select.right];
      }
      return [expression.target, select.base, select.width];
    }
    case 'callExpression':
      return expression.args;
    case 'memberExpression':
      return [expression.target];
    default:
      return [];
  }
}

export function walkVerilogExpression(
  expression: VerilogExpressionAst,
  visit: (expression: VerilogExpressionAst) => void
): void {
  visit(expression);
  for (const child of childrenOfVerilogExpression(expression)) {
    walkVerilogExpression(child, visit);
  }
}

export function walkVerilogExpressionWithParent(
  expression: VerilogExpressionAst,
  visit: (expression: VerilogExpressionAst, parent?: VerilogExpressionAst) => void,
  parent?: VerilogExpressionAst
): void {
  visit(expression, parent);
  for (const child of childrenOfVerilogExpression(expression)) {
    walkVerilogExpressionWithParent(child, visit, expression);
  }
}

export function findSmallestVerilogExpressionAtOffset(
  expressions: VerilogExpressionAst[],
  offset: number
): VerilogExpressionAst | undefined {
  return findSmallestVerilogExpressionMatchAtOffset(expressions, offset)?.expression;
}

export function findSmallestVerilogExpressionMatchAtOffset(
  expressions: VerilogExpressionAst[],
  offset: number
): VerilogExpressionMatch | undefined {
  let best: VerilogExpressionMatch | undefined;
  for (const expression of expressions) {
    walkVerilogExpressionWithParent(expression, (candidate, parent) => {
      if (offset < candidate.start || offset > candidate.end) {
        return;
      }
      if (!best || expressionSize(candidate) < expressionSize(best.expression)) {
        best = { expression: candidate, parent };
      }
    });
  }
  return best;
}

function expressionSize(expression: VerilogExpressionAst): number {
  return expression.end - expression.start;
}
