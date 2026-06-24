import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';

let documentVersion = 1;

function doc(text: string): TextDocument {
  return TextDocument.create(`test://syntax-${documentVersion}.v`, 'verilog', documentVersion++, text);
}

function codes(text: string): string[] {
  return getVerilogDiagnostics(doc(text), mergeCoSettings({}))
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

function syntaxCodes(text: string): string[] {
  return codes(text).filter((code) => code.startsWith('syntax-'));
}

function syntaxLines(text: string, code: string): number[] {
  return getVerilogDiagnostics(doc(text), mergeCoSettings({}))
    .filter((diagnostic) => diagnostic.code === code)
    .map((diagnostic) => diagnostic.range.start.line + 1);
}

describe('Verilog syntax diagnostics', () => {
  it('reports malformed module declarations', () => {
    expect(codes('module broken(input clk)\nendmodule')).toContain('syntax-module-declaration');
  });

  it('reports unmatched delimiters', () => {
    const result = codes('module broken(input clk;\nendmodule');
    expect(result).toContain('syntax-module-declaration');
    expect(result).toContain('syntax-unclosed-delimiter');
  });

  it('reports unbalanced begin/end blocks', () => {
    const result = codes(`
module broken(input clk);
    always @(posedge clk) begin
        begin
    end
endmodule
`.trim());
    expect(result).toContain('syntax-unclosed-begin');
  });

  it('reports unbalanced case/endcase blocks', () => {
    const result = codes(`
module broken(input [1:0] a);
    always @(*) begin
        case (a)
            2'b00: ;
    end
endmodule
`.trim());
    expect(result).toContain('syntax-unclosed-case');
  });

  it('reports missing semicolons on declarations and assign statements', () => {
    const result = codes(`
module broken(input a, output y);
    wire internal
    assign y = internal
endmodule
`.trim());
    expect(result).toContain('syntax-missing-semicolon');
  });

  it('reports malformed procedural assignments and controls', () => {
    const result = codes(`
module broken(input clk, input a, output reg y);
    always @(posedge clk begin
        if a) begin
            y <= ;
        end
    end
endmodule
`.trim());
    expect(result).toContain('syntax-malformed-event-control');
    expect(result).toContain('syntax-malformed-if');
    expect(result).toContain('syntax-malformed-assignment');
  });

  it('reports malformed procedural assignment expressions after control prefixes', () => {
    const result = codes(`
module broken(input a, input b, input sel, output reg y);
    always @(*) begin
        if (a) = b;
        case (sel)
            1'b0: y = a b;
            default: y <= ;
        endcase
    end
endmodule
`.trim());
    expect(result).toContain('syntax-malformed-assignment');
  });

  it('accepts procedural assignments after common course control prefixes', () => {
    const result = syntaxCodes(`
module ok(input reset, input sel, output reg y);
    reg clk;
    integer i;
    reg [31:0] data [0:3];
    initial begin
        clk = 1'b0;
        forever #5 clk = ~clk;
    end
    always @(*) begin
        if (reset) for (i = 0; i < 4; i = i + 1) data[i] <= 0;
        case (sel)
            1'b0: y = data[0][0];
            default: y = ~data[1][0];
        endcase
    end
endmodule
`.trim());
    expect(result).not.toContain('syntax-malformed-assignment');
  });

  it('reports malformed instance connections and number literals', () => {
    const result = codes(`
module child(input a); endmodule
module broken(input a);
    child u(.a a);
    wire [3:0] x = 4'b1020;
endmodule
`.trim());
    expect(result).toContain('syntax-malformed-instance');
    expect(result).toContain('syntax-malformed-number');
  });

  it('reports malformed instance port list expressions and missing commas', () => {
    const result = codes(`
module child(input a, input b); endmodule
module broken(input a, input b);
    child u0(.a(a) .b(b));
    child u1(.a(a b), .b(b));
    child u2(a b);
endmodule
`.trim());
    expect(result).toContain('syntax-malformed-instance');
  });

  it('accepts common named, empty, and positional instance port connections', () => {
    const result = syntaxCodes(`
module child(input a, input b, output y); endmodule
module ok(input a, input b, output y);
    child u0(.a(a), .b(b), .y());
    child u1(a, b, y);
endmodule
`.trim());
    expect(result).not.toContain('syntax-malformed-instance');
  });

  it('reports orphan procedural keywords', () => {
    const result = codes(`
module broken(input a);
    always @(*) begin
        else a = 1'b0;
        default: a = 1'b1;
    end
endmodule
`.trim());
    expect(result).toContain('syntax-orphan-else');
    expect(result).toContain('syntax-orphan-default');
  });

  it('reports unexpected module-scope tokens instead of silently dropping them', () => {
    const result = codes(`
module broken(input a, output reg y);
    + 42;
    if (a) y = 1'b1;
endmodule
`.trim());
    expect(result).toContain('syntax-unexpected-token');
  });

  it('accepts built-in gate primitive module items', () => {
    const result = syntaxCodes(`
module gates(input [3:0] x, output y);
    wire nx0, nx1, a1;
    not (nx0, x[0]), (nx1, x[1]);
    and gate_a(a1, x[2], nx0);
    or (y, a1, nx1);
endmodule
`.trim());
    expect(result).not.toContain('syntax-unexpected-token');
    expect(result).not.toContain('syntax-malformed-gate-primitive');
  });

  it('reports illegal declaration keyword sequences without rejecting common port types', () => {
    const invalid = syntaxCodes(`
module broken(input a);
    wire reg foo;
    input output bar;
endmodule
`.trim());
    expect(invalid).toContain('syntax-malformed-declaration');

    const valid = syntaxCodes(`
module ok;
    input wire clk;
    output reg [31:0] y;
    parameter integer WIDTH = 32;
endmodule
`.trim());
    expect(valid).not.toContain('syntax-malformed-declaration');
  });

  it('reports obvious extra tokens in continuous assigns and instances', () => {
    const result = codes(`
module broken(input a, input b, input c, output y);
    assign a b = c;
    assign y = a ? ;
    child u #1(.a(a));
endmodule
`.trim());
    expect(result).toContain('syntax-malformed-assignment');
    expect(result).toContain('syntax-malformed-instance');
  });

  it('accepts system functions and indexed part-selects in expressions', () => {
    const result = syntaxCodes(`
module ok(input [31:0] a, output [7:0] y);
    parameter AW = $clog2(32);
    assign y = $signed(a[AW +: 8]);
endmodule
`.trim());
    expect(result).not.toContain('syntax-malformed-assignment');
    expect(result).not.toContain('syntax-malformed-declaration');
  });

  it('does not treat comparison operators in assignment RHS as assignments', () => {
    const result = syntaxCodes(`
module ok(input a, input b, output reg y);
    assign y = a <= b;
    always @(*) y = a <= b;
endmodule
`.trim());
    expect(result).not.toContain('syntax-malformed-assignment');
  });

  it('reports missing operands inside delimited expressions', () => {
    const result = syntaxLines(`
module broken(input a, output y);
    assign y = (a +);
    assign y = ();
    assign y = a[];
endmodule
`.trim(), 'syntax-malformed-assignment');
    expect(result).toContain(2);
    expect(result).toContain(3);
    expect(result).toContain(4);
  });

  it('accepts empty function calls and nested expression delimiters', () => {
    const result = syntaxCodes(`
module ok(output [7:0] y);
    function [7:0] zero;
        begin
            zero = 8'h00;
        end
    endfunction
    assign y = zero() | {$random(), 1'b0}[7:0];
endmodule
`.trim());
    expect(result).not.toContain('syntax-malformed-assignment');
  });

  it('reports malformed ANSI module port lists', () => {
    const result = syntaxLines(`
module missingComma(input a output b);
endmodule

module missingName(input [3:0], output y);
endmodule
`.trim(), 'syntax-malformed-port-list');
    expect(result).toContain(1);
    expect(result).toContain(4);
  });

  it('accepts legacy, inherited, and parameterized module port headers', () => {
    const result = syntaxCodes(`
module legacy(a, b, y);
    input a;
    input b;
    output y;
endmodule

module inherited(input [3:0] a, b, output reg [3:0] y);
endmodule

module parameterized #(parameter integer WIDTH = 4) (
    input wire clk,
    input [WIDTH-1:0] a,
    b,
    output [WIDTH-1:0] y
);
endmodule
`.trim());
    expect(result).not.toContain('syntax-malformed-port-list');
  });

  it('reports lexical syntax errors before structural checks', () => {
    expect(codes('module broken; initial $display("oops); endmodule')).toContain('syntax-unclosed-string');
    expect(codes('module broken; /* unterminated comment')).toContain('syntax-unclosed-comment');
  });

  it('treats rst/reset/clr/clear as reset signals for VC-012', () => {
    const result = codes(`
module resets(input clk, input rst, input reset, input clr, input clear);
    always @(posedge clk or posedge rst) begin end
    always @(posedge clk or posedge reset) begin end
    always @(posedge clk or posedge clr) begin end
    always @(posedge clk or posedge clear) begin end
endmodule
`.trim());
    expect(result).not.toContain('vc-012-edge-signal');
  });
});
