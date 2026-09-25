import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let documentVersion = 1;

function doc(name: string, text: string): TextDocument {
  const version = documentVersion++;
  return TextDocument.create(`test://usage-diagnostics/${version}/${name}.v`, 'verilog', version, text.trim());
}

function diagnostics(current: TextDocument, indexed: TextDocument[] = [current]) {
  const settings = mergeCoSettings({ project: { topModule: 'top' } });
  const index = new VerilogWorkspaceIndex();
  for (const document of indexed) {
    index.updateDocument(document, settings);
  }
  return getVerilogDiagnostics(current, settings, index);
}

function codes(current: TextDocument, indexed: TextDocument[] = [current]): string[] {
  return diagnostics(current, indexed)
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

describe('Verilog usage diagnostics', () => {
  it('reports unused signals and parameters without read/write-only noise', () => {
    const top = doc('top', `
module top(input a);
    parameter USED = 1;
    localparam UNUSED_PARAM = 2;
    wire [USED-1:0] bus;
    reg procedural_write;
    wire never;
    wire write_only;
    wire read_only;
    wire sink;

    assign write_only = a;
    assign sink = read_only;
    always @(*) begin
        procedural_write = a;
    end
endmodule
`);

    const allDiagnostics = diagnostics(top);
    const result = allDiagnostics
      .map((diagnostic) => diagnostic.code)
      .filter((code): code is string => typeof code === 'string');
    expect(result).toContain('unused-signal');
    expect(result).not.toContain('write-only-signal');
    expect(result).not.toContain('read-only-signal');
    expect(result).toContain('unused-parameter');
    expect(allDiagnostics.some((diagnostic) => diagnostic.code === 'unused-parameter' && top.getText(diagnostic.range) === 'USED')).toBe(false);
    expect(allDiagnostics.some((diagnostic) => diagnostic.code === 'unused-signal' && top.getText(diagnostic.range) === 'procedural_write')).toBe(false);
  });

  it('treats resolved instance output connections as signal writes', () => {
    const child = doc('child', `
module child(output y);
    assign y = 1'b1;
endmodule
`);
    const top = doc('top', `
module top;
    wire y;
    wire sink;
    child u_child(.y(y));
    assign sink = y;
endmodule
`);

    const yDiagnostics = diagnostics(top, [child, top])
      .filter((diagnostic) => top.getText(diagnostic.range) === 'y')
      .map((diagnostic) => diagnostic.code);
    expect(yDiagnostics).not.toContain('read-only-signal');
    expect(yDiagnostics).not.toContain('unused-signal');
  });
});

describe('generate block scopes', () => {
  const source = `
\`default_nettype none
module top(input wire clk, input wire [7:0] a, output wire [7:0] y);
    genvar g;
    generate for (g = 0; g < 2; g = g + 1) begin : lane
        wire [7:0] w;
        reg [7:0] r;
        assign w = a + g;
        always @(posedge clk) r <= w;
    end endgenerate
    generate if (1) begin : fast
        wire [7:0] v;
        assign v = a;
        begin : inner
            wire [7:0] u;
            assign u = v;
        end
    end else begin : slow
        wire [7:0] v;
        assign v = ~a;
    end endgenerate
    assign y = a;
endmodule
`;

  it('resolves names declared in generate blocks without implicit-net or multi-driver noise', () => {
    const result = codes(doc('top', source));
    expect(result.filter((code) => code.startsWith('implicit-net'))).toEqual([]);
    expect(result).not.toContain('multi-driver');
  });

  it('still reports names used outside the generate block that declares them', () => {
    const outside = source.replace('assign y = a;', 'assign y = w;');
    expect(codes(doc('top', outside))).toContain('implicit-net:w');
  });

  it('still reports two drivers on the same branch of a conditional generate', () => {
    const doubled = source.replace('assign v = ~a;', 'assign v = ~a;\n        assign v = a;');
    expect(codes(doc('top', doubled))).toContain('multi-driver');
  });
});
