// @index subroutine-diagnostics — Bound callable signatures and function body restrictions
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsRange, makeDiagnostic } from '../common/lsp';
import { rangeKey } from '../common/util';
import type { VerilogAstDocument } from './ast';
import { collectLvalueTypeDiagnostics } from './assignmentTypeDiagnostics';
import type { VerilogCallExpressionAst, VerilogExpressionAst } from './exprAst';
import { walkVerilogExpression } from './exprAstUtils';
import { moduleExpressionRoots } from './expressionTraversal';
import { hasUnexpandedDeclarationDependencies } from './declarationDependencies';
import { visitProceduralAssignments } from './assignmentAst';
import type { VerilogModule } from './model';
import type { VerilogSemanticModel } from './semanticModel';

/** Verilog-2005 is the production language; SV callers keep its wider formal/body rules. */
export function collectSubroutineDiagnostics(document: TextDocument, ast: VerilogAstDocument, semantic: VerilogSemanticModel, diagnostics: Diagnostic[]): void {
  const calls = new Map<string, VerilogCallExpressionAst>();
  const unresolvedDeclarations = new Set<VerilogModule>();
  const expression = (node: VerilogExpressionAst | undefined): void => {
    if (!node) return;
    walkVerilogExpression(node, (candidate) => {
      if (candidate.kind !== 'callExpression' || candidate.system) return;
      calls.set(rangeKey(Range.create(document.positionAt(candidate.start), document.positionAt(candidate.start + candidate.callee.length))), candidate);
    });
  };
  for (const module of ast.modules) {
    const incompleteDeclarations = hasUnexpandedDeclarationDependencies(ast, module);
    if (incompleteDeclarations) unresolvedDeclarations.add(module.module);
    moduleExpressionRoots(module).forEach(expression);
    for (const subroutine of module.subroutines) {
      const signature = subroutine.signature;
      if (!signature) continue;
      if (document.languageId === 'verilog') {
        if (signature.kind === 'function') {
          if (signature.complete !== false && !signature.formals.some((formal) => formal.direction === 'input')) {
            diagnostics.push(makeDiagnostic(signature.declaration.selectionRange, 'A Verilog-2005 function must declare at least one input formal.', DiagnosticSeverity.Error, 'function-missing-input'));
          }
          for (const formal of signature.formals) {
            if (formal.direction === 'output' || formal.direction === 'inout') diagnostics.push(makeDiagnostic(formal.directionRange ?? formal.selectionRange, 'Verilog-2005 function formals must be inputs.', DiagnosticSeverity.Error, 'function-formal-direction'));
          }
        }
        if (signature.complete !== false && subroutine.statementTree.tokens[0]?.value !== 'begin' && !subroutine.statementTree.statements.some((child) => child.kind !== 'declaration')) diagnostics.push(makeDiagnostic(signature.declaration.selectionRange, 'A Verilog-2005 function or task must contain a statement body.', DiagnosticSeverity.Error, 'subroutine-missing-body'));
      }
      if (signature.kind !== 'function') continue;
      for (const token of subroutine.bodyTokens) {
        if (token.value === '#' || token.value === '@' || token.value === 'wait') diagnostics.push(makeDiagnostic(Range.create(document.positionAt(token.start), document.positionAt(token.end)), 'Functions cannot contain delay, event, or wait controls.', DiagnosticSeverity.Error, 'function-timing-control'));
      }
      visitProceduralAssignments(subroutine.statementTree, (assignment) => {
        if (assignment.operator !== '<=') return;
        const operator = assignment.tokens.find((token) => token.value === '<=');
        diagnostics.push(makeDiagnostic(operator ? Range.create(document.positionAt(operator.start), document.positionAt(operator.end)) : assignment.range, 'Functions cannot contain nonblocking assignments.', DiagnosticSeverity.Error, 'function-nonblocking-assignment'));
      });
    }
  }
  for (const reference of semantic.references) {
    if (!reference.callable || reference.name.includes('.') || reference.name.startsWith('`')) continue;
    const declaration = reference.symbol?.decl;
    if (!declaration || declaration.kind !== 'task' && declaration.kind !== 'function') {
      if (!declaration && reference.module && unresolvedDeclarations.has(reference.module)) continue;
      diagnostics.push(makeDiagnostic(reference.range, declaration ? `'${reference.name}' is not a callable function or task.` : `Unknown ${reference.callable} '${reference.name}'.`, DiagnosticSeverity.Error, 'unknown-subroutine'));
      continue;
    }
    if (declaration.kind === 'task' && ast.modules.some((module) => module.module === reference.module && module.subroutines.some((routine) => routine.subroutineKind === 'function' && containsRange(routine.bodyRange, reference.range)))) {
      diagnostics.push(makeDiagnostic(reference.range, 'Functions cannot call tasks.', DiagnosticSeverity.Error, 'function-task-call'));
      continue;
    }
    if (declaration.kind !== reference.callable) {
      diagnostics.push(makeDiagnostic(reference.range, `A ${declaration.kind} cannot be used as a ${reference.callable} call.`, DiagnosticSeverity.Error, 'subroutine-call-kind'));
      continue;
    }
    const signature = reference.module?.subroutines?.find((entry) => entry.declaration === declaration);
    if (!signature || signature.complete === false) continue;
    const args = calls.get(rangeKey(reference.range))?.args ?? [];
    if (args.length !== signature.formals.length) diagnostics.push(makeDiagnostic(reference.range, `${signature.kind} '${signature.name}' expects ${signature.formals.length} arguments, but received ${args.length}.`, DiagnosticSeverity.Error, 'subroutine-argument-count'));
    if (signature.kind === 'task' && reference.module) {
      signature.formals.forEach((formal, index) => {
        if (args[index] && (formal.direction === 'output' || formal.direction === 'inout')) collectLvalueTypeDiagnostics(document, reference.module!, args[index], 'variable', diagnostics);
      });
    }
  }
}
