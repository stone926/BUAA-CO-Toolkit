// @index constant-function-captures — Bound dependencies with static branch pruning, without user-function execution.
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { VerilogSubroutineAst } from './ast';
import type { VerilogExpressionAst } from './exprAst';
import { childrenOfVerilogExpression } from './exprAstUtils';
import { evalExpressionAstConstant } from './expressions';
import type { VerilogDecl, VerilogModule } from './model';
import type { VerilogProceduralStatementAst } from './proceduralAst';
import type { VerilogSemanticReference } from './semanticModel';
import { VERILOG_EVALUATION_LIMITS } from './typedConstants';
import { findTopLevelTokenIndexes } from './tokenUtils';

/** Prune statically unreachable branches; unknown control flow keeps its bound captures. */
export function constantFunctionReadDependencies(document: TextDocument, module: VerilogModule, subroutine: VerilogSubroutineAst, references: VerilogSemanticReference[]): VerilogDecl[] {
  const bound = new Map<number, VerilogDecl>();
  for (const reference of references) {
    const target = reference.symbol?.decl;
    if (target && (target.kind === 'parameter' || target.kind === 'localparam' || target.kind === 'function' && reference.callable)) {
      bound.set(document.offsetAt(reference.range.start), target);
    }
  }
  let steps = 0;
  const permit = (depth: number) => depth < VERILOG_EVALUATION_LIMITS.depth && ++steps <= VERILOG_EVALUATION_LIMITS.steps;
  const merge = (sets: Iterable<Set<VerilogDecl>>): Set<VerilogDecl> => {
    const result = new Set<VerilogDecl>();
    for (const set of sets) for (const declaration of set) result.add(declaration);
    return result;
  };
  const union = (...sets: Set<VerilogDecl>[]) => merge(sets);
  // No function execution or propagation of assignments to local variables.
  const value = (node: VerilogExpressionAst | undefined) => node ? evalExpressionAstConstant(node, module, undefined, document.positionAt(node.start)) : undefined;
  const expression = (node: VerilogExpressionAst | undefined, depth: number): Set<VerilogDecl> => {
    if (!node || !permit(depth)) return new Set();
    if (node.kind === 'conditionalExpression') {
      const condition = value(node.condition);
      const branches = condition === undefined
        ? union(expression(node.whenTrue, depth + 1), expression(node.whenFalse, depth + 1))
        : expression(condition === 0n ? node.whenFalse : node.whenTrue, depth + 1);
      return union(expression(node.condition, depth + 1), branches);
    }
    const target = node.kind === 'identifier' || node.kind === 'callExpression' ? bound.get(node.start) : undefined;
    return merge([new Set(target ? [target] : []), ...childrenOfVerilogExpression(node).map((child) => expression(child, depth + 1))]);
  };
  const statement = (node: VerilogProceduralStatementAst, depth: number): Set<VerilogDecl> => {
    if (!permit(depth)) return new Set();
    const child = (item: VerilogProceduralStatementAst) => statement(item, depth + 1);
    const expr = (item: VerilogExpressionAst | undefined) => expression(item, depth + 1);
    switch (node.kind) {
      case 'block': return merge(node.statements.map(child));
      case 'assignment': return union(expr(node.lhs), expr(node.rhs));
      case 'declaration': return merge(node.declarations.flatMap((item) => [...item.widthExpressions.map(expr), expr(item.initializer)]));
      case 'if': {
        const condition = value(node.condition);
        const alternate = () => node.alternate ? child(node.alternate) : new Set<VerilogDecl>();
        const branches = condition === undefined ? union(child(node.consequent), alternate()) : condition === 0n ? alternate() : child(node.consequent);
        return union(expr(node.condition), branches);
      }
      case 'case': {
        const controls = merge([expr(node.expression), ...node.items.flatMap((item) => item.labels.map(expr))]);
        const selected = value(node.expression);
        const labels = node.items.map((item) => item.labels.map(value));
        const known = selected !== undefined && labels.every((items) => items.every((item) => item !== undefined));
        if (known) {
          const matching = node.items.find((item, index) => !item.defaultItem && labels[index].includes(selected));
          const item = matching ?? node.items.find((candidate) => candidate.defaultItem);
          return union(controls, item ? child(item.body) : new Set());
        }
        const branches = node.items.map((item) => child(item.body));
        return merge([controls, ...branches]);
      }
      case 'loop': {
        if (node.loopKind === 'for') {
          const separators = findTopLevelTokenIndexes(node.controlTokens, (token) => token.value === ';');
          const first = node.controlTokens[separators[0]], second = node.controlTokens[separators[1]];
          const condition = first && second ? node.controlExpressions.find((item) => item.start >= first.end && item.end <= second.start) : undefined;
          if (value(condition) === 0n) return merge(node.controlExpressions.filter((item) => item.end <= second.start).map(expr));
          return merge([...node.controlExpressions.map(expr), child(node.body)]);
        }
        const condition = value(node.condition);
        const executes = node.loopKind === 'forever' || condition === undefined || condition !== 0n;
        return union(expr(node.condition), executes ? child(node.body) : new Set());
      }
      case 'wait': return expr(node.condition);
      case 'other': return expr(node.expression);
    }
  };
  return [...statement(subroutine.statementTree, 0)];
}
