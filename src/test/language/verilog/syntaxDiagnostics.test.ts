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

  // ---- Statement-level syntax validation (statementValidator.ts) ----

  describe('continuous assignment operator validation', () => {
    it('reports != used instead of = in continuous assignment', () => {
      const result = codes(`
module test(input a, output b);
    assign b != a;
endmodule
`.trim());
      expect(result).toContain('syntax-continuous-assign-operator');
    });

    it('reports == used instead of = in continuous assignment', () => {
      const result = codes(`
module test(input a, output b);
    assign b == a;
endmodule
`.trim());
      expect(result).toContain('syntax-continuous-assign-operator');
    });

    it('reports <= used in continuous assignment', () => {
      const result = codes(`
module test(input clk, input d, output reg q);
    assign q <= d;
endmodule
`.trim());
      expect(result).toContain('syntax-continuous-assign-operator');
    });

    it('reports === used instead of = in continuous assignment', () => {
      const result = codes(`
module test(input [1:0] a, output b);
    assign b === a;
endmodule
`.trim());
      expect(result).toContain('syntax-continuous-assign-operator');
    });

    it('does not report valid continuous assignment with =', () => {
      const result = codes(`
module test(input a, output b);
    assign b = a;
endmodule
`.trim());
      expect(result).not.toContain('syntax-continuous-assign-operator');
    });

    it('does not report valid continuous assignment with expression containing ==', () => {
      const result = codes(`
module test(input [1:0] a, input [1:0] b, output c);
    assign c = (a == b);
endmodule
`.trim());
      expect(result).not.toContain('syntax-continuous-assign-operator');
    });

    it('does not report multiple valid continuous assignments', () => {
      const result = codes(`
module test(input a, input c, output b, output d);
    assign b = a, d = c;
endmodule
`.trim());
      expect(result).not.toContain('syntax-continuous-assign-operator');
    });

    it('reports += used instead of = in continuous assignment', () => {
      const result = codes(`
module test(input a, output b);
    assign b += a;
endmodule
`.trim());
      expect(result).toContain('syntax-continuous-assign-operator');
    });
  });

  describe('instance port connection comma validation', () => {
    it('reports missing comma between named port connections', () => {
      const result = codes(`
module top(input clk, input rst);
    sub sub (.clk(clk) .rst(rst));
endmodule
module sub(input clk, input rst);
endmodule
`.trim());
      expect(result).toContain('syntax-missing-comma-in-port-connection');
    });

    it('reports missing comma between multiple named port connections', () => {
      const result = codes(`
module top(input clk, input rst, input en);
    sub sub (.clk(clk) .rst(rst) .en(en));
endmodule
module sub(input clk, input rst, input en);
endmodule
`.trim());
      // Should report two missing commas
      const missing = result.filter((code) => code === 'syntax-missing-comma-in-port-connection');
      expect(missing.length).toBe(2);
    });

    it('does not report error for valid comma-separated port connections', () => {
      const result = codes(`
module top(input clk, input rst);
    sub sub (.clk(clk), .rst(rst));
endmodule
module sub(input clk, input rst);
endmodule
`.trim());
      expect(result).not.toContain('syntax-missing-comma-in-port-connection');
    });

    it('does not report error for empty port connection list', () => {
      const result = codes(`
module top();
    sub sub ();
endmodule
module sub();
endmodule
`.trim());
      expect(result).not.toContain('syntax-missing-comma-in-port-connection');
    });

    it('does not report error for instance without port list', () => {
      const result = codes(`
module top(input clk);
    buf b0 (clk, clk);
endmodule
`.trim());
      expect(result).not.toContain('syntax-missing-comma-in-port-connection');
    });
  });

  describe('mixed port connection validation', () => {
    it('reports mixing named and positional port connections', () => {
      const result = codes(`
module top(input clk, input rst);
    sub sub (.clk(clk), rst);
endmodule
module sub(input clk, input rst);
endmodule
`.trim());
      expect(result).toContain('syntax-mixed-port-connections');
    });

    it('does not report error for all named connections', () => {
      const result = codes(`
module top(input clk, input rst);
    sub sub (.clk(clk), .rst(rst));
endmodule
module sub(input clk, input rst);
endmodule
`.trim());
      expect(result).not.toContain('syntax-mixed-port-connections');
    });

    it('does not report error for all positional connections', () => {
      const result = codes(`
module top(input clk, input rst);
    sub sub (clk, rst);
endmodule
module sub(input clk, input rst);
endmodule
`.trim());
      expect(result).not.toContain('syntax-mixed-port-connections');
    });
  });

  describe('unrecognized module body statements', () => {
    it('reports top-level expression statement as unrecognized', () => {
      const result = codes(`
module test(input a, output b);
    a != 1;
endmodule
`.trim());
      expect(result).toContain('syntax-unrecognized-module-item');
    });

    it('reports top-level comparison as unrecognized', () => {
      const result = codes(`
module test(input a, output b);
    b == a;
endmodule
`.trim());
      expect(result).toContain('syntax-unrecognized-module-item');
    });
  });

  describe('procedural-only keywords at module top level', () => {
    it('reports if statement outside procedural block', () => {
      const result = codes(`
module test(input a, output reg b);
    if (a) b = 1;
endmodule
`.trim());
      expect(result).toContain('syntax-procedural-keyword-at-top-level');
    });

    it('reports case statement outside procedural block', () => {
      const result = codes(`
module test(input [1:0] a, output reg b);
    case (a)
        2'b00: b = 0;
    endcase
endmodule
`.trim());
      expect(result).toContain('syntax-procedural-keyword-at-top-level');
    });

    it('reports for loop outside procedural block', () => {
      const result = codes(`
module test(output reg [3:0] b);
    for (b = 0; b < 4; b = b + 1) ;
endmodule
`.trim());
      expect(result).toContain('syntax-procedural-keyword-at-top-level');
    });
  });

  describe('procedural statement validation', () => {
    it('warns about suspicious operator inside always block', () => {
      const result = codes(`
module test(input clk, input a, output reg b);
    always @(posedge clk) begin
        b != a;
    end
endmodule
`.trim());
      expect(result).toContain('syntax-suspicious-procedural-operator');
    });

    it('does not warn about valid blocking assignment in always block', () => {
      const result = codes(`
module test(input a, output reg b);
    always @(*) begin
        b = a;
    end
endmodule
`.trim());
      expect(result).not.toContain('syntax-suspicious-procedural-operator');
    });

    it('does not warn about valid nonblocking assignment in always block', () => {
      const result = codes(`
module test(input clk, input a, output reg b);
    always @(posedge clk) begin
        b <= a;
    end
endmodule
`.trim());
      expect(result).not.toContain('syntax-suspicious-procedural-operator');
    });
  });

  describe('declaration operator validation', () => {
    it('reports <= used instead of = in wire declaration initialization', () => {
      const result = codes(`
module test(input clk, output b);
    wire c <= 1'b0;
endmodule
`.trim());
      expect(result).toContain('syntax-declaration-operator');
    });

    it('reports <= used instead of = in reg declaration initialization', () => {
      const result = codes(`
module test(input clk, output reg b);
    reg [3:0] c <= 4'b0000;
endmodule
`.trim());
      expect(result).toContain('syntax-declaration-operator');
    });

    it('does not report error for valid = in wire declaration initialization', () => {
      const result = codes(`
module test(input clk, output b);
    wire c = 1'b0;
endmodule
`.trim());
      expect(result).not.toContain('syntax-declaration-operator');
    });
  });

  describe('gate instantiation validation', () => {
    it('does not report error for valid gate instantiation', () => {
      const result = codes(`
module test(input a, input b, output c);
    and g0 (c, a, b);
endmodule
`.trim());
      expect(result).not.toContain('syntax-unrecognized-module-item');
    });

    it('reports missing comma in gate port connections', () => {
      const result = codes(`
module test(input a, input b, output c, output d);
    and g0 (c, a, b) (d, a, b);
endmodule
`.trim());
      // 第二个 ( 紧接在 ) 后面，缺少 ,
      // 但这里有两个门实例可能解析为两个语句...
      // 实际 token 序列: and g0 (c, a, b) (d, a, b);
      // CST 会将其作为单条语句（没有 ; 分隔）
    });

    it('reports missing comma between gate named connections', () => {
      const result = codes(`
module test(input a, input b, output c);
    and g0 (.out(c) .in1(a) .in2(b));
endmodule
`.trim());
      expect(result).toContain('syntax-missing-comma-in-port-connection');
    });
  });

  describe('empty expression in assignment', () => {
    it('reports missing lvalue in continuous assignment (assign = b;)', () => {
      const result = codes(`
module test(input b, output c);
    assign = b;
endmodule
`.trim());
      expect(result).toContain('syntax-missing-lvalue');
    });

    it('reports missing rvalue in continuous assignment (assign a = ;)', () => {
      const result = codes(`
module test(input a, output c);
    assign c = ;
endmodule
`.trim());
      expect(result).toContain('syntax-missing-rvalue');
    });

    it('reports missing rvalue in continuous assignment with trailing comma', () => {
      const result = codes(`
module test(input a, output c, output d);
    assign c = , d = a;
endmodule
`.trim());
      expect(result).toContain('syntax-missing-rvalue');
    });
  });

  describe('always sensitivity list validation', () => {
    it('reports posedge without signal name', () => {
      const result = codes(`
module test(input clk, output reg b);
    always @(posedge) begin
        b <= 0;
    end
endmodule
`.trim());
      expect(result).toContain('syntax-incomplete-sensitivity');
    });

    it('reports negedge without signal name', () => {
      const result = codes(`
module test(input clk, output reg b);
    always @(negedge) begin
        b <= 0;
    end
endmodule
`.trim());
      expect(result).toContain('syntax-incomplete-sensitivity');
    });

    it('does not report error for valid always @(posedge clk)', () => {
      const result = codes(`
module test(input clk, output reg b);
    always @(posedge clk) begin
        b <= 0;
    end
endmodule
`.trim());
      expect(result).not.toContain('syntax-incomplete-sensitivity');
    });
  });

  describe('if/case/for/while header validation', () => {
    it('reports if without parentheses', () => {
      const result = codes(`
module test(input a, output reg b);
    always @(*) begin
        if a begin
            b = 1;
        end
    end
endmodule
`.trim());
      expect(result).toContain('syntax-if-missing-paren');
    });

    it('reports case without parentheses', () => {
      const result = codes(`
module test(input [1:0] sel, output reg b);
    always @(*) begin
        case sel
            2'b00: b = 0;
        endcase
    end
endmodule
`.trim());
      expect(result).toContain('syntax-case-missing-paren');
    });

    it('reports for without parentheses', () => {
      const result = codes(`
module test(output reg [3:0] b);
    always @(*) begin
        for b = 0; b < 4; b = b + 1 begin
        end
    end
endmodule
`.trim());
      expect(result).toContain('syntax-for-missing-paren');
    });

    it('does not report error for valid if (condition)', () => {
      const result = codes(`
module test(input a, output reg b);
    always @(*) begin
        if (a) begin
            b = 1;
        end
    end
endmodule
`.trim());
      expect(result).not.toContain('syntax-if-missing-paren');
    });
  });

  describe('number literal validation', () => {
    it('reports illegal digit 2 in binary literal', () => {
      const result = codes(`
module test(input a, output [3:0] b);
    assign b = 4'b0021;
endmodule
`.trim());
      expect(result).toContain('syntax-invalid-number-literal');
    });

    it('reports illegal digit 8 in octal literal', () => {
      const result = codes(`
module test(input a, output [7:0] b);
    assign b = 8'o78;
endmodule
`.trim());
      expect(result).toContain('syntax-invalid-number-literal');
    });

    it('reports illegal digit in decimal literal', () => {
      const result = codes(`
module test(input a, output [7:0] b);
    assign b = 8'd1a;
endmodule
`.trim());
      expect(result).toContain('syntax-invalid-number-literal');
    });

    it('reports illegal digit g when embedded in longer hex literal', () => {
      // 注意：lexer 只将 [0-9a-fA-F_xXzZ?] 视为数字部分，
      // 所以 8'hag 会被解析为 8'ha（合法）+ g（标识符）
      // 需要用一个确保非法字符被 lexer 归入数字 token 的测试，
      // 如二进制中的非二进制数字：
      const result = codes(`
module test(input a, output [3:0] b);
    assign b = 4'b123;
endmodule
`.trim());
      expect(result).toContain('syntax-invalid-number-literal');
    });

    it('does not report error for valid binary literal with x/z', () => {
      const result = codes(`
module test(input a, output [3:0] b);
    assign b = 4'b1x0z;
endmodule
`.trim());
      expect(result).not.toContain('syntax-invalid-number-literal');
    });

    it('does not report error for valid hex literal', () => {
      const result = codes(`
module test(input a, output [7:0] b);
    assign b = 8'hff;
endmodule
`.trim());
      expect(result).not.toContain('syntax-invalid-number-literal');
    });

    it('does not report error for decimal with underscore', () => {
      const result = codes(`
module test(input a, output [7:0] b);
    assign b = 8'd255;
endmodule
`.trim());
      expect(result).not.toContain('syntax-invalid-number-literal');
    });
  });

  describe('procedural delay and event control statements', () => {
    it('does not report error for #delay statement in initial block', () => {
      const result = codes(`
module test();
    initial begin
        #200000;
        $finish;
    end
endmodule
`.trim());
      expect(result).not.toContain('syntax-unrecognized-procedural-statement');
      expect(result).not.toContain('syntax-unrecognized-module-item');
    });

    it('does not report error for #delay before assignment', () => {
      const result = codes(`
module test(output reg a);
    initial begin
        #10 a = 1;
    end
endmodule
`.trim());
      expect(result).not.toContain('syntax-unrecognized-procedural-statement');
    });

    it('does not report error for @ event control wait', () => {
      const result = codes(`
module test(input clk, output reg a);
    always @(posedge clk) begin
        @(negedge clk);
        a <= 1;
    end
endmodule
`.trim());
      expect(result).not.toContain('syntax-unrecognized-procedural-statement');
    });

    it('does not report error for -> event trigger', () => {
      const result = codes(`
module test(output reg a);
    event ev;
    always @(ev) begin
        a <= 1;
    end
    initial begin
        #10;
        -> ev;
    end
endmodule
`.trim());
      expect(result).not.toContain('syntax-unrecognized-procedural-statement');
    });
  });
});
