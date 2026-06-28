import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { URI } from 'vscode-uri';
import { defaultCoSettings } from '../../../language/common/settings';
import {
  getVerilogHover,
  getVerilogReferences,
  getVerilogRenameEdits,
  getVerilogRenamePrepare
} from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';
import { positionOf, verilogDoc } from '../../helpers/textDocument';

function hoverText(hover: ReturnType<typeof getVerilogHover>): string {
  const contents = hover?.contents;
  return typeof contents === 'object' && 'value' in contents ? contents.value : '';
}

describe('Verilog hover, navigation, and rename behavior', () => {
  it('reports resolved and unresolved include paths in hover text', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-verilog-include-'));
    fs.writeFileSync(path.join(root, 'defs.vh'), '`define WIDTH 8\n');
    const document = verilogDoc([
      '`include "defs.vh"',
      '`include "missing.vh"',
      'module top; endmodule'
    ].join('\n'), URI.file(path.join(root, 'top.v')).toString());
    const index = new VerilogWorkspaceIndex();

    expect(hoverText(getVerilogHover(document, positionOf(document, 'defs.vh'), defaultCoSettings, index))).toContain('Resolved:');
    expect(hoverText(getVerilogHover(document, positionOf(document, 'missing.vh'), defaultCoSettings, index))).toContain('**Unresolved**');
  });

  it('prefers declaration hover over expression hover at a declaration name', () => {
    const document = verilogDoc(`
module top;
    localparam WIDTH = 8;
    wire [WIDTH-1:0] data;
endmodule
`.trim());
    const text = hoverText(getVerilogHover(document, positionOf(document, 'WIDTH ='), defaultCoSettings, new VerilogWorkspaceIndex()));

    expect(text).toContain('`localparam WIDTH`');
    expect(text).toContain('Constant value: `8 (0x8)`');
    expect(text).not.toContain('Expression `WIDTH`');
  });

  it('prepares rename for module, port, parameter, and macro symbols but rejects includes and invalid replacement names', () => {
    const document = verilogDoc(`
\`include "defs.vh"
\`define FLAG 1
module child #(parameter WIDTH = 8)(input din);
endmodule
module top;
    child #(.WIDTH(4)) u_child(.din(\`FLAG));
endmodule
`.trim());
    const index = new VerilogWorkspaceIndex();
    index.updateDocument(document, defaultCoSettings);

    expect(document.getText(getVerilogRenamePrepare(document, positionOf(document, 'child #'), defaultCoSettings, index)!)).toBe('child');
    expect(document.getText(getVerilogRenamePrepare(document, positionOf(document, 'WIDTH ='), defaultCoSettings, index)!)).toBe('WIDTH');
    expect(document.getText(getVerilogRenamePrepare(document, positionOf(document, 'din);'), defaultCoSettings, index)!)).toBe('din');
    expect(document.getText(getVerilogRenamePrepare(document, positionOf(document, 'FLAG'), defaultCoSettings, index)!)).toBe('FLAG');
    expect(getVerilogRenamePrepare(document, positionOf(document, 'defs.vh'), defaultCoSettings, index)).toBeUndefined();
    expect(getVerilogRenameEdits(document, positionOf(document, 'u_child'), 'bad-name', defaultCoSettings, index)).toBeUndefined();
  });

  it('keeps same-named local signals separate from target port references', () => {
    const document = verilogDoc(`
module child(input din, output dout);
endmodule

module top;
    wire din;
    wire y;
    child u_child(.din(din), .dout(y));
endmodule
`.trim());
    const index = new VerilogWorkspaceIndex();
    index.updateDocument(document, defaultCoSettings);
    const refs = getVerilogReferences(document, {
      textDocument: { uri: document.uri },
      position: positionOf(document, 'din,'),
      context: { includeDeclaration: true }
    }, defaultCoSettings, index);
    const referencedTexts = refs.map((location) => document.getText(location.range));

    expect(referencedTexts.filter((text) => text === 'din')).toHaveLength(2);
    expect(refs.some((location) => location.range.start.line === 5 && document.getText(location.range) === 'din')).toBe(false);
  });
});
