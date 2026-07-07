import { describe, expect, it } from 'vitest';
import { InsertTextFormat } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { getVerilogCompletions } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

describe('Verilog completions', () => {
  it('refreshes cached workspace completions when the index changes', () => {
    const index = new VerilogWorkspaceIndex();
    const current = doc('file:///top.v', 'module top;\n  \nendmodule\n');

    index.updateDocument(doc('file:///child.v', 'module Child; endmodule\n'), defaultCoSettings);
    let completions = getVerilogCompletions(current, { line: 1, character: 2 }, defaultCoSettings, index);
    expect(completions.some((item) => item.label === 'Child')).toBe(true);

    index.updateDocument(doc('file:///other.v', 'module Other; endmodule\n'), defaultCoSettings);
    completions = getVerilogCompletions(current, { line: 1, character: 2 }, defaultCoSettings, index);
    expect(completions.some((item) => item.label === 'Other')).toBe(true);
  });

  it('does not offer completions inside comments or string literals', () => {
    const index = new VerilogWorkspaceIndex();
    const current = doc('file:///top.v', 'module top;\n  // wir\n  initial $display("wir");\nendmodule\n');

    expect(getVerilogCompletions(current, { line: 1, character: 7 }, defaultCoSettings, index)).toHaveLength(0);
    expect(getVerilogCompletions(current, { line: 2, character: 22 }, defaultCoSettings, index)).toHaveLength(0);
  });

  it('expands begin keyword completion into a begin/end snippet', () => {
    const index = new VerilogWorkspaceIndex();
    const current = doc('file:///top.v', 'module top;\n  initial begin\n    if (reset) \n  end\nendmodule\n');

    const completions = getVerilogCompletions(current, { line: 2, character: 15 }, defaultCoSettings, index);
    const begin = completions.find((item) => item.label === 'begin');

    expect(begin).toMatchObject({
      insertText: 'begin\n    ${0}\nend',
      insertTextFormat: InsertTextFormat.Snippet
    });
  });
});

function doc(uri: string, text: string): TextDocument {
  return TextDocument.create(uri, 'verilog', 1, text);
}
