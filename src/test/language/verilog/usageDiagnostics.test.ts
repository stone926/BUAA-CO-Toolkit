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
  it('reports unused, write-only, read-only signals and unused parameters', () => {
    const top = doc('top', `
module top(input a);
    parameter USED = 1;
    localparam UNUSED_PARAM = 2;
    wire [USED-1:0] bus;
    wire never;
    wire write_only;
    wire read_only;
    wire sink;

    assign write_only = a;
    assign sink = read_only;
endmodule
`);

    const result = codes(top);
    expect(result).toContain('unused-signal');
    expect(result).toContain('write-only-signal');
    expect(result).toContain('read-only-signal');
    expect(result).toContain('unused-parameter');
    expect(diagnostics(top).some((diagnostic) => diagnostic.code === 'unused-parameter' && top.getText(diagnostic.range) === 'USED')).toBe(false);
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
