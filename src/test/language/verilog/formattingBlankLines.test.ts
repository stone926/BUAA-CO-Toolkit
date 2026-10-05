import { describe, expect, it } from 'vitest';
import { FormattingOptions, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogFormattingEdits, getVerilogRangeFormattingEdits } from '../../../language/verilog/formatting';

const options: FormattingOptions = { tabSize: 2, insertSpaces: true };

function format(text: string, maxBlankLines?: number | 'preserve', supplied = options): string {
  const settings = mergeCoSettings({ verilog: { format: { maxBlankLines } } });
  const document = TextDocument.create('test://blank-lines.v', 'verilog', 1, text);
  const output = TextDocument.applyEdits(document, getVerilogFormattingEdits(document, settings, supplied));
  const formattedDocument = TextDocument.create(document.uri, document.languageId, 2, output);
  expect(getVerilogFormattingEdits(formattedDocument, settings, supplied)).toEqual([]);
  return output;
}

describe('Verilog intentional blank lines', () => {
  it.each(['\n', '\r\n', '\r'])('preserves leading, internal and final blank lines with %j EOL', (eol) => {
    const input = ['', '', '', '', 'module m;', '', '', '', '', 'assign x=1;', '', '', 'endmodule', '', '', ''].join(eol);
    const expected = ['', '', '', '', 'module m;', '', '', '', '', '  assign x = 1;', '', '', 'endmodule', '', '', ''].join(eol);
    expect(format(input)).toBe(expected);
    expect(format(input, 'preserve')).toBe(expected);
  });

  it('retains every original mixed EOL while cleaning spaces on blank lines', () => {
    const input = '\r\n \n\rmodule m;\r\n  \r\n\n \rassign x=1;\n\r\nendmodule\r\n\n';
    const expected = '\r\n\n\rmodule m;\r\n\r\n\n\r  assign x = 1;\n\r\nendmodule\r\n\n';
    expect(format(input)).toBe(expected);
  });

  it('honors an explicit request to retain whitespace on blank lines', () => {
    const input = '\n \n\t\nmodule m; \n \n\t\nassign x=1;\nendmodule';
    expect(format(input, undefined, { ...options, trimTrailingWhitespace: false }))
      .toBe('\n \n\t\nmodule m; \n \n\t\n  assign x = 1;\nendmodule');
  });

  it.each([0, 1, 2, 3])('ignores the removed blank line limit of %i', (limit) => {
    const input = '\n'.repeat(5) + 'module m;\n' + '\n'.repeat(5)
      + '// comment\n' + '\n'.repeat(5) + 'assign x=1;\nendmodule';
    const expected = '\n'.repeat(5) + 'module m;\n' + '\n'.repeat(5)
      + '  // comment\n' + '\n'.repeat(5) + '  assign x = 1;\nendmodule';
    expect(format(input, limit)).toBe(expected);
  });

  it('retains blank lines around directives and protected regions', () => {
    const input = ['module m;', '', '', '', '`define BODY x+y', '', '', '',
      '// co-format: off', '  assign a=1;', '', '', '', '// co-format: on', '', '', '',
      'assign x=1;', 'endmodule'].join('\n');
    const output = format(input);
    expect(output.match(/\n/g)).toHaveLength(input.match(/\n/g)!.length);
    expect(output).toContain('// co-format: off\n  assign a=1;\n\n\n\n// co-format: on');
    expect(output).toContain('  assign x = 1;');
  });

  it('preserves internal blank lines when final newline cleanup is explicitly enabled', () => {
    const input = '\n\nmodule m;\n\n\n\nassign x=1;\nendmodule\n\n\n';
    expect(format(input, undefined, { ...options, trimFinalNewlines: true, insertFinalNewline: true }))
      .toBe('\n\nmodule m;\n\n\n\n  assign x = 1;\nendmodule\n');
  });

  it('preserves blank lines and text outside a range even with EOF cleanup enabled', () => {
    const input = '\n\nmodule m;\n\n\n\nassign x=1;\n\n\n\nendmodule\n\n\n';
    const document = TextDocument.create('test://range.v', 'verilog', 1, input);
    const settings = mergeCoSettings({});
    const edits = getVerilogRangeFormattingEdits(document, Range.create(4, 0, 9, 0), settings,
      { ...options, trimFinalNewlines: true, insertFinalNewline: true });
    const output = TextDocument.applyEdits(document, edits);
    expect(output).toBe('\n\nmodule m;\n\n\n\n  assign x = 1;\n\n\n\nendmodule\n\n\n');
    const formattedDocument = TextDocument.create(document.uri, document.languageId, 2, output);
    expect(getVerilogRangeFormattingEdits(formattedDocument, Range.create(4, 0, 9, 0), settings, options)).toEqual([]);
  });
});
