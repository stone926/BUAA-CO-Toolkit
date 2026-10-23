// @index verilog-expression-context — shared source expression selection and contextual evaluation for IDE features
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { VerilogModuleAst, VerilogStatementAst } from './ast';
import type { VerilogModule } from './model';
import { findSmallestVerilogExpressionMatchAtOffset, VerilogExpressionMatch } from './exprAstUtils';
import { evalExpressionAstWithin, widthOfExpressionAst } from './expressions';
import type { VerilogIntegralConstant } from './typedConstants';

export interface VerilogExpressionContext extends VerilogExpressionMatch {
  statement: VerilogStatementAst;
}

export function findStatementExpressionAtOffset(module: VerilogModuleAst, offset: number): VerilogExpressionContext | undefined {
  let best: VerilogExpressionContext | undefined;
  for (const statement of module.items) {
    const match = findSmallestVerilogExpressionMatchAtOffset(statement.expressions, offset);
    if (match && (!best || match.expression.end - match.expression.start < best.expression.end - best.expression.start)) {
      best = { ...match, statement };
    }
  }
  return best;
}

export function valueOfExpressionInStatement(document: TextDocument, module: VerilogModule, context: VerilogExpressionContext): VerilogIntegralConstant | undefined {
  const { expression, statement } = context;
  const assignment = statement.assignments.find(({ rhs }) => rhs.start <= expression.start && rhs.end >= expression.end);
  if (!assignment) return undefined;
  const position = document.positionAt(expression.start);
  const width = widthOfExpressionAst(assignment.lhs, module, undefined, position).width;
  // An unknown destination width can affect every context-sized subexpression.
  if (!width) return undefined;
  return evalExpressionAstWithin(assignment.rhs, expression, module, position, { width });
}
