import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FoldingRange } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { getVerilogFoldingRanges } from '../../../language/verilog/folding';

function doc(text: string): TextDocument {
  return TextDocument.create('test://folding.v', 'verilog', 1, text);
}

function lineKeys(ranges: FoldingRange[]): string[] {
  return ranges.map((range) => `${range.startLine}-${range.endLine}`);
}

describe('Verilog folding', () => {
  it('keeps conditional directives out of minimap region markers and folds them through LSP', () => {
    const configuration = JSON.parse(readFileSync(resolve(process.cwd(), 'language-configuration/verilog.json'), 'utf8')) as {
      folding: { markers: { start: string; end: string } };
    };
    const startMarker = new RegExp(configuration.folding.markers.start);
    const endMarker = new RegExp(configuration.folding.markers.end);

    expect(startMarker.test('// region helpers')).toBe(true);
    expect(endMarker.test('// endregion helpers')).toBe(true);
    expect(startMarker.test('  `ifdef SOMETHING_LIKE_LOCAL_TEST')).toBe(false);
    expect(startMarker.test('  `ifndef OTHER')).toBe(false);
    expect(endMarker.test('  `endif')).toBe(false);

    const ranges = getVerilogFoldingRanges(doc([
      'module m;',
      '`ifdef OUTER',
      '  `ifndef INNER',
      '    initial $display("local");',
      '  `endif',
      '`elsif OTHER',
      '  wire other;',
      '`else',
      '  wire fallback;',
      '`endif',
      'endmodule',
    ].join('\n')), defaultCoSettings);

    expect(lineKeys(ranges)).toContain('1-9');
    expect(lineKeys(ranges)).toContain('2-4');
  });

  it('ignores conditional-looking text in comments, strings and continued macro bodies', () => {
    const ranges = getVerilogFoldingRanges(doc([
      '/*',
      '`ifdef COMMENT',
      '`endif',
      '*/',
      '`define BODY \\',
      '  `ifdef MACRO \\',
      '  `endif',
      'module m;',
      '  initial $display("`ifdef STRING");',
      '  initial $display("`endif");',
      'endmodule',
      '`endif',
      '`ifdef INCOMPLETE',
    ].join('\n')), defaultCoSettings);

    expect(ranges).toEqual([]);
  });

  it('folds module headers and instance port lists without folding the whole module', () => {
    const text = [
      'module CPU(',
      '  input wire clk,',
      '  output wire done',
      ');',
      '  Hazard Hazard (',
      '    .D_instr(D_instr),',
      '    .E_instr(E_instr)',
      '  );',
      '  always @(*) begin',
      '    case (op)',
      '      default: y = 0;',
      '    endcase',
      '  end',
      'endmodule'
    ].join('\n');

    const ranges = getVerilogFoldingRanges(doc(text), defaultCoSettings);
    expect(lineKeys(ranges)).toContain('0-3');
    expect(lineKeys(ranges)).toContain('4-7');
    expect(lineKeys(ranges)).toContain('8-12');
    expect(lineKeys(ranges)).toContain('9-11');
    expect(lineKeys(ranges)).not.toContain('0-13');
  });

  it('does not fold multiline non-instance parentheses that end before semicolon', () => {
    const text = [
      'module m;',
      '  always @(',
      '    posedge clk',
      '  ) begin',
      '    q <= d;',
      '  end',
      'endmodule'
    ].join('\n');

    const ranges = getVerilogFoldingRanges(doc(text), defaultCoSettings);
    expect(lineKeys(ranges)).not.toContain('1-3');
    expect(lineKeys(ranges)).toContain('3-5');
  });

  it('folds instances inside generate blocks', () => {
    const text = [
      'module top;',
      '  generate',
      '    if (USE) begin : g',
      '      Hazard Hazard (',
      '        .a(a),',
      '        .b(b)',
      '      );',
      '    end',
      '  endgenerate',
      'endmodule'
    ].join('\n');

    const ranges = getVerilogFoldingRanges(doc(text), defaultCoSettings);
    expect(lineKeys(ranges)).toContain('3-6');
    expect(lineKeys(ranges)).not.toContain('0-9');
  });
});
