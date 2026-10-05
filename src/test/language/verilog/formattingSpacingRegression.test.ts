import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { formatVerilog, expectStableFormatting, formattingDocument, formattingOptions } from '../../helpers/verilogFormatting';
import { getVerilogFormattingEdits } from '../../../language/verilog/formatting';

describe('Verilog formatter spacing regressions', () => {
  it('keeps a space between commas and named instance port or parameter connections', () => {
    const source = [
      'module m;',
      'Sub u0(.clk(clk),.reset(reset));',
      'Sub #(.SET_BITS(SET_BITS),.LINE_WORD_BITS(LINE_WORD_BITS)) u1();',
      'endmodule'
    ].join('\n');

    const result = expectStableFormatting(source);
    expect(result).toContain('.clk(clk), .reset(reset)');
    expect(result).toContain('.SET_BITS(SET_BITS), .LINE_WORD_BITS(LINE_WORD_BITS)');
  });

  it('spaces an instance name before its port list by default, including an empty list', () => {
    const result = formatVerilog('module m;\nTC timer0 ();\nendmodule');

    expect(result).toContain('TC timer0 ();');
    expectStableFormatting(result);
  });

  it('keeps the instance-name space in an incomplete final instance declaration', () => {
    const result = formatVerilog('module m;\nTC timer0 ()');

    expect(result).toContain('TC timer0 ()');
    expectStableFormatting(result);
  });

  it('keeps ordinary function calls tight and ignores the removed instance spacing preference', () => {
    const source = 'module m;\nassign y = f(x);\nTC timer0 ();\nendmodule';
    const settings = mergeCoSettings({ verilog: { format: { spaceBeforeInstancePorts: false } } });
    const document = formattingDocument(source);
    const result = TextDocument.applyEdits(document, getVerilogFormattingEdits(document, settings, formattingOptions));

    expect(result).toContain('f(x)');
    expect(result).toContain('TC timer0 ();');
    expect(result).not.toContain('f (x)');
  });
});
