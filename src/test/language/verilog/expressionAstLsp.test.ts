import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import {
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
});
