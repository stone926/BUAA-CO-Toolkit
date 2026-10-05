import { describe, expect, it } from 'vitest';
import { FormattingOptions, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogFormattingEdits, getVerilogRangeFormattingEdits } from '../../../language/verilog/formatting';
import { formattingDocument, tokenBodies } from '../../helpers/verilogFormatting';

const settings = mergeCoSettings({});
const options: FormattingOptions = { tabSize: 4, insertSpaces: true };
function stable(source: string, formattingOptions = options): string {
  const document = formattingDocument(source);
  const output = TextDocument.applyEdits(document, getVerilogFormattingEdits(document, settings, formattingOptions));
  expect(tokenBodies(output)).toEqual(tokenBodies(source));
  expect(getVerilogFormattingEdits(formattingDocument(output), settings, formattingOptions)).toEqual([]);
  return output;
}

describe('Verilog formatter expression and list layout regressions', () => {
  it('aligns the screenshot boolean and ternary continuations to their right-hand sides', () => {
    const source = [
      'assign step = !reset && !maintenance &&',
      '              (!i_request || i_done) &&',
      '              (!d_request || d_translation_fault != 0 || d_done);',
      "assign i_fault = i_translation_fault != 0 ? i_translation_fault :",
      "                 i_done && i_error ? 5'd6 : 5'd0; // IBE",
      "assign d_fault = d_translation_fault != 0 ? d_translation_fault :",
      "                 d_done && d_error ? 5'd7 : 5'd0; // DBE"
    ].join('\n');
    expect(stable(source)).toBe([
      'assign step = !reset && !maintenance &&',
      '              (!i_request || i_done) &&',
      '              (!d_request || d_translation_fault != 0 || d_done);',
      "assign i_fault = i_translation_fault != 0 ? i_translation_fault :",
      "                 i_done && i_error        ? 5'd6 : 5'd0; // IBE",
      "assign d_fault = d_translation_fault != 0 ? d_translation_fault :",
      "                 d_done && d_error        ? 5'd7 : 5'd0; // DBE"
    ].join('\n'));
  });

  it('aligns initialized wire conditions without a large gap before the second question mark', () => {
    const source = "wire victim = !valid0[set_index] ? 1'b0 :\n!valid1[set_index] ? 1'b1 : lru[set_index];";
    expect(stable(source)).toBe("wire victim = !valid0[set_index] ? 1'b0 :\n              !valid1[set_index] ? 1'b1 : lru[set_index];");
  });

  it('closes module parameter and port lists at the module indentation', () => {
    const source = [
      'module stone_memory #(',
      'parameter SET_BITS = 4, parameter LINE_WORD_BITS = 2',
      ') (',
      'input wire clk, reset,',
      'input wire [31:0] i_paddr, d_paddr, d_wdata,',
      'output wire [4:0] i_fault, d_fault',
      ');',
      'wire ready;',
      'endmodule'
    ].join('\n');
    expect(stable(source)).toBe([
      'module stone_memory #(',
      '    parameter SET_BITS = 4, parameter LINE_WORD_BITS = 2',
      ') (',
      '    input wire         clk, reset,',
      '    input wire  [31:0] i_paddr, d_paddr, d_wdata,',
      '    output wire [4:0]  i_fault, d_fault',
      ');',
      '    wire ready;',
      'endmodule'
    ].join('\n'));
  });

  it('does not join ternary alignment across separate assignments or unrelated statements', () => {
    const source = "wire a = x ? 1 : 0;\nwire longer_name = condition ? 1 : 0;\nassign y = x ? 1 :\n0;\nwire untouched;";
    const output = stable(source);
    expect(output).toContain('wire a = x ? 1 : 0;\nwire longer_name = condition ? 1 : 0;');
    expect(output).toContain('assign y = x ? 1 :\n           0;\nwire untouched;');
  });

  it('does not align a nested true-arm question with its outer condition', () => {
    expect(stable('assign value = long_condition ?\na ? b : c :\nd;')).toBe([
      'assign value = long_condition ?',
      '               a ? b : c :',
      '               d;'
    ].join('\n'));
  });

  it('keeps nested expression indentation and handles operators at the start of continuation lines', () => {
    expect(stable('assign ready = enabled\n&& (a ||\nb)\n&& valid;')).toBe([
      'assign ready = enabled',
      '               && (a ||',
      '                   b)',
      '               && valid;'
    ].join('\n'));
  });

  it('uses visual columns for tab-indented right-hand sides', () => {
    expect(stable("module m;\nwire victim = a ? 0 :\nb ? 1 : 2;\nendmodule", { tabSize: 4, insertSpaces: false }))
      .toBe("module m;\n\twire victim = a ? 0 :\n\t\t\t\t  b ? 1 : 2;\nendmodule");
  });

  it.each(['// why\n', '// why\n// also why\n', ''])('aligns continuations after line comments: %j', comment => {
    expect(stable('assign y = a && // inline\n' + comment + 'b;')).toBe(
      'assign y = a && // inline\n' + comment.split('\n').filter(Boolean).map(line => '           ' + line + '\n').join('') + '           b;');
  });

  it('reuses the moved anchor in a later declarator on the same continued line', () => {
    expect(stable('assign a = x ?\ny : z, b = abc &&\ndef;')).toBe([
      'assign a = x ?',
      '           y : z, b = abc &&',
      '                      def;'
    ].join('\n'));
  });

  it('includes ternary padding when a later assignment starts on a branch line', () => {
    const output = stable('assign a = longer ? 1 :\nb ? 2 : 3, c = foo &&\nbar;').split('\n');
    expect(output[2].indexOf('bar')).toBe(output[1].indexOf('foo'));
  });

  it('aligns branches across their explanatory comments', () => {
    const output = stable('assign a = x ? 1 :\n// annotated branch\nlonger ? 2 : 3;').split('\n');
    expect(output[0].indexOf('?')).toBe(output[2].indexOf('?'));
    expect(output[1]).toBe('           // annotated branch');
  });

  it('uses restored conditional-compilation depth for following statements', () => {
    const source = ['`ifdef A', 'assign a = (', '`else', 'assign a = (', '`endif',
      'x && y);', 'assign long_name = a &&', 'b;'].join('\n');
    expect(stable(source)).toContain('assign long_name = a &&\n                   b;');
  });

  it('keeps continuation indentation stable around an inline else', () => {
    const source = 'module m;\ninitial if(a) begin x =\nb; end else begin y =\nc; end\nendmodule';
    stable(source);
  });

  it('tracks delimiters closed inside a disabled region', () => {
    expect(stable('assign a = f(\n// co-format: off\nx);\n// co-format: on\nassign long_name = a &&\nb;')).toContain(
      'assign long_name = a &&\n                   b;');
  });

  it('formats only the selected continuation while using its outside assignment as context', () => {
    const source = 'module m;\n    assign step = a &&\nb;\nwire  untouched;\nendmodule';
    const range = Range.create(2, 0, 3, 0);
    const output = TextDocument.applyEdits(formattingDocument(source), getVerilogRangeFormattingEdits(formattingDocument(source), range, settings, options));
    expect(output).toBe('module m;\n    assign step = a &&\n                  b;\nwire  untouched;\nendmodule');
    expect(getVerilogRangeFormattingEdits(formattingDocument(output), range, settings, options)).toEqual([]);
  });

  it('uses the actual unformatted outside right-hand side column for a selected continuation', () => {
    const source = 'module m;\n    assign    step=a &&\nb;\nendmodule';
    const range = Range.create(2, 0, 3, 0);
    const output = TextDocument.applyEdits(formattingDocument(source), getVerilogRangeFormattingEdits(formattingDocument(source), range, settings, options));
    expect(output).toBe('module m;\n    assign    step=a &&\n                   b;\nendmodule');
    expect(getVerilogRangeFormattingEdits(formattingDocument(output), range, settings, options)).toEqual([]);
  });
});
