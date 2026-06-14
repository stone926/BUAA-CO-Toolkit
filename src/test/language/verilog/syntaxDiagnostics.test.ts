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
