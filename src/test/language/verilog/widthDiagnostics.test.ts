import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';

let documentVersion = 1;

function doc(text: string): TextDocument {
  return TextDocument.create(`test://width-${documentVersion}.v`, 'verilog', documentVersion++, text);
}

function codes(text: string): string[] {
  return getVerilogDiagnostics(doc(text), mergeCoSettings({}))
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

describe('Verilog width diagnostics', () => {
  it('does not flag ternary chains whose branches are sized parameters', () => {
    const result = codes(`
module control(
    input add,
    input sub,
    input addiu,
    input xori,
    input lui,
    input lw,
    input sw,
    input beq,
    input ori,
    output [5:0] type
);
    parameter ADD = 6'b100000,
              SUB = 6'b100010,
              ADDIU = 6'b001001,
              XORI = 6'b001110,
              LUI = 6'b001111,
              LW = 6'b100011,
              SW = 6'b101011,
              BEQ = 6'b000100,
              ORI = 6'b001101,
              NOP = 0;

    assign type =
        add ? ADD :
        sub ? SUB :
        addiu ? ADDIU :
        xori ? XORI :
        lui ? LUI :
        lw ? LW :
        sw ? SW :
        beq ? BEQ :
        ori ? ORI : NOP;
endmodule
`.trim());

    expect(result).not.toContain('width-mismatch');
  });

  it('does not flag a multiply assigned to a wider result', () => {
    const result = codes(`
module m(input [3:0] a, input [3:0] b, output [7:0] c);
    assign c = a * b;
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('does not flag a carry-capturing concatenation target (\`{co, sum} = a + b\`)', () => {
    const result = codes(`
module m(input [3:0] a, input [3:0] b, output co, output [3:0] sum);
    assign {co, sum} = a + b;
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('computes nested concatenation width \`{a, {b, c}}\`', () => {
    const result = codes(`
module m(input [1:0] a, input b, input c, output [3:0] y);
    assign y = {a, {b, c}};
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('still reports a concatenation that is wider than its target', () => {
    const result = codes(`
module m(input [3:0] a, input [3:0] b, output [3:0] y);
    assign y = {a, b};
endmodule
`.trim());
    expect(result).toContain('width-mismatch');
  });
});
