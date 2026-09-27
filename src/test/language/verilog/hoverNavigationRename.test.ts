import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { URI } from 'vscode-uri';
import { defaultCoSettings } from '../../../language/common/settings';
import {
  getVerilogDefinition,
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

    expect(text).toContain('**localparam**');
    expect(text).toContain('Constant value: `8 (0x8)`');
    expect(text).not.toContain('localparam WIDTH');
    expect(text).not.toContain('Expression `WIDTH`');
  });

  it('summarizes declaration and reference widths without repeating the source line', () => {
    const document = verilogDoc('module top; wire [3:0] W_t_rsuse; assign W_t_rsuse = 4\'b0; endmodule');
    const index = new VerilogWorkspaceIndex();
    for (const sourceOffset of [document.getText().indexOf('W_t_rsuse'), document.getText().lastIndexOf('W_t_rsuse')]) {
      const text = hoverText(getVerilogHover(document, document.positionAt(sourceOffset), defaultCoSettings, index));
      expect(text).toContain('**wire**');
      expect(text).toContain('Width: `4` bits');
      expect(text).not.toContain('wire [3:0] W_t_rsuse');
    }
  });

  it('preserves symbolic ranges and unpacked array dimensions in a compact hover', () => {
    const document = verilogDoc('module top; wire [UNKNOWN-1:0] memory [0:3]; assign memory[0] = 0; endmodule');
    const text = hoverText(getVerilogHover(document, positionOf(document, 'memory [0:3]'), defaultCoSettings, new VerilogWorkspaceIndex()));

    expect(text).toContain('Range: `[UNKNOWN-1:0]`');
    expect(text).toContain('Array: `[0:3]`');
    expect(text).not.toContain('wire [UNKNOWN-1:0] memory [0:3]');
  });

  it('shows both widths only when a port connection differs from its target', () => {
    const document = verilogDoc('module child(input [7:0] din); endmodule\nmodule top; wire [3:0] data; child u(.din(data)); endmodule');
    const index = new VerilogWorkspaceIndex();
    const text = hoverText(getVerilogHover(document, positionOf(document, '.din', 1), defaultCoSettings, index));

    expect(text).toContain('Effective width: `8` bits');
    expect(text).toContain('Connection width: `4` bits');
    expect(text).not.toContain('input [7:0] din');
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

describe('generate block navigation', () => {
  it('resolves same-named signals to the generate branch that declares them', () => {
    const document = verilogDoc(`
module top(input [7:0] a);
    generate if (1) begin : fast
        wire [7:0] v;
        assign v = a;
    end else begin : slow
        wire [7:0] v;
        assign v = ~a;
    end endgenerate
endmodule
`.trim());
    const index = new VerilogWorkspaceIndex();
    index.updateDocument(document, defaultCoSettings);
    const definitionLine = (text: string) =>
      getVerilogDefinition(document, positionOf(document, text, 'assign '.length), defaultCoSettings, index)?.range.start.line;
    expect(definitionLine('assign v = a;')).toBe(2);
    expect(definitionLine('assign v = ~a;')).toBe(5);
  });
});
