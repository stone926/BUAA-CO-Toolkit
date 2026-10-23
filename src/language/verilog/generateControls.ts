// @index generate-controls — structured elaboration control expressions with original source ranges
import { Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { VerilogToken } from './lexer';
import type { VerilogDecl, VerilogModule } from './model';
import { parseVerilogExpressionTokens, VerilogExpressionAst } from './exprAst';
import { parseAssignmentTokens } from './assignmentAnalysis';
import { findMatchingTokenForward, splitTopLevelTokens } from './tokenUtils';
import { parseVerilogDeclarationTokens } from './astParser';
import { parseVerilogProceduralBlockBody } from './proceduralAst';
import { generateItemEnd } from './generateBoundary';

export interface VerilogGenerateControl {
  kind: 'if' | 'case' | 'for';
  range: Range;
  bodyRange?: Range;
  condition?: VerilogExpressionAst;
  initializer?: VerilogExpressionAst;
  update?: VerilogExpressionAst;
  variable?: VerilogExpressionAst;
  updateVariable?: VerilogExpressionAst;
  declaration?: VerilogDecl;
  parameter?: VerilogDecl;
  labels?: VerilogExpressionAst[];
}

export function collectGenerateControls(document: TextDocument, tokens: VerilogToken[], module: VerilogModule, excludedBlocks: Array<{ range: Range }>): VerilogGenerateControl[] {
  const start = document.offsetAt(module.headerEnd), end = document.offsetAt(module.endmoduleRange?.start ?? module.range.end);
  const excluded = excludedBlocks.map(({ range }) => ({ start: document.offsetAt(range.start), end: document.offsetAt(range.end) })).sort((a, b) => a.start - b.start);
  const result: VerilogGenerateControl[] = [];
  let blockIndex = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.start < start || token.start >= end) continue;
    while (excluded[blockIndex]?.end <= token.start) blockIndex++;
    if (excluded[blockIndex] && token.start >= excluded[blockIndex].start) continue;
    if (!['if', 'for', 'case', 'casex', 'casez'].includes(token.value) || tokens[index + 1]?.value !== '(') continue;
    const close = findMatchingTokenForward(tokens, index + 1, '(', ')');
    if (close < 0 || tokens[close].start >= end) continue;
    const control: VerilogGenerateControl = {
      kind: token.value === 'for' ? 'for' : token.value === 'if' ? 'if' : 'case',
      range: Range.create(document.positionAt(token.start), document.positionAt(tokens[close].end))
    };
    const inner = tokens.slice(index + 2, close);
    if (control.kind === 'for') {
      const [init = [], condition = [], update = []] = splitTopLevelTokens(inner, ';');
      const inline = init[0]?.value === 'genvar';
      const initialAssignment = parseAssignmentTokens(inline ? init.slice(1) : init), updateAssignment = parseAssignmentTokens(update);
      if (inline) control.declaration = parseVerilogDeclarationTokens(document, document.getText(), init)[0];
      control.initializer = initialAssignment && parseVerilogExpressionTokens(initialAssignment.rhsTokens);
      control.variable = initialAssignment && parseVerilogExpressionTokens(initialAssignment.lhsTokens);
      control.condition = parseVerilogExpressionTokens(condition);
      control.update = updateAssignment && parseVerilogExpressionTokens(updateAssignment.rhsTokens);
      control.updateVariable = updateAssignment && parseVerilogExpressionTokens(updateAssignment.lhsTokens);
      const bodyEnd = generateItemEnd(tokens, close + 1, end);
      if (bodyEnd > close + 1) {
        control.bodyRange = Range.create(document.positionAt(tokens[close + 1].start), document.positionAt(tokens[bodyEnd - 1].end));
        if (control.variable?.kind === 'identifier') {
          const variableRange = Range.create(document.positionAt(control.variable.start), document.positionAt(control.variable.end));
          control.parameter = { name: control.variable.name, kind: 'localparam', valueType: 'integer', implicitGenerateParameter: true,
            range: variableRange, selectionRange: variableRange };
        }
      }
    } else control.condition = parseVerilogExpressionTokens(inner);
    if (control.kind === 'case') {
      const caseEnd = generateItemEnd(tokens, index, end);
      const tree = parseVerilogProceduralBlockBody(document, tokens.slice(index, caseEnd));
      const statement = tree.statements[0];
      if (statement?.kind === 'case') control.labels = statement.items.flatMap((item) => item.labels);
    }
    result.push(control);
    index = close;
  }
  return result;
}

export function generateControlExpressions(controls: VerilogGenerateControl[]): VerilogExpressionAst[] {
  return controls.flatMap((control) => [control.variable, control.initializer, control.condition, control.updateVariable, control.update, ...(control.labels ?? [])]
    .filter((expression): expression is VerilogExpressionAst => Boolean(expression)));
}
