import { VerilogExpressionAst } from './exprAst';

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

export function findSmallestVerilogExpressionAtOffset(
  expressions: VerilogExpressionAst[],
  offset: number
): VerilogExpressionAst | undefined {
  let best: VerilogExpressionAst | undefined;
  for (const expression of expressions) {
    walkVerilogExpression(expression, (candidate) => {
      if (offset < candidate.start || offset > candidate.end) {
        return;
      }
      if (!best || expressionSize(candidate) < expressionSize(best)) {
        best = candidate;
      }
    });
  }
  return best;
}

function expressionSize(expression: VerilogExpressionAst): number {
  return expression.end - expression.start;
}
