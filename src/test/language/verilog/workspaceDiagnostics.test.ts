import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let documentVersion = 1;

function doc(name: string, text: string): TextDocument {
  const version = documentVersion++;
  return TextDocument.create(`test://workspace-diagnostics/${version}/${name}.v`, 'verilog', version, text.trim());
}

function diagnostics(current: TextDocument, indexed: TextDocument[], settingsValue: unknown = {}) {
  const settings = mergeCoSettings(settingsValue);
  const index = new VerilogWorkspaceIndex();
  for (const item of indexed) {
    index.updateDocument(item, settings);
  }
  return getVerilogDiagnostics(current, settings, index);
}

function codes(current: TextDocument, indexed: TextDocument[], settingsValue: unknown = {}): string[] {
  return diagnostics(current, indexed, settingsValue)
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

describe('Verilog workspace diagnostics', () => {
  it('reports unresolved instance module names', () => {
    const top = doc('top', `
module top;
    MissingModule u_missing();
endmodule
`);

    expect(codes(top, [top], { project: { topModule: 'top' } })).toContain('unresolved-module');
  });

  it('reports duplicate modules across indexed files', () => {
    const first = doc('first', 'module child; endmodule');
    const second = doc('second', 'module child; endmodule');

    expect(codes(second, [first, second], { project: { topModule: 'child' } })).toContain('duplicate-module');
  });

  it('reports modules that are not instantiated by the workspace hierarchy', () => {
    const top = doc('top', `
module used; endmodule
module unused; endmodule
module top;
    used u_used();
endmodule
`);

    expect(codes(top, [top], { project: { topModule: 'top' } })).toContain('uninstantiated-module');
  });

  it('reports instance output drivers that conflict with assignments', () => {
    const child = doc('child', `
module child(output y);
    assign y = 1'b1;
endmodule
`);
    const top = doc('top', `
module top(input a);
    wire y;
    child u_child(.y(y));
    assign y = a;
endmodule
`);

    expect(codes(top, [child, top], { project: { topModule: 'top' } })).toContain('multi-driver');
  });

  it('reports multiple instance outputs driving the same signal', () => {
    const child = doc('child_multi', `
module child_multi(output y);
    assign y = 1'b1;
endmodule
`);
    const top = doc('top_multi', `
module top;
    wire y;
    child_multi u0(.y(y));
    child_multi u1(.y(y));
endmodule
`);

    expect(codes(top, [child, top], { project: { topModule: 'top' } })).toContain('multi-driver');
  });
});
