import { describe, expect, it } from 'vitest';
import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import {
  getVerilogCodeActions,
  getVerilogDiagnostics,
  getVerilogHover,
  getVerilogInlayHints
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

function inlayLabels(document: TextDocument): string[] {
  return getVerilogInlayHints(
    document,
    Range.create(0, 0, document.lineCount, 0),
    mergeCoSettings({}),
    new VerilogWorkspaceIndex()
  ).map((hint) => typeof hint.label === 'string' ? hint.label : hint.label.map((part) => part.value).join(''));
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

  it('keeps hover on parsed subexpressions when an assignment is incomplete', () => {
    const text = `
module m(input [3:0] a, input [3:0] b, output [7:0] y);
    assign y = (a + b) *;
endmodule
`.trim();
    const document = doc(text);
    const hover = getVerilogHover(
      document,
      positionOf(document, '+'),
      mergeCoSettings({}),
      new VerilogWorkspaceIndex()
    );

    expect(hoverText(hover)).toContain('Expression `a + b`');
    expect(hoverText(hover)).toContain('AST: `binaryExpression`');
    expect(hoverText(hover)).toContain('Width: `4`');
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

  it('shows effective instance parameters and port widths in hover and inlay hints', () => {
    const text = `
module child #(parameter WIDTH = 4, parameter DEPTH = 16)(
    input [WIDTH-1:0] din,
    output [DEPTH-1:0] dout
);
endmodule

module top(input [7:0] a, output [15:0] y);
    child #(.WIDTH(8), .DEPTH(16)) u_child(.din(a), .dout(y));
    child #(8, 16) u_ordered(a, y);
endmodule
`.trim();
    const document = doc(text);
    const settings = mergeCoSettings({});
    const index = new VerilogWorkspaceIndex();

    const instanceHover = getVerilogHover(document, positionOf(document, 'u_child'), settings, index);
    expect(hoverText(instanceHover)).toContain('WIDTH = 8 (0x8) // override');
    expect(hoverText(instanceHover)).toContain('DEPTH = 16 (0x10) // override');

    const parameterHover = getVerilogHover(document, positionOf(document, '.WIDTH', 1), settings, index);
    expect(hoverText(parameterHover)).toContain('Parameter `WIDTH` on module `child`');
    expect(hoverText(parameterHover)).toContain('Effective value: `8 (0x8)`');

    const portHover = getVerilogHover(document, positionOf(document, '.din', 1), settings, index);
    expect(hoverText(portHover)).toContain('Port `din` on module `child`');
    expect(hoverText(portHover)).toContain('Effective width: `8`');
    expect(hoverText(portHover)).toContain('Connection width: `8`');

    expect(inlayLabels(document)).toEqual(expect.arrayContaining([
      ': param',
      ': in[8]',
      ': out[16]',
      '.WIDTH=',
      '.DEPTH=',
      '.din: in[8]=',
      '.dout: out[16]='
    ]));
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

  it('extracts a non-constant RHS expression to a wire', () => {
    const text = `
module m(input [7:0] a, input [7:0] b, output [7:0] y);
    assign y = a + b;
endmodule
`.trim();
    const document = doc(text);
    const actions = codeActionsAt(document, '+');
    const extract = actions.find((action) => action.title === 'Extract expression to wire EXPR_WIRE');
    const edits = extract?.edit?.changes?.[document.uri] ?? [];

    expect(extract?.kind).toBe('refactor.extract');
    expect(edits.some((edit) => edit.newText === '    wire [7:0] EXPR_WIRE;\n    assign EXPR_WIRE = a + b;\n')).toBe(true);
    expect(edits.some((edit) => edit.newText === 'EXPR_WIRE')).toBe(true);
  });

  it('uses a unique wire name when extracting non-constant expressions', () => {
    const text = `
module m(input [7:0] a, input [7:0] b, output [7:0] y);
    wire [7:0] EXPR_WIRE;
    assign y = a + b;
endmodule
`.trim();
    const document = doc(text);
    const actions = codeActionsAt(document, '+');
    const extract = actions.find((action) => action.title === 'Extract expression to wire EXPR_WIRE_1');
    const edits = extract?.edit?.changes?.[document.uri] ?? [];

    expect(edits.some((edit) => edit.newText === '    wire [7:0] EXPR_WIRE_1;\n    assign EXPR_WIRE_1 = a + b;\n')).toBe(true);
    expect(edits.some((edit) => edit.newText === 'EXPR_WIRE_1')).toBe(true);
  });

  it('does not extract constant expressions to wires', () => {
    const text = `
module m(output [7:0] y);
    localparam WIDTH = 4;
    assign y = (WIDTH + 1) * 2;
endmodule
`.trim();
    const document = doc(text);
    const actions = codeActionsAt(document, '*');

    expect(actions.map((action) => action.title)).not.toContain('Extract expression to wire EXPR_WIRE');
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
