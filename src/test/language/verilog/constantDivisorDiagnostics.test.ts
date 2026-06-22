import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let documentVersion = 1;

function doc(text: string): TextDocument {
  return TextDocument.create(`test://constant-divisor-${documentVersion}.v`, 'verilog', documentVersion++, text);
}

function codes(text: string): string[] {
  return getVerilogDiagnostics(doc(text), mergeCoSettings({}), new VerilogWorkspaceIndex())
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

describe('Verilog constant divisor diagnostics', () => {
  it('reports constant division by zero in assignment expressions', () => {
    const result = codes(`
module m(input [7:0] a, output [7:0] y);
    localparam ZERO = 0;
    assign y = a / ZERO;
endmodule
`.trim());

    expect(result).toContain('constant-division-by-zero');
  });

  it('reports constant modulo by zero in declaration initializers', () => {
    const result = codes(`
module m;
    localparam DEN = 2 - 2;
    wire [3:0] y = 8 % DEN;
endmodule
`.trim());

    expect(result).toContain('constant-division-by-zero');
  });

  it('reports constant division by zero in instance port expressions', () => {
    const result = codes(`
module child(input [7:0] a);
endmodule

module top(input [7:0] x);
    child u_child(.a(x / 0));
endmodule
`.trim());

    expect(result).toContain('constant-division-by-zero');
  });

  it('does not report variable divisors', () => {
    const result = codes(`
module m(input [7:0] a, input [7:0] b, output [7:0] y);
    assign y = a / b;
endmodule
`.trim());

    expect(result).not.toContain('constant-division-by-zero');
  });
});
