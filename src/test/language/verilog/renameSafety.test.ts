import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings as settings } from '../../../language/common/settings';
import { getVerilogRenameEdits } from '../../../language/verilog/rename';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

function rename(source: string, marker: string, name: string) {
  const document = TextDocument.create('file:///rename.v', 'verilog', 1, source);
  const index = new VerilogWorkspaceIndex();
  index.updateDocument(document, settings);
  return getVerilogRenameEdits(document, document.positionAt(source.indexOf(marker)), name, settings, index);
}

describe('Verilog rename safety', () => {
  const source = 'module m(input a, input b, output y); assign y=a+b; endmodule';

  it.each(['wire', 'always', '1bad', '$display', 'two names', 'a.b', ' a', 'a '])('rejects non-identifiers and keywords: %s', (name) => {
    expect(rename(source, 'a,', name)).toBeUndefined();
  });

  it('accepts dollar signs inside identifiers using the shared lexer', () => {
    const edits = rename(source, 'a,', 'a$valid')?.changes?.['file:///rename.v'];
    expect(edits).toHaveLength(2);
    expect(edits?.every((edit) => edit.newText === 'a$valid')).toBe(true);
  });

  it('rejects a declaration collision', () => {
    expect(rename(source, 'a,', 'b')).toBeUndefined();
  });

  it('rejects capture of renamed references by an inner declaration', () => {
    expect(rename('module m; reg a; initial begin : inner reg b; a=b; end endmodule', 'a;', 'b')).toBeUndefined();
  });

  it('rejects capture of existing outer references', () => {
    expect(rename('module m; reg a; initial begin : inner reg b; b=a; end endmodule', 'b;', 'a')).toBeUndefined();
  });

  it('permits names used in unrelated sibling scopes', () => {
    expect(rename('module m; initial begin : left reg a; a=0; end initial begin : right reg b; b=0; end endmodule', 'a;', 'b')).toBeDefined();
  });
});
