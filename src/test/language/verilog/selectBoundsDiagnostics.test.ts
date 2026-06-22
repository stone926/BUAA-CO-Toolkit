import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';

let documentVersion = 1;

function doc(text: string): TextDocument {
  return TextDocument.create(`test://select-bounds-${documentVersion}.v`, 'verilog', documentVersion++, text);
}

function codes(text: string): string[] {
  return getVerilogDiagnostics(doc(text), mergeCoSettings({}))
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

describe('Verilog select bounds diagnostics', () => {
  it('reports constant bit-selects outside the declared vector range', () => {
    const result = codes(`
module m(input [7:0] a, output y);
    assign y = a[8];
endmodule
`.trim());

    expect(result).toContain('select-out-of-range');
  });

  it('reports constant range-selects outside the declared vector range', () => {
    const result = codes(`
module m(input [7:0] a, output [3:0] y);
    assign y = a[8:5];
endmodule
`.trim());

    expect(result).toContain('select-out-of-range');
  });

  it('reports indexed part-selects that exceed the declared vector range', () => {
    const result = codes(`
module m(input [7:0] a, output [3:0] y);
    assign y = a[6+:4];
endmodule
`.trim());

    expect(result).toContain('select-out-of-range');
  });

  it('reports out-of-range selects in declaration initializers', () => {
    const result = codes(`
module m(input [7:0] a);
    wire y = a[8];
endmodule
`.trim());

    expect(result).toContain('select-out-of-range');
  });

  it('reports out-of-range selects in instance port expressions', () => {
    const result = codes(`
module child(input a);
endmodule

module top(input [7:0] bus);
    child u_child(.a(bus[8]));
endmodule
`.trim());

    expect(result).toContain('select-out-of-range');
  });

  it('uses parameterized declaration ranges for select bounds', () => {
    const result = codes(`
module m(input [W-1:0] a, output y);
    parameter W = 8;
    assign y = a[W];
endmodule
`.trim());

    expect(result).toContain('select-out-of-range');
  });

  it('accepts constant selects inside non-zero declared ranges', () => {
    const result = codes(`
module m(input [8:1] a, output y);
    assign y = a[8];
endmodule
`.trim());

    expect(result).not.toContain('select-out-of-range');
  });

  it('does not report dynamic indexes or memory accesses as packed select bounds', () => {
    const result = codes(`
module m(input [7:0] idx, output [31:0] y);
    reg [31:0] mem [0:4095];
    assign y = mem[100] + idx[idx];
endmodule
`.trim());

    expect(result).not.toContain('select-out-of-range');
  });
});
