import { describe, expect, it } from 'vitest';
import { Range } from 'vscode-languageserver/node';
import { getVerilogRangeFormattingEdits } from '../../../language/verilog/formatting';
import { applyFormattingEdits, formattingDocument, formattingSettings, formattingOptions, tokenBodies } from '../../helpers/verilogFormatting';

function formatRange(source: string, range: Range): string {
  const document = formattingDocument(source);
  const edits = getVerilogRangeFormattingEdits(document, range, formattingSettings, { ...formattingOptions, trimTrailingWhitespace: true, trimFinalNewlines: true, insertFinalNewline: true });
  const start = document.offsetAt({ line: range.start.line, character: 0 });
  const endLine = range.end.line + (range.end.character === 0 ? 0 : 1);
  const end = document.offsetAt({ line: endLine, character: 0 });
  for (const edit of edits) {
    expect(document.offsetAt(edit.range.start)).toBeGreaterThanOrEqual(start);
    expect(document.offsetAt(edit.range.end)).toBeLessThanOrEqual(end);
  }
  const result = applyFormattingEdits(document, edits);
  expect(result.slice(0, start)).toBe(source.slice(0, start));
  const suffix = source.slice(end);
  if (suffix) expect(result.slice(-suffix.length)).toBe(suffix);
  expect(tokenBodies(result)).toEqual(tokenBodies(source));
  return result;
}

describe('Verilog range formatting boundary contract', () => {
  it.each(['\n', '\r\n'])('formats intersecting complete lines with %j', eol => {
    const source = ['module m;', 'initial begin', 'x=1;', 'y=2;  ', 'end', 'endmodule', '', ''].join(eol);
    const result = formatRange(source, Range.create(2, 1, 3, 0));
    expect(result).toBe(['module m;', 'initial begin', '    x = 1;', 'y=2;  ', 'end', 'endmodule', '', ''].join(eol));
    const document = formattingDocument(result);
    expect(getVerilogRangeFormattingEdits(document, Range.create(2, 1, 3, 0), formattingSettings, formattingOptions)).toEqual([]);
  });
  it('includes the final selected line when end character is nonzero', () => {
    expect(formatRange('module m;\nx=1;\ny=2;\nendmodule', Range.create(1, 1, 2, 1))).toBe('module m;\n  x = 1;\n  y = 2;\nendmodule');
  });
  it.each([Range.create(0, 0, 0, 0), Range.create(1, 2, 1, 2)])('returns no edits for an empty selection', range => {
    expect(getVerilogRangeFormattingEdits(formattingDocument('module m;\nwire a;\nendmodule'), range, formattingSettings, formattingOptions)).toEqual([]);
  });
  it('does not apply EOF options even when the selection ends at EOF', () => {
    expect(formatRange('module m;\nwire a;\nendmodule', Range.create(1, 0, 2, 9))).toBe('module m;\n  wire a;\nendmodule');
  });
  it('keeps off/on areas intact inside a selected range', () => {
    const source = 'module m;\n// co-format: off\nwire    a;  \n// co-format: on\nassign a=1;\nendmodule';
    expect(formatRange(source, Range.create(1, 0, 5, 0))).toBe(source.replace('assign a=1;', '  assign a = 1;'));
  });
  it.each([
    'module m;\n/* header\n  raw   <=\n end */\nwire a;\nendmodule',
    '`define M \\\n   begin \\\n    x=x+1; \\\n   end\nmodule m;\nendmodule'
  ])('does not rewrite a multiline protected token intersecting the range', source => {
    expect(formatRange(source, Range.create(2, 1, 3, 0))).toBe(source);
  });
});
