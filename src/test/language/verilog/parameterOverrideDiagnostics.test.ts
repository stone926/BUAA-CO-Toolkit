import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let documentVersion = 1;

function doc(name: string, text: string): TextDocument {
  const version = documentVersion++;
  return TextDocument.create(`test://parameter-override-${version}/${name}.v`, 'verilog', version, text);
}

function codes(text: string): string[] {
  return getVerilogDiagnostics(doc('single', text), mergeCoSettings({}), new VerilogWorkspaceIndex())
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

function workspaceCodes(current: TextDocument, indexed: TextDocument[]): string[] {
  const settings = mergeCoSettings({});
  const index = new VerilogWorkspaceIndex();
  for (const document of indexed) {
    index.updateDocument(document, settings);
  }
  return getVerilogDiagnostics(current, settings, index)
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

describe('Verilog parameter override diagnostics', () => {
  it('uses named parameter overrides for same-file port width checks', () => {
    const result = codes(`
module child #(parameter WIDTH = 4)(input [WIDTH-1:0] din);
endmodule

module top(input [7:0] a);
    child #(.WIDTH(8)) u_child(.din(a));
endmodule
`.trim());

    expect(result).not.toContain('port-width-mismatch');
  });

  it('uses positional parameter overrides for same-file port width checks', () => {
    const result = codes(`
module child #(parameter WIDTH = 4)(input [WIDTH-1:0] din);
endmodule

module top(input [7:0] a);
    child #(8) u_child(.din(a));
endmodule
`.trim());

    expect(result).not.toContain('port-width-mismatch');
  });

  it('still reports connections that overflow an overridden parameterized port width', () => {
    const result = codes(`
module child #(parameter WIDTH = 4)(input [WIDTH-1:0] din);
endmodule

module top(input [15:0] a);
    child #(.WIDTH(8)) u_child(.din(a));
endmodule
`.trim());

    expect(result).toContain('port-width-mismatch');
  });

  it('re-evaluates dependent localparams with parameter overrides', () => {
    const result = codes(`
module child #(parameter WIDTH = 4)(input [DOUBLE-1:0] din);
    localparam DOUBLE = WIDTH * 2;
endmodule

module top(input [15:0] a);
    child #(.WIDTH(8)) u_child(.din(a));
endmodule
`.trim());

    expect(result).not.toContain('port-width-mismatch');
  });

  it('uses parameter overrides for cross-file port width checks', () => {
    const child = doc('child', `
module child #(parameter WIDTH = 4)(input [WIDTH-1:0] din);
endmodule
`.trim());
    const top = doc('top', `
module top(input [7:0] a);
    child #(.WIDTH(8)) u_child(.din(a));
endmodule
`.trim());

    expect(workspaceCodes(top, [child])).not.toContain('port-width-mismatch');
  });
});
