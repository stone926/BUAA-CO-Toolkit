import { describe, expect, it } from 'vitest';
import { defaultCoSettings } from '../../../language/common/settings';
import { buildStimulusTestbench, buildTestbench, parseVerilog } from '../../../language/verilog/service';
import { verilogDoc } from '../../helpers/textDocument';

function moduleFrom(text: string) {
  const [module] = parseVerilog(verilogDoc(text.trim()), defaultCoSettings, false).modules;
  expect(module).toBeDefined();
  return module!;
}

describe('stimulus testbench scaffold', () => {
  it('declares ports, initializes inputs, and monitors a combinational module', () => {
    const text = buildStimulusTestbench(moduleFrom(`
module alu (
    input wire [31: 0] A,
    input wire [31: 0] B,
    input wire [2: 0] ALUOp,
    output wire [31: 0] C
);
endmodule`), 'alu_tb');

    expect(text).toContain('module alu_tb;');
    expect(text).toContain('    // 输入\n    reg [31:0] A;\n    reg [31:0] B;\n    reg [2:0] ALUOp;');
    expect(text).toContain('    // 输出\n    wire [31:0] C;');
    expect(text).toContain('    alu uut (\n        .A(A),\n        .B(B),\n        .ALUOp(ALUOp),\n        .C(C)\n    );');
    expect(text).toContain('$monitor("t=%0d A=%h B=%h ALUOp=%b C=%h", $time, A, B, ALUOp, C);');
    expect(text).toContain('        A = 0;\n        B = 0;\n        ALUOp = 0;');
    expect(text).toContain('在此编写激励');
    expect(text).toContain('        // A = 1;');
    expect(text).toContain('        #10;\n        $finish;');
    expect(text).not.toContain('always #');
    expect(text).toContain('.co/out/alu_tb.sim.out');
    expect(text).toContain('//     $dumpvars(0, alu_tb);');
  });

  it('drives a capitalized clock and synchronous reset without monitoring the clock', () => {
    const text = buildStimulusTestbench(moduleFrom(`
module gray(input wire Clk, input wire Reset, input wire En, output wire [2: 0] Output, output wire Overflow);
endmodule`), 'gray_tb');

    expect(text).toContain('    always #5 Clk = ~Clk;');
    expect(text).toContain("        Clk = 1'b0;\n        Reset = 1'b1;\n        En = 0;");
    expect(text).toContain("        #20;\n        Reset = 1'b0;");
    expect(text).toContain('$monitor("t=%0d Reset=%b En=%b Output=%b Overflow=%b", $time, Reset, En, Output, Overflow);');
    expect(text).toContain('        // En = 1;');
    expect(text).toContain('        #100;\n        $finish;');
  });

  it('releases active-low resets high and recognizes clock and clear names', () => {
    const lowReset = buildStimulusTestbench(
      moduleFrom('module m(input clock, input rst_n, input [7:0] d, output q); endmodule'),
      'm_tb'
    );
    expect(lowReset).toContain('    always #5 clock = ~clock;');
    expect(lowReset).toContain("        rst_n = 1'b0;");
    expect(lowReset).toContain("        #20;\n        rst_n = 1'b1;");

    const clear = buildStimulusTestbench(
      moduleFrom('module expr(input clk, input clr, input [7:0] in, output out); endmodule'),
      'expr_tb'
    );
    expect(clear).toContain("        clr = 1'b1;");
    expect(clear).toContain("        clr = 1'b0;");
    expect(clear).toContain('$monitor("t=%0d clr=%b in=%h out=%b", $time, clr, in, out);');
  });

  it('treats a multi-bit clk as ordinary data', () => {
    const text = buildStimulusTestbench(moduleFrom('module m(input [1:0] clk, output y); endmodule'), 'm_tb');
    expect(text).not.toContain('always #');
    expect(text).toContain('        clk = 0;');
    expect(text).toContain('$monitor("t=%0d clk=%b y=%b", $time, clk, y);');
  });

  it('mirrors parameters used by port widths and overrides the DUT with them', () => {
    const text = buildStimulusTestbench(moduleFrom(`
module mux #(parameter WIDTH = 8, parameter DEPTH = WIDTH * 2, parameter UNUSED = 3)(input [WIDTH-1:0] a, output [DEPTH-1:0] y);
  localparam L = 1;
endmodule`), 'mux_tb');

    expect(text).toContain('    localparam WIDTH = 8;\n    localparam DEPTH = WIDTH * 2;');
    expect(text).not.toContain('UNUSED');
    expect(text).not.toContain('localparam L');
    expect(text).toContain('    reg [WIDTH-1:0] a;');
    expect(text).toContain('    mux #(.WIDTH(WIDTH), .DEPTH(DEPTH)) uut (');
    expect(text).toContain('$monitor("t=%0d a=%h y=%h", $time, a, y);');
  });

  it('mirrors body localparams used by non-ANSI port widths without overriding them', () => {
    const text = buildStimulusTestbench(moduleFrom(`
module reg4(d, q);
  localparam W = 4;
  input [W-1:0] d;
  output [W-1:0] q;
endmodule`), 'reg4_tb');

    expect(text).toContain('    localparam W = 4;');
    expect(text).toContain('    reg4 uut (');
    expect(text).not.toContain('#(.W(W))');
  });

  it('keeps an input-less module compilable', () => {
    const text = buildStimulusTestbench(moduleFrom('module const1(output [3:0] y); endmodule'), 'const1_tb');
    expect(text).not.toContain('初始化输入');
    expect(text).not.toContain('// 例如');
    expect(text).toContain('$monitor("t=%0d y=%b", $time, y);');
    expect(text).toContain('        #10;\n        $finish;');
  });

  it('leaves course CPU testbenches free of scaffold monitors', () => {
    const text = buildTestbench(moduleFrom('module mips(input clk, input reset); endmodule'), 'mips_tb', { profile: 'P4' });
    expect(text).not.toContain('$monitor');
    expect(text).not.toContain('在此编写激励');
  });
});
