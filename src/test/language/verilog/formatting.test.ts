import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { FormattingOptions } from 'vscode-languageserver/node';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogFormattingEdits } from '../../../language/verilog/formatting';

function doc(text: string): TextDocument {
  return TextDocument.create('test://format.v', 'verilog', 1, text);
}

const twoSpaceFormatting: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2
};

function format(text: string, settings = mergeCoSettings({}), options = twoSpaceFormatting): string {
  const document = doc(text);
  const edit = getVerilogFormattingEdits(document, settings, options)[0];
  return edit?.newText ?? text;
}

describe('Verilog formatting', () => {
  it('formats with the default BUAA CO course style', () => {
    const input = [
      'module demo(',
      'input [31:0] a,',
      'output reg [3:0] y',
      ');',
      'always@(posedge clk) begin',
      'if(a==1) begin',
      "y<=4'b0;",
      'end else begin',
      'y<=a+1;',
      'end',
      'end',
      'endmodule'
    ].join('\n');

    expect(format(input)).toBe([
      'module demo(',
      '    input [31: 0] a,',
      '    output reg [3: 0] y',
      '  );',
      '  always @(posedge clk) begin',
      '    if (a == 1) begin',
      "      y <= 4'b0;",
      '    end',
      '    else begin',
      '      y <= a + 1;',
      '    end',
      '  end',
      'endmodule'
    ].join('\n'));
  });

  it('honors custom style settings', () => {
    const settings = mergeCoSettings({
      verilog: {
        format: {
          style: 'custom',
          continuationIndent: 1,
          spaceInRange: false,
          spaceBeforeInstancePorts: false,
          separateElse: false,
          maxBlankLines: 0
        }
      }
    });
    const input = [
      'module demo(',
      'input [31 : 0] a',
      ');',
      '',
      'Sub u_sub (',
      '.a(a)',
      ');',
      'always @ (posedge clk) begin',
      'if (a != 0) begin',
      'end else begin',
      'end',
      'end',
      'endmodule'
    ].join('\n');

    expect(format(input, settings, { insertSpaces: true, tabSize: 4 })).toBe([
      'module demo(',
      '    input [31:0] a',
      '    );',
      '    Sub u_sub(',
      '        .a(a)',
      '        );',
      '    always @(posedge clk) begin',
      '        if (a != 0) begin',
      '        end else begin',
      '        end',
      '    end',
      'endmodule'
    ].join('\n'));
  });

  it('does not rewrite operators inside string literals or line comments', () => {
    const input = [
      'module tb;',
      '$display("a<=b // keep"); // a<=b',
      'endmodule'
    ].join('\n');

    expect(format(input)).toContain('$display("a<=b // keep"); // a<=b');
  });

  it('formats wildcard always blocks as always @(*)', () => {
    expect(format('module demo;\nalways@( * ) begin\nend\nendmodule')).toContain('always @(*) begin');
  });

  it('does not treat comment-only lines ending in colon as continued expressions', () => {
    const input = [
      '// Company:',
      '// Engineer:',
      '// Project Name:',
      '`default_nettype none',
      'module demo(',
      'input clk',
      ');',
      'endmodule'
    ].join('\n');

    expect(format(input)).toBe([
      '// Company:',
      '// Engineer:',
      '// Project Name:',
      '`default_nettype none',
      'module demo(',
      '    input clk',
      '  );',
      'endmodule'
    ].join('\n'));
  });

  it('uses VS Code formatting options for indentation', () => {
    const input = [
      'module demo;',
      'if(a) begin',
      'a<=1;',
      'end',
      'endmodule'
    ].join('\n');

    expect(format(input, mergeCoSettings({}), { insertSpaces: false, tabSize: 4 })).toBe([
      'module demo;',
      '\tif (a) begin',
      '\t\ta <= 1;',
      '\tend',
      'endmodule'
    ].join('\n'));
  });
});
