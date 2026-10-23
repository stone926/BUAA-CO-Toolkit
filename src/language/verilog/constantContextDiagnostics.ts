// @index constant-context-diagnostics — elaboration-time expression and genvar constraints
import { Diagnostic, DiagnosticSeverity, Position, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsPosition, makeDiagnostic } from '../common/lsp';
import type { VerilogAstDocument } from './ast';
import { classifyExpressionConstant, resolveDeclarationAt } from './expressions';
import type { VerilogExpressionAst } from './exprAst';
import { walkVerilogExpression } from './exprAstUtils';
import { allModuleDeclarations, moduleExpressionRoots } from './expressionTraversal';
import type { VerilogDecl } from './model';
import { collectParameterCycleDiagnostics } from './parameterDependencies';

export function collectConstantContextDiagnostics(document: TextDocument, ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  for (const moduleAst of ast.modules) {
    const module = moduleAst.module;
    const loops = moduleAst.generateControls.filter((control) => control.kind === 'for').map((control) => ({
      control,
      declaration: control.variable?.kind === 'identifier'
        ? resolveDeclarationAt(module, control.variable.name, document.positionAt(control.variable.start)) : undefined
    }));
    const genvarsAt = (position: Position): Set<VerilogDecl> => new Set(loops.filter(({ control, declaration }) => declaration?.kind === 'genvar' &&
      (containsPosition(control.range, position) || (control.bodyRange && containsPosition(control.bodyRange, position))))
      .flatMap(({ declaration }) => declaration ? [declaration] : []));
    const range = (expression: VerilogExpressionAst) => Range.create(document.positionAt(expression.start), document.positionAt(expression.end));
    const requireConstant = (expression: VerilogExpressionAst | undefined, context: string, source?: VerilogExpressionAst) => {
      if (!expression) return;
      const position = document.positionAt((source ?? expression).start);
      if (classifyExpressionConstant(expression, module, undefined, position, genvarsAt(position)) === 'nonConstant') {
        diagnostics.push(makeDiagnostic(range(source ?? expression), `${context} requires a constant expression.`, DiagnosticSeverity.Error, 'nonconstant-expression'));
      }
    };
    for (const declaration of allModuleDeclarations(module)) {
      declaration.widthAst?.forEach((expression) => requireConstant(expression, 'Packed declaration range'));
      declaration.unpackedDimensions?.forEach((dimension) => dimension.expressions.forEach((expression) => requireConstant(expression, 'Unpacked array dimension')));
      if (declaration.kind === 'parameter' || declaration.kind === 'localparam') requireConstant(declaration.initializerAst, 'Parameter initializer');
    }
    for (const instance of module.instances) instance.arrayRange?.expressions.forEach((expression) => requireConstant(expression, 'Instance array range'));
    for (const control of moduleAst.generateControls) {
      requireConstant(control.initializer, 'Generate loop initializer');
      requireConstant(control.condition, 'Generate condition');
      requireConstant(control.update, 'Generate loop update');
      control.labels?.forEach((expression) => requireConstant(expression, 'Generate case label'));
    }
    for (const { control, declaration } of loops) {
      if (control.variable && declaration && declaration.kind !== 'genvar') diagnostics.push(makeDiagnostic(range(control.variable), 'A generate-for loop variable must be declared as genvar.', DiagnosticSeverity.Error, 'generate-loop-variable'));
      if (control.updateVariable && control.variable?.kind === 'identifier' && control.updateVariable.kind === 'identifier' && control.updateVariable.name !== control.variable.name) {
        diagnostics.push(makeDiagnostic(range(control.updateVariable), 'A generate-for update must assign its own loop variable.', DiagnosticSeverity.Error, 'generate-loop-variable'));
      }
    }
    const checked = new Set<string>();
    const visit = (expression: VerilogExpressionAst, source?: VerilogExpressionAst): void => {
      walkVerilogExpression(expression, (node) => {
        const key = `${node.start}:${node.end}:${source?.start ?? ''}`;
        if (checked.has(key)) return;
        checked.add(key);
        if (node.kind === 'identifier') {
          if (node.name.startsWith('`')) {
            const expansion = module.macroExpressions?.get(node.start);
            if (expansion) visit(expansion, source ?? node);
            return;
          }
          const position = document.positionAt((source ?? node).start);
          const declaration = resolveDeclarationAt(module, node.name, position);
          if (declaration?.kind === 'genvar' && !genvarsAt(position).has(declaration)) diagnostics.push(makeDiagnostic(range(source ?? node), `Genvar '${node.name}' is only available in its generate-for control and elaborated body.`, DiagnosticSeverity.Error, 'invalid-genvar-use'));
        } else if (node.kind === 'selectExpression') {
          if (node.select.kind === 'rangeSelect') {
            requireConstant(node.select.left, 'Part-select bound', source);
            requireConstant(node.select.right, 'Part-select bound', source);
          } else if (node.select.kind === 'indexedPartSelect') requireConstant(node.select.width, 'Indexed part-select width', source);
        } else if (node.kind === 'multipleConcatenation') requireConstant(node.repeat, 'Replication count', source);
      });
    };
    moduleExpressionRoots(moduleAst).forEach((expression) => visit(expression));
    collectParameterCycleDiagnostics(document, module, diagnostics);
  }
}
