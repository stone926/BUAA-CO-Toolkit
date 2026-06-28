import { describe, expect, it } from 'vitest';
import { Range } from 'vscode-languageserver/node';
import { defaultCoSettings } from '../../../language/common/settings';
import {
  getVerilogDefinition,
  getVerilogHover,
  getVerilogInlayHints,
  getVerilogSignatureHelp
} from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';
import { positionOf, verilogDoc } from '../../helpers/textDocument';

function hoverText(hover: ReturnType<typeof getVerilogHover>): string {
  const contents = hover?.contents;
  return typeof contents === 'object' && 'value' in contents ? contents.value : '';
}

function inlayLabels(document: ReturnType<typeof verilogDoc>, index: VerilogWorkspaceIndex): string[] {
  return getVerilogInlayHints(document, Range.create(0, 0, document.lineCount, 0), defaultCoSettings, index)
    .map((hint) => typeof hint.label === 'string' ? hint.label : hint.label.map((part) => part.value).join(''));
}

describe('Verilog instance provider features', () => {
  it('uses one instance context for named connection definition, hover, signature help, and inlay hints', () => {
    const document = verilogDoc(`
module child #(parameter WIDTH = 4, parameter DEPTH = 16)(
    input [WIDTH-1:0] din,
    output [DEPTH-1:0] dout
);
endmodule

module top(input [7:0] a, output [15:0] y);
    child #(.WIDTH(8), .DEPTH(16)) u_child(.din(a), .dout(y));
endmodule
`.trim());
    const index = new VerilogWorkspaceIndex();
    index.updateDocument(document, defaultCoSettings);

    const parameterDefinition = getVerilogDefinition(document, positionOf(document, '.WIDTH', 1), defaultCoSettings, index);
    const portDefinition = getVerilogDefinition(document, positionOf(document, '.din', 1), defaultCoSettings, index);
    expect(document.getText(parameterDefinition!.range)).toBe('WIDTH');
    expect(document.getText(portDefinition!.range)).toBe('din');
    expect(hoverText(getVerilogHover(document, positionOf(document, '.din', 1), defaultCoSettings, index))).toContain('Effective width: `8`');
    expect(getVerilogSignatureHelp(document, positionOf(document, '.dout', 2), defaultCoSettings, index)?.activeParameter).toBe(1);
    expect(inlayLabels(document, index)).toEqual(expect.arrayContaining([': param', ': in[8]', ': out[16]']));
  });

  it('computes active parameters for positional parameter and port lists', () => {
    const document = verilogDoc(`
module child #(parameter WIDTH = 4, parameter DEPTH = 16)(
    input [WIDTH-1:0] din,
    output [DEPTH-1:0] dout
);
endmodule

module top(input [7:0] a, output [31:0] y);
    child #(8, 32) u_ordered(a, y);
endmodule
`.trim());
    const index = new VerilogWorkspaceIndex();
    index.updateDocument(document, defaultCoSettings);

    expect(getVerilogSignatureHelp(document, positionOf(document, '32'), defaultCoSettings, index)?.activeParameter).toBe(1);
    expect(getVerilogSignatureHelp(document, positionOf(document, 'u_ordered(a, y);', 'u_ordered(a, '.length), defaultCoSettings, index)?.activeParameter).toBe(1);
  });

  it('keeps signature help stable for empty and trailing-comma connection lists while editing', () => {
    const document = verilogDoc(`
module child(input a, output b);
endmodule

module top(input x, output y);
    child u_empty();
    child u_trailing(x, );
endmodule
`.trim());
    const index = new VerilogWorkspaceIndex();
    index.updateDocument(document, defaultCoSettings);

    expect(() => getVerilogSignatureHelp(document, positionOf(document, '();', 1), defaultCoSettings, index)).not.toThrow();
    expect(getVerilogSignatureHelp(document, positionOf(document, 'x, );', 2), defaultCoSettings, index)?.activeParameter).toBe(1);
  });
});
