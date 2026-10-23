// @index concatenation-diagnostics — self-determined operand widths and zero-width replication contexts
import { Diagnostic, DiagnosticSeverity, Position, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import type { VerilogAstDocument } from './ast';
import type { VerilogExpressionAst } from './exprAst';
import { childrenOfVerilogExpression } from './exprAstUtils';
import { evalExpressionAstConstant } from './expressions';
import { moduleExpressionRoots } from './expressionTraversal';
import { VERILOG_EVALUATION_LIMITS } from './typedConstants';

export function collectConcatenationDiagnostics(document: TextDocument, ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  for (const moduleAst of ast.modules) {
    const module = moduleAst.module, seen = new Set<string>();
    const isZeroWidth = (expression: VerilogExpressionAst, position: Position, depth = 0): boolean => {
      if (depth >= VERILOG_EVALUATION_LIMITS.depth) return false;
      if (expression.kind === 'parenthesizedExpression') return isZeroWidth(expression.expression, position, depth + 1);
      if (expression.kind === 'identifier' && expression.name.startsWith('`')) {
        const expansion = module.macroExpressions?.get(expression.start);
        return expansion ? isZeroWidth(expansion, position, depth + 1) : false;
      }
      if (expression.kind !== 'concatenation' && expression.kind !== 'multipleConcatenation') return false;
      if (expression.kind === 'multipleConcatenation' && evalExpressionAstConstant(expression.repeat, module, undefined, position) === 0n) return true;
      return expression.elements.length > 0 && expression.elements.every((element) => isZeroWidth(element, position, depth + 1));
    };
    function report(expression: VerilogExpressionAst, message: string, code: string): void {
      const key = `${code}:${expression.start}:${expression.end}`;
      if (seen.has(key)) return;
      seen.add(key);
      diagnostics.push(makeDiagnostic(Range.create(document.positionAt(expression.start), document.positionAt(expression.end)), message, DiagnosticSeverity.Error, code));
    }
    const visit = (expression: VerilogExpressionAst, concatenationOperand = false, source?: VerilogExpressionAst, position = document.positionAt(expression.start), depth = 0): void => {
      if (depth >= VERILOG_EVALUATION_LIMITS.depth) return;
      if (expression.kind === 'identifier' && expression.name.startsWith('`')) {
        const expansion = module.macroExpressions?.get(expression.start);
        if (expansion) visit(expansion, concatenationOperand, source ?? expression, position, depth + 1);
        return;
      }
      if (expression.kind === 'concatenation' || expression.kind === 'multipleConcatenation') {
        if (!concatenationOperand && isZeroWidth(expression, position)) report(source ?? expression, 'A concatenation used as a value must have a nonzero width.', 'zero-width-concatenation');
        if (expression.kind === 'multipleConcatenation') {
          const count = evalExpressionAstConstant(expression.repeat, module, undefined, position);
          if (count !== undefined && count < 0n) report(source ?? expression.repeat, 'Replication count must not be negative.', 'invalid-replication-count');
          visit(expression.repeat, false, source, position, depth + 1);
        }
        for (const element of expression.elements) {
          if (hasIndefiniteWidth(element, module.macroExpressions)) report(source ?? element, 'Concatenation operands must have a definite width; size the integer literal explicitly.', 'indefinite-concatenation-width');
          visit(element, true, source, position, depth + 1);
        }
      } else if (expression.kind === 'parenthesizedExpression') visit(expression.expression, concatenationOperand, source, position, depth + 1);
      else childrenOfVerilogExpression(expression).forEach((child) => visit(child, false, source, position, depth + 1));
    };
    moduleExpressionRoots(moduleAst).forEach((expression) => visit(expression));
  }
}

function hasIndefiniteWidth(expression: VerilogExpressionAst, macros?: ReadonlyMap<number, VerilogExpressionAst>, depth = 0): boolean {
  if (depth >= VERILOG_EVALUATION_LIMITS.depth) return false;
  const child = (node: VerilogExpressionAst) => hasIndefiniteWidth(node, macros, depth + 1);
  switch (expression.kind) {
    case 'numberLiteral': return expression.parsed?.kind === 'decimal' || (expression.parsed?.kind === 'based' && expression.parsed.size === undefined);
    case 'identifier': { const expansion = expression.name.startsWith('`') && macros?.get(expression.start); return expansion ? child(expansion) : false; }
    case 'parenthesizedExpression': return child(expression.expression);
    case 'mintypmaxExpression': return child(expression.typical);
    case 'unaryExpression': return ['+', '-', '~'].includes(expression.operator) && child(expression.argument);
    case 'binaryExpression':
      if (['==', '!=', '===', '!==', '<', '<=', '>', '>=', '&&', '||'].includes(expression.operator)) return false;
      return ['<<', '>>', '<<<', '>>>', '**'].includes(expression.operator) ? child(expression.left) : child(expression.left) || child(expression.right);
    case 'conditionalExpression': return child(expression.whenTrue) || child(expression.whenFalse);
    default: return false;
  }
}
