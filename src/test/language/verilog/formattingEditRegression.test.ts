import { describe, expect, it } from 'vitest';
import { FormattingOptions, Range } from 'vscode-languageserver/node';
import { getVerilogRangeFormattingEdits } from '../../../language/verilog/formatting';
import { applyFormattingEdits, expectStableFormatting, formattingDocument, formattingOptions, formattingSettings, tokenBodies } from '../../helpers/verilogFormatting';

function expectRange(source: string, range: Range, expected: string, options: FormattingOptions = formattingOptions): void {
  const document = formattingDocument(source);
  const edits = getVerilogRangeFormattingEdits(document, range, formattingSettings, options);
  const start = document.offsetAt({ line: range.start.line, character: 0 });
  const end = document.offsetAt({ line: range.end.line + (range.end.character ? 1 : 0), character: 0 });
  for (const edit of edits) {
    expect(document.offsetAt(edit.range.start)).toBeGreaterThanOrEqual(start);
    expect(document.offsetAt(edit.range.end)).toBeLessThanOrEqual(end);
  }
  const result = applyFormattingEdits(document, edits);
  expect(result).toBe(expected);
  expect(result.slice(0, start)).toBe(source.slice(0, start));
  const suffix = source.slice(end);
  if (suffix) expect(result.endsWith(suffix)).toBe(true);
  expect(tokenBodies(result)).toEqual(tokenBodies(source));
  expect(getVerilogRangeFormattingEdits(formattingDocument(result), range, formattingSettings, options)).toEqual([]);
}

describe('Verilog whitespace edit regressions', () => {
  it.each(['1 . 2', '1. 2', '1 .2'])('preserves separated numeric tokens in %s', expression => {
    expectStableFormatting(`module m;\ninitial x = ${expression};\nendmodule`);
  });
  it.each(['~ &a', '~ ^a', '^ ~a', '& &a', '| |a', '/ *a', '/ /a', '< =a', '> >a'])('preserves operator boundaries in %s', expression => {
    expectStableFormatting(`module m;\ninitial x = ${expression};\nendmodule`);
  });
  it('still compacts hierarchy and named ports', () => {
    expect(expectStableFormatting('module m;\ninitial x = top . child . value;\nchild u (. a (x));\nendmodule'))
      .toContain('top.child.value');
  });
  for (const eol of ['\n', '\r\n']) {
    it.each(['   ', '   ' + eol + '  ', '   ' + eol + '  ' + eol + '\t'])('preserves unselected whitespace before the first selected line (%j)', before => {
      const prefix = 'module m;' + before + eol;
      const line = prefix.split(eol).length - 1;
      expectRange(prefix + 'wire a;' + eol + 'endmodule', Range.create(line, 0, line + 1, 0), prefix + '  wire a;' + eol + 'endmodule');
    });
    it('clips the right gap without changing the next line or its blank lines', () => {
      const source = ['module m;   ', 'wire a;   ', ' \t', '', '    wire b;', 'endmodule'].join(eol);
      const expected = ['module m;   ', '  wire a;', ' \t', '', '    wire b;', 'endmodule'].join(eol);
      expectRange(source, Range.create(1, 1, 2, 0), expected);
      expectRange(source, Range.create(1, 1, 1, 5), expected);
    });
    it('keeps the range between off/on and a directive bounded', () => {
      const prefix = ['module m;', '// co-format: off', 'wire    raw;  ', '// co-format: on', '  ', ''].join(eol);
      const suffix = ["`define VALUE  1   ", 'endmodule', '', ''].join(eol);
      expectRange(prefix + 'wire a;' + eol + suffix, Range.create(5, 0, 6, 0), prefix + '  wire a;' + eol + suffix);
    });
    it('does not execute EOF options outside the selected line', () => {
      const source = ['module m;   ', 'wire a;', 'endmodule', '', '', ''].join(eol);
      const expected = ['module m;   ', '  wire a;', 'endmodule', '', '', ''].join(eol);
      expectRange(source, Range.create(1, 0, 2, 0), expected, { ...formattingOptions, trimFinalNewlines: true, insertFinalNewline: true });
      expectRange(['module m;   ', 'wire a;', 'endmodule'].join(eol), Range.create(1, 0, 2, 9), ['module m;   ', '  wire a;', 'endmodule'].join(eol), { ...formattingOptions, trimFinalNewlines: true, insertFinalNewline: true });
    });
  }
  it.each(['\n', '\r\n'])('indents a selected line without touching preceding spaces with %j', eol => {
    const source = ['module m;   ', 'wire a;', 'endmodule'].join(eol);
    const range = Range.create(1, 0, 2, 0);
    const document = formattingDocument(source);
    const result = applyFormattingEdits(document, getVerilogRangeFormattingEdits(document, range, formattingSettings, formattingOptions));
    expect(result).toBe(['module m;   ', '  wire a;', 'endmodule'].join(eol));
    expect(tokenBodies(result)).toEqual(tokenBodies(source));
    expect(getVerilogRangeFormattingEdits(formattingDocument(result), range, formattingSettings, formattingOptions)).toEqual([]);
  });
});
