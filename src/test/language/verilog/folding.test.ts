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
