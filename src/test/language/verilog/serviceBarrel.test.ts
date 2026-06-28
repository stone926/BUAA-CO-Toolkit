import { describe, expect, it } from 'vitest';
import { Range } from 'vscode-languageserver/node';
import { defaultCoSettings } from '../../../language/common/settings';
import {
  getVerilogCodeActions,
  getVerilogDefinition,
  getVerilogHover,
  getVerilogInlayHints,
  getVerilogReferences,
  getVerilogRenameEdits,
  getVerilogSignatureHelp
} from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';
import { positionOf, verilogDoc } from '../../helpers/textDocument';

describe('Verilog service public provider barrel', () => {
  it('keeps all split provider APIs available through service.ts', () => {
    const document = verilogDoc(`
module child #(parameter WIDTH = 8)(input [WIDTH-1:0] din, output dout);
endmodule

module top(input [7:0] bus, output y);
    child #(.WIDTH(8)) u_child(.din(bus), .dout(y));
endmodule
`.trim());
    const index = new VerilogWorkspaceIndex();
    index.updateDocument(document, defaultCoSettings);

    expect(getVerilogHover(document, positionOf(document, 'u_child'), defaultCoSettings, index)?.contents).toBeDefined();
    expect(getVerilogDefinition(document, positionOf(document, '.din', 1), defaultCoSettings, index)?.uri).toBe(document.uri);
    expect(getVerilogReferences(document, {
      textDocument: { uri: document.uri },
      position: positionOf(document, 'din,'),
      context: { includeDeclaration: true }
    }, defaultCoSettings, index).length).toBeGreaterThan(1);
    expect(getVerilogRenameEdits(document, positionOf(document, 'u_child'), 'u_renamed', defaultCoSettings, index)?.changes?.[document.uri]).toBeDefined();
    expect(getVerilogSignatureHelp(document, positionOf(document, '.dout', 2), defaultCoSettings, index)?.activeParameter).toBe(1);
    expect(getVerilogInlayHints(document, Range.create(0, 0, document.lineCount, 0), defaultCoSettings, index).length).toBeGreaterThan(0);

    const codeActionDocument = verilogDoc('module top; child u_child; endmodule');
    index.updateDocument(codeActionDocument, defaultCoSettings);
    const actionPosition = positionOf(codeActionDocument, 'u_child');
    expect(getVerilogCodeActions(
      codeActionDocument,
      Range.create(actionPosition, actionPosition),
      [],
      defaultCoSettings,
      index
    ).some((action) => action.title === 'Add empty instance port list')).toBe(true);
  });
});
