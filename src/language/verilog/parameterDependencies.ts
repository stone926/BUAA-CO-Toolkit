// @index parameter-dependencies — Scope-bound value/type cycles, including bound function captures.
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { childrenOfVerilogExpression } from './exprAstUtils';
import type { VerilogExpressionAst } from './exprAst';
import { resolveDeclarationAt } from './expressions';
import type { VerilogDecl, VerilogModule } from './model';
import { allModuleDeclarations } from './expressionTraversal';
import { VERILOG_EVALUATION_LIMITS } from './typedConstants';

/** Signatures retain bound captures, so formals and shadowed names cannot create edges by spelling. */
function functionParameterCaptures(declaration: VerilogDecl): Set<VerilogDecl> {
  const captures = new Set<VerilogDecl>();
  const visited = new Set<VerilogDecl>();
  const pending = [{ declaration, depth: 0 }];
  let steps = 0;
  while (pending.length && ++steps <= VERILOG_EVALUATION_LIMITS.steps) {
    const current = pending.pop()!;
    if (visited.has(current.declaration) || current.depth >= VERILOG_EVALUATION_LIMITS.depth) continue;
    visited.add(current.declaration);
    for (const dependency of current.declaration.constantFunctionDependencies ?? []) {
      if (dependency.kind === 'parameter' || dependency.kind === 'localparam') captures.add(dependency);
      else if (dependency.kind === 'function') pending.push({ declaration: dependency, depth: current.depth + 1 });
    }
  }
  return captures;
}

export function collectParameterCycleDiagnostics(document: TextDocument, module: VerilogModule, diagnostics: Diagnostic[]): void {
  const parameters = allModuleDeclarations(module).filter((decl) => decl.kind === 'parameter' || decl.kind === 'localparam');
  const graph = new Map<VerilogDecl, Array<{ target: VerilogDecl; range: Range }>>();
  const functionCaptures = new Map<VerilogDecl, Set<VerilogDecl>>();
  for (const parameter of parameters) {
    const edges: Array<{ target: VerilogDecl; range: Range }> = [];
    const roots = [...(parameter.widthAst ?? []), ...(parameter.unpackedDimensions ?? []).flatMap((dimension) => dimension.expressions), ...(parameter.initializerAst ? [parameter.initializerAst] : [])];
    const pending: Array<{ expression: VerilogExpressionAst; origin?: VerilogExpressionAst }> = roots.map((expression) => ({ expression }));
    const visited = new Set<VerilogExpressionAst>();
    let steps = 0;
    while (pending.length && ++steps <= VERILOG_EVALUATION_LIMITS.steps) {
      const { expression, origin } = pending.pop()!;
      if (visited.has(expression)) continue;
      visited.add(expression);
      const location = origin ?? expression;
      const range = Range.create(document.positionAt(location.start), document.positionAt(location.end));
      const binding = parameter.initializerRange?.start ?? parameter.selectionRange.start;
      if (expression.kind === 'identifier') {
        if (expression.name.startsWith('`')) {
          const expansion = module.macroExpressions?.get(expression.start);
          if (expansion) pending.push({ expression: expansion, origin: location });
        } else {
          const target = resolveDeclarationAt(module, expression.name, binding);
          if (target?.kind === 'parameter' || target?.kind === 'localparam') edges.push({ target, range });
        }
      } else if (expression.kind === 'callExpression' && !expression.system) {
        const target = resolveDeclarationAt(module, expression.callee, binding);
        if (target?.kind === 'function') {
          let captures = functionCaptures.get(target);
          if (!captures) { captures = functionParameterCaptures(target); functionCaptures.set(target, captures); }
          const callRange = origin ? range : Range.create(document.positionAt(expression.start), document.positionAt(expression.start + expression.callee.length));
          for (const capture of captures) edges.push({ target: capture, range: callRange });
        }
      }
      for (const child of childrenOfVerilogExpression(expression)) pending.push({ expression: child, origin });
    }
    graph.set(parameter, edges);
  }
  // Explicit DFS frames keep large dependency chains off the JavaScript call stack.
  const complete = new Set<VerilogDecl>();
  for (const root of parameters) {
    if (complete.has(root)) continue;
    const stack = [{ declaration: root, next: 0 }];
    const active = new Map<VerilogDecl, number>([[root, 0]]);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edge = graph.get(frame.declaration)?.[frame.next++];
      if (!edge) {
        complete.add(frame.declaration); active.delete(frame.declaration); stack.pop(); continue;
      }
      const cycleStart = active.get(edge.target);
      if (cycleStart !== undefined) {
        const names = [...stack.slice(cycleStart).map((item) => item.declaration.name), edge.target.name];
        diagnostics.push(makeDiagnostic(edge.range, `Parameter dependency cycle: ${names.join(' -> ')}.`, DiagnosticSeverity.Error, 'parameter-cycle'));
      } else if (!complete.has(edge.target)) {
        active.set(edge.target, stack.length); stack.push({ declaration: edge.target, next: 0 });
      }
    }
  }
}
