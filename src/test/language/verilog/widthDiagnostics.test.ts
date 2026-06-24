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
              NOP = 6'b000000;

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

  it('reports a declaration initializer whose concatenation overflows the wire', () => {
    const result = codes(`
module m(input [15:0] imm16);
    wire [31:0] zero_ext = {20'h0000, imm16};
endmodule
`.trim());
    expect(result).toContain('width-mismatch');
  });

  it('does not flag a correctly sized zero-extension concatenation initializer', () => {
    const result = codes(`
module m(input [15:0] imm16);
    wire [31:0] zero_ext = {16'h0000, imm16};
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('does not flag widening a narrow signal (extension is not truncation)', () => {
    const result = codes(`
module m(input [7:0] sig8, output [31:0] y);
    wire [31:0] ext = sig8;
    assign y = sig8;
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('reports a declaration initializer that truncates a sized literal', () => {
    const result = codes(`
module m;
    reg [3:0] small = 8'hff;
endmodule
`.trim());
    expect(result).toContain('width-mismatch');
  });

  it('reports an unsized decimal literal that does not fit its target', () => {
    const result = codes(`
module m;
    reg [3:0] small = 42;
endmodule
`.trim());
    expect(result).toContain('width-mismatch');
  });

  it('does not flag unsized 0/1 assignments to one-bit testbench registers', () => {
    const result = codes(`
module tb;
    reg clk;
    reg reset;
    initial begin
        clk = 0;
        reset = 1;
        reset = 0;
        $finish;
    end
    always #1 clk = ~clk;
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('uses packed element width for unpacked memory assignments', () => {
    const result = codes(`
module TC(input clk, input [31:0] din);
    reg [31:0] mem [2:0];
    integer i;
    always @(posedge clk) begin
        for (i = 0; i < 3; i = i + 1) mem[i] <= 0;
        mem[1] <= din;
    end
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('does not flag case equality operators (===, !==)', () => {
    const result = codes(`
module m(input [31:0] a, input [31:0] b, output eq, output neq);
    assign eq = a === b;
    assign neq = a !== b;
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('does not flag XNOR binary operator in correct-width assignment', () => {
    const result = codes(`
module m(input [31:0] a, input [31:0] b, output [31:0] y);
    assign y = a ~^ b;
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('does not flag reduction NAND/NOR/XNOR operators', () => {
    const result = codes(`
module m(input [31:0] a, output nand_all, output nor_all, output xnor_all);
    assign nand_all = ~&a;
    assign nor_all  = ~|a;
    assign xnor_all = ~^a;
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('does not flag indexed part selects (+:, -:)', () => {
    const result = codes(`
module m(input [31:0] a, output [3:0] lo, output [7:0] hi);
    assign lo = a[3+:4];
    assign hi = a[7-:8];
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('flags indexed part select that truncates', () => {
    const result = codes(`
module m(input [31:0] a, output [3:0] y);
    assign y = a[7+:8];
endmodule
`.trim());
    expect(result).toContain('width-mismatch');
  });

  it('does not flag power operator in correct context', () => {
    const result = codes(`
module m(input [3:0] a, input [3:0] b, output [31:0] y);
    assign y = a ** b;
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('does not flag MDU-style signed multiply into {HI, LO} concatenation', () => {
    const result = codes(`
module m(input [31:0] a, input [31:0] b, output [31:0] hi_out, output [31:0] lo_out);
    wire [31:0] HI;
    wire [31:0] LO;
    assign {HI, LO} = $signed(a) * $signed(b);
    assign hi_out = HI;
    assign lo_out = LO;
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('does not flag MDU-style signed division into single register', () => {
    const result = codes(`
module m(input [31:0] a, input [31:0] b, output [31:0] q);
    assign q = $signed(a) / $signed(b);
endmodule
`.trim());
    expect(result).not.toContain('width-mismatch');
  });

  it('reports width mismatch when MDU-style expression overflows its target', () => {
    const result = codes(`
module m(input [31:0] a, input [31:0] b, output [15:0] y);
    assign y = $signed(a) * $signed(b);
endmodule
`.trim());
    expect(result).toContain('width-mismatch');
  });

  it('reports procedural assignment width mismatch after an if prefix', () => {
    const result = codes(`
module m(input sel, input [7:0] a, output reg [3:0] y);
    always @(*) begin
        if (sel) y = a;
        else y = 4'h0;
    end
endmodule
`.trim());
    expect(result).toContain('width-mismatch');
  });

  it('reports procedural assignment width mismatch after a case item label', () => {
    const result = codes(`
module m(input sel, input [7:0] a, output reg [3:0] y);
    always @(*) begin
        case (sel)
            1'b0: y = a;
            default: y = 4'h0;
        endcase
    end
endmodule
`.trim());
    expect(result).toContain('width-mismatch');
  });

  it('does not duplicate simple procedural assignment width diagnostics', () => {
    const result = codes(`
module m(input [7:0] a, output reg [3:0] y);
    always @(*) begin
        y = a;
    end
endmodule
`.trim());
    expect(result.filter((code) => code === 'width-mismatch')).toHaveLength(1);
  });
});
