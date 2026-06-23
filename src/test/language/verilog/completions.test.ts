import { describe, expect, it } from 'vitest';
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
});

function doc(uri: string, text: string): TextDocument {
  return TextDocument.create(uri, 'verilog', 1, text);
}
