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
});
