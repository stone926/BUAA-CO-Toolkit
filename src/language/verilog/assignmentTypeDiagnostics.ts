// @index assignment-type-diagnostics — Verilog lvalue declaration legality
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { assignmentTargetsFromExpressionAst, collectContinuousAssignmentUsesFromAst, collectProceduralAssignmentUsesFromAst, visitProceduralAssignments } from './assignmentAst';
import { isVerilogLvalueExpression } from './assignmentAnalysis';
import type { VerilogAstDocument } from './ast';
import { declarationIsVariable, expressionAccessPaths } from './accessPaths';
import type { VerilogExpressionAst } from './exprAst';
import type { VerilogModule } from './model';

export function collectAssignmentTypeDiagnostics(document: TextDocument, ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  for (const moduleAst of ast.modules) {
    for (const use of collectContinuousAssignmentUsesFromAst(document, moduleAst)) {
      collectLvalueTypeDiagnostics(document, moduleAst.module, use.expression, 'net', diagnostics);
    }
    for (const use of collectProceduralAssignmentUsesFromAst(document, moduleAst)) {
      collectLvalueTypeDiagnostics(document, moduleAst.module, use.expression, 'variable', diagnostics);
    }
    for (const subroutine of moduleAst.subroutines) {
      visitProceduralAssignments(subroutine.statementTree, (assignment) => {
        if (assignment.lhs) { collectLvalueTypeDiagnostics(document, moduleAst.module, assignment.lhs, 'variable', diagnostics); }
      });
    }
  }
}

export function collectLvalueTypeDiagnostics(document: TextDocument, module: VerilogModule, expression: VerilogExpressionAst, expected: 'net' | 'variable', diagnostics: Diagnostic[], fallbackRange?: Range): void {
  const expanded = expression.kind === 'identifier' && expression.name.startsWith('`')
    ? module.macroExpressions?.get(expression.start) ?? expression : expression;
  if (!isVerilogLvalueExpression(expanded)) {
    diagnostics.push(makeDiagnostic(fallbackRange ?? Range.create(document.positionAt(expression.start), document.positionAt(expression.end)), 'This connection requires an assignable net lvalue.', DiagnosticSeverity.Error, 'invalid-assignment-target'));
    return;
  }
  for (const target of assignmentTargetsFromExpressionAst(document, expression)) {
    for (const access of expressionAccessPaths(document, module, target.expression, fallbackRange?.start ?? target.range.start)) {
      const decl = access.declaration;
      if (!decl) { continue; }
      const parameter = decl.kind === 'parameter' || decl.kind === 'localparam';
      const variable = declarationIsVariable(decl);
      if (!parameter && (expected === 'variable' ? variable || decl.kind === 'function' : !variable)) { continue; }
      const message = parameter ? `Parameter '${access.name}' cannot be assigned.`
        : expected === 'variable' ? `Procedural assignment target '${access.name}' must be a variable; it is a net.`
        : `Continuous or output assignment target '${access.name}' must be a net; it is a variable.`;
      diagnostics.push(makeDiagnostic(fallbackRange ?? target.range, message, DiagnosticSeverity.Error, 'invalid-assignment-target'));
    }
  }
}
