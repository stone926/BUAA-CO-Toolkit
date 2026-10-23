// @index expression-traversal — shared expression roots and declaration identities for semantic checks
import type { VerilogModuleAst } from './ast';
import type { VerilogDecl, VerilogModule } from './model';
import type { VerilogExpressionAst } from './exprAst';
import type { VerilogProceduralStatementAst } from './proceduralAst';

/** Includes declarations in nested scopes without collapsing same-named symbols. */
export function allModuleDeclarations(module: VerilogModule): VerilogDecl[] {
  const declarations = [...module.declarations.values(), ...(module.declarationRecords ?? []), ...module.parameters, ...module.ports,
    ...module.generateBlocks.flatMap((scope) => scope.declarations),
    ...(module.lexicalScopes ?? []).flatMap((scope) => scope.declarations)];
  const seen = new Set<string>();
  return declarations.filter((decl) => {
    const key = `${decl.name}:${decl.selectionRange.start.line}:${decl.selectionRange.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function visitProceduralExpressions(statement: VerilogProceduralStatementAst, visit: (expression: VerilogExpressionAst) => void): void {
  const expression = (value: VerilogExpressionAst | undefined) => { if (value) visit(value); };
  switch (statement.kind) {
    case 'block': statement.statements.forEach((child) => visitProceduralExpressions(child, visit)); break;
    case 'assignment': expression(statement.lhs); expression(statement.rhs); break;
    case 'if':
      expression(statement.condition);
      visitProceduralExpressions(statement.consequent, visit);
      if (statement.alternate) visitProceduralExpressions(statement.alternate, visit);
      break;
    case 'case':
      expression(statement.expression);
      for (const item of statement.items) {
        item.labels.forEach(visit);
        visitProceduralExpressions(item.body, visit);
      }
      break;
    case 'loop': statement.controlExpressions.forEach(visit); visitProceduralExpressions(statement.body, visit); break;
    case 'declaration':
      for (const item of statement.declarations) { item.widthExpressions.forEach(visit); expression(item.initializer); }
      break;
    case 'wait': expression(statement.condition); visitProceduralExpressions(statement.body, visit); break;
    case 'other': expression(statement.expression); break;
  }
}

/** Every root uses original document offsets, including scope-local declarations. */
export function moduleExpressionRoots(ast: VerilogModuleAst): VerilogExpressionAst[] {
  const expressions: VerilogExpressionAst[] = [];
  for (const decl of allModuleDeclarations(ast.module)) {
    expressions.push(...(decl.widthAst ?? []), ...(decl.unpackedDimensions ?? []).flatMap((dimension) => dimension.expressions));
    if (decl.initializerAst) expressions.push(decl.initializerAst);
  }
  for (const instance of ast.module.instances) {
    expressions.push(...(instance.arrayRange?.expressions ?? []));
    for (const connection of [...instance.parameterConnections, ...instance.portConnections]) {
      if (connection.expressionAst) expressions.push(connection.expressionAst);
    }
  }
  expressions.push(...ast.generateExpressions);
  for (const item of ast.items) expressions.push(...item.expressions);
  for (const block of [...ast.proceduralBlocks, ...ast.subroutines]) visitProceduralExpressions(block.statementTree, (expression) => expressions.push(expression));
  return [...new Map(expressions.map((expression) => [`${expression.start}:${expression.end}:${expression.kind}`, expression])).values()];
}
