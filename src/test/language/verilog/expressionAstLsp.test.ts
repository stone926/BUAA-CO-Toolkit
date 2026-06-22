import { describe, expect, it } from 'vitest';
import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import {
  getVerilogCodeActions,
  getVerilogDiagnostics,
  getVerilogHover
} from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let documentVersion = 1;

function doc(text: string): TextDocument {
  return TextDocument.create(`test://expr-lsp-${documentVersion}.v`, 'verilog', documentVersion++, text);
}

function positionOf(document: TextDocument, text: string, offset = 0) {
  const index = document.getText().indexOf(text);
  expect(index).toBeGreaterThanOrEqual(0);
  return document.positionAt(index + offset);
}

function hoverText(hover: ReturnType<typeof getVerilogHover>): string {
  const contents = hover?.contents;
  return typeof contents === 'object' && 'value' in contents ? contents.value : '';
}

function codeActionsAt(document: TextDocument, text: string, offset = 0) {
  const position = positionOf(document, text, offset);
  return getVerilogCodeActions(
    document,
    Range.create(position, position),
    [],
    mergeCoSettings({}),
    new VerilogWorkspaceIndex()
  );
}

describe('Verilog expression AST LSP integration', () => {
  it('shows expression AST hover on operators', () => {
    const text = `
module m(input [3:0] a, input [3:0] b, output [7:0] y);
    assign y = a + b * 3;
endmodule
`.trim();
    const document = doc(text);
    const hover = getVerilogHover(
      document,
      positionOf(document, '+'),
      mergeCoSettings({}),
      new VerilogWorkspaceIndex()
    );

    expect(hoverText(hover)).toContain('Expression `a + b * 3`');
    expect(hoverText(hover)).toContain('AST: `binaryExpression`');
    expect(hoverText(hover)).toContain('Width: `32`');
  });

  it('includes evaluated parameter constants in declaration hover', () => {
    const text = `
module m;
    parameter WIDTH = 8;
    wire [WIDTH-1:0] data;
endmodule
`.trim();
    const document = doc(text);
    const hover = getVerilogHover(
      document,
      positionOf(document, 'WIDTH ='),
      mergeCoSettings({}),
      new VerilogWorkspaceIndex()
    );

    expect(hoverText(hover)).toContain('Constant value: `8 (0x8)`');
  });

  it('uses parameterized port widths in diagnostics', () => {
    const text = `
module child #(parameter WIDTH = 4)(input [WIDTH-1:0] din);
endmodule

module top(input [7:0] a);
    child u_child(.din(a));
endmodule
`.trim();
    const diagnostics = getVerilogDiagnostics(doc(text), mergeCoSettings({}), new VerilogWorkspaceIndex());

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('port-width-mismatch');
  });

  it('offers an AST constant fold code action', () => {
    const text = `
module m(output [7:0] y);
    localparam WIDTH = 4;
    assign y = (WIDTH + 1) * 2;
endmodule
`.trim();
    const document = doc(text);
    const actions = codeActionsAt(document, '*');
    const fold = actions.find((action) => action.title === 'Fold constant expression to 10');

    expect(fold?.kind).toBe('refactor.rewrite');
    expect(fold?.edit?.changes?.[document.uri]?.[0].newText).toBe('10');
  });

  it('extracts a constant RHS expression to a localparam', () => {
    const text = `
module m(output [7:0] y);
    localparam WIDTH = 4;
    assign y = (WIDTH + 1) * 2;
endmodule
`.trim();
    const document = doc(text);
    const actions = codeActionsAt(document, '*');
    const extract = actions.find((action) => action.title === 'Extract constant expression to localparam EXPR_CONST');
    const edits = extract?.edit?.changes?.[document.uri] ?? [];

    expect(extract?.kind).toBe('refactor.extract');
    expect(edits.some((edit) => edit.newText === '    localparam EXPR_CONST = (WIDTH + 1) * 2;\n')).toBe(true);
    expect(edits.some((edit) => edit.newText === 'EXPR_CONST')).toBe(true);
  });

  it('uses a unique localparam name when extracting constant expressions', () => {
    const text = `
module m(output [7:0] y);
    localparam EXPR_CONST = 1;
    localparam WIDTH = 4;
    assign y = (WIDTH + 1) * 2;
endmodule
`.trim();
    const document = doc(text);
    const actions = codeActionsAt(document, '*');
    const extract = actions.find((action) => action.title === 'Extract constant expression to localparam EXPR_CONST_1');
    const edits = extract?.edit?.changes?.[document.uri] ?? [];

    expect(edits.some((edit) => edit.newText === '    localparam EXPR_CONST_1 = (WIDTH + 1) * 2;\n')).toBe(true);
    expect(edits.some((edit) => edit.newText === 'EXPR_CONST_1')).toBe(true);
  });

  it('offers a safe redundant parentheses code action', () => {
    const text = `
module m(input a, output y);
    assign y = (a);
endmodule
`.trim();
    const document = doc(text);
    const actions = codeActionsAt(document, '(a)');
    const remove = actions.find((action) => action.title === 'Remove redundant parentheses');

    expect(remove?.kind).toBe('refactor.rewrite');
    expect(remove?.edit?.changes?.[document.uri]?.[0].newText).toBe('a');
  });

  it('does not remove parentheses required by operator precedence', () => {
    const text = `
module m(input a, input b, input c, output y);
    assign y = (a + b) * c;
endmodule
`.trim();
    const document = doc(text);
    const actions = codeActionsAt(document, '(a + b)');

    expect(actions.map((action) => action.title)).not.toContain('Remove redundant parentheses');
  });
});
