import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';

let documentVersion = 1;

function doc(text: string): TextDocument {
  return TextDocument.create(`test://assignment-${documentVersion}.v`, 'verilog', documentVersion++, text);
}

function codes(text: string): string[] {
  return getVerilogDiagnostics(doc(text), mergeCoSettings({}))
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

describe('Verilog assignment diagnostics', () => {
  it('does not treat declaration initializers as blocking assignments', () => {
    const result = codes(`
module demo(input clk);
    reg [2:0] m = 0;

    always @(posedge clk) begin
        m <= 3'd1;
    end
endmodule
`.trim());

    expect(result).toContain('synth-decl-init');
    expect(result).not.toContain('mixed-assignment');
  });

  it('does not treat comparison operators as nonblocking assignments', () => {
    const result = codes(`
module demo(input [2:0] b, output reg [2:0] a, output reg y);
    always @(*) begin
        if (a <= b) begin
            y = 1'b1;
        end
        a = b;
    end
endmodule
`.trim());

    expect(result).not.toContain('mixed-assignment');
  });

  it('still reports real blocking and nonblocking assignment mixing', () => {
    const result = codes(`
module demo(input clk, output reg [2:0] m);
    always @(*) begin
        m = 3'd0;
    end

    always @(posedge clk) begin
        m <= 3'd1;
    end
endmodule
`.trim());

    expect(result).toContain('mixed-assignment');
  });

  it('does not apply sequential blocking rules to continuous assigns after a clocked block', () => {
    const result = codes(`
module demo(input clk, input reset, input WE, input [11:0] RAM_addr, input [11:0] addr, input [31:0] WD, input [31:0] PC, output [31:0] data);
    integer i;
    reg [31:0] RAM [0:3071];

    always @(posedge clk) begin
        if (reset) begin
            for (i = 0; i < 3072; i = i + 1) begin
                RAM[i] <= 32'h00000000;
            end
        end
        else begin
            if (WE) begin
                $display("%d@%h: *%h <= %h", $time, PC, addr, WD);
            end
        end
    end

    assign data = RAM[RAM_addr];
endmodule
`.trim());

    expect(result).not.toContain('vc-010-seq-blocking');
  });

  it('does not treat memory index expressions as assigned targets', () => {
    const result = codes(`
module DM (
        input clk,
        input reset,
        input [3:0] WE,
        input [31:0] pc,
        input [31:0] A,
        input [31:0] WD,
        output [31:0] D
    );
    reg [31:0] RAM [0:4095];

    wire [31:0] ADDR;
    assign ADDR = A >> 2;

    integer i;
    always @(posedge clk) begin
        if (reset) begin
            for (i = 0; i < 4096; i = i + 1) begin
                RAM[i] <= 32'h00000000;
            end
        end
        else begin
            if (WE[0] == 1'b1) begin
                RAM[ADDR][7:0] <= WD[7:0];
            end
            if (WE[1] == 1'b1) begin
                RAM[ADDR][15:8] <= WD[15:8];
            end
            if (WE[2] == 1'b1) begin
                RAM[ADDR][23:16] <= WD[23:16];
            end
            if (WE[3] == 1'b1) begin
                RAM[ADDR][31:24] <= WD[31:24];
            end
        end
    end

    assign D = RAM[ADDR];
endmodule
`.trim());

    expect(result).not.toContain('mixed-assignment');
  });

  it('does not treat identifiers inside indexed concatenation targets as assigned targets', () => {
    const result = codes(`
module demo(input clk, input [3:0] index, input [3:0] data);
    reg [7:0] RAM [0:15];
    reg flag;
    wire [3:0] ADDR;

    assign ADDR = index;

    always @(posedge clk) begin
        {RAM[ADDR][2:0], flag} <= data;
    end
endmodule
`.trim());

    expect(result).not.toContain('mixed-assignment');
  });
});
