// @index declaration-dependencies — Conservative declaration completeness for includes and module macros
import { containsRange, rangesEqual } from '../common/lsp';
import type { Range } from 'vscode-languageserver-types';
import type { VerilogAstDocument, VerilogModuleAst } from './ast';
import type { VerilogProceduralStatementAst } from './proceduralAst';
import { verilogExpressionHasError } from './exprAst';

/** Includes and declaration-position macros can add symbols absent from this local AST. */
export function hasUnexpandedDeclarationDependencies(ast: VerilogAstDocument, module: VerilogModuleAst, declarationRange?: Range): boolean {
  const within = declarationRange ?? module.bodyRange;
  const subroutine = declarationRange && module.subroutines.find((routine) => rangesEqual(routine.range, declarationRange));
  return ast.preprocessor.some((item) => {
    if (!containsRange(within, item.range)) return false;
    if (item.kind === 'include') return true;
    if (item.kind !== 'macroUse') return false;
    if (subroutine) return containsRange(subroutine.headerRange, item.range) || macroMayDeclare(subroutine.statementTree, item.range);
    return ![...module.proceduralBlocks, ...module.subroutines].some((block) => containsRange(block.range, item.range)) &&
      module.items.some((statement) => statement.kind === 'preprocessor' && containsRange(statement.range, item.range));
  });
}

function macroMayDeclare(statement: VerilogProceduralStatementAst, macroRange: Range): boolean {
  if (!containsRange(statement.range, macroRange)) return false;
  switch (statement.kind) {
    case 'block': return statement.statements.some((child) => macroMayDeclare(child, macroRange));
    case 'if': return macroMayDeclare(statement.consequent, macroRange) || !!statement.alternate && macroMayDeclare(statement.alternate, macroRange);
    case 'case': return statement.items.some((item) => macroMayDeclare(item.body, macroRange));
    case 'loop':
    case 'wait': return macroMayDeclare(statement.body, macroRange);
    case 'declaration': return true;
    case 'other': return statement.tokens[0]?.kind === 'directive';
    // A declaration macro without a source semicolon may share a recovered slice
    // with the following assignment. A valid macro lvalue cannot add formals.
    case 'assignment': return statement.tokens[0]?.kind === 'directive' && (!statement.lhs || verilogExpressionHasError(statement.lhs));
  }
}
