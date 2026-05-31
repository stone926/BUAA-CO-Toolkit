import { describe, it, expect } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { containsPosition, rangesEqual, makeDiagnostic, rangeAtOffset, lineAt, rangeOfText } from '../../../language/common/lsp';
import { TextDocument } from 'vscode-languageserver-textdocument';

function doc(text: string): TextDocument {
  return TextDocument.create('test://test.s', 'mipsasm', 1, text);
}

describe('containsPosition', () => {
  it('returns true for a position at the start of the range', () => {
    const range = { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } };
    expect(containsPosition(range, { line: 1, character: 5 })).toBe(true);
  });

  it('returns true for a position at the end of the range', () => {
    const range = { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } };
    expect(containsPosition(range, { line: 1, character: 10 })).toBe(true);
  });

  it('returns true for a position in the middle of the range', () => {
    const range = { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } };
    expect(containsPosition(range, { line: 1, character: 7 })).toBe(true);
  });

  it('returns false for a position before the range (same line)', () => {
    const range = { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } };
    expect(containsPosition(range, { line: 1, character: 4 })).toBe(false);
  });

  it('returns false for a position after the range (same line)', () => {
    const range = { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } };
    expect(containsPosition(range, { line: 1, character: 11 })).toBe(false);
  });

  it('returns false for a position on a line before the range', () => {
    const range = { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } };
    expect(containsPosition(range, { line: 4, character: 0 })).toBe(false);
  });

  it('returns false for a position on a line after the range', () => {
    const range = { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } };
    expect(containsPosition(range, { line: 6, character: 0 })).toBe(false);
  });

  it('handles multi-line ranges', () => {
    const range = { start: { line: 1, character: 5 }, end: { line: 3, character: 2 } };
    expect(containsPosition(range, { line: 1, character: 5 })).toBe(true);
    expect(containsPosition(range, { line: 2, character: 0 })).toBe(true);
    expect(containsPosition(range, { line: 2, character: 999 })).toBe(true);
    expect(containsPosition(range, { line: 3, character: 2 })).toBe(true);
    expect(containsPosition(range, { line: 3, character: 3 })).toBe(false);
    expect(containsPosition(range, { line: 1, character: 4 })).toBe(false);
  });

  it('handles zero-width ranges (start equals end)', () => {
    const range = { start: { line: 1, character: 5 }, end: { line: 1, character: 5 } };
    expect(containsPosition(range, { line: 1, character: 5 })).toBe(true);
    expect(containsPosition(range, { line: 1, character: 4 })).toBe(false);
    expect(containsPosition(range, { line: 1, character: 6 })).toBe(false);
  });
});

describe('rangesEqual', () => {
  it('returns true for identical ranges', () => {
    const a = { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } };
    const b = { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } };
    expect(rangesEqual(a, b)).toBe(true);
  });

  it('returns false when start differs', () => {
    const a = { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } };
    const b = { start: { line: 1, character: 6 }, end: { line: 1, character: 10 } };
    expect(rangesEqual(a, b)).toBe(false);
  });

  it('returns false when end differs', () => {
    const a = { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } };
    const b = { start: { line: 1, character: 5 }, end: { line: 1, character: 11 } };
    expect(rangesEqual(a, b)).toBe(false);
  });

  it('returns true for zero-width ranges at the same position', () => {
    const a = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const b = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    expect(rangesEqual(a, b)).toBe(true);
  });

  it('returns false when line differs but character is same', () => {
    const a = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const b = { start: { line: 1, character: 0 }, end: { line: 0, character: 0 } };
    expect(rangesEqual(a, b)).toBe(false);
  });
});

describe('makeDiagnostic', () => {
  it('creates a diagnostic with all fields', () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
    const d = makeDiagnostic(range, 'test message', DiagnosticSeverity.Error, 'test-code');
    expect(d.range).toBe(range);
    expect(d.message).toBe('test message');
    expect(d.severity).toBe(DiagnosticSeverity.Error);
    expect(d.code).toBe('test-code');
    expect(d.source).toBe('BUAA CO');
  });

  it('works with different severity levels', () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    expect(makeDiagnostic(range, '', DiagnosticSeverity.Warning, '').severity).toBe(DiagnosticSeverity.Warning);
    expect(makeDiagnostic(range, '', DiagnosticSeverity.Information, '').severity).toBe(DiagnosticSeverity.Information);
    expect(makeDiagnostic(range, '', DiagnosticSeverity.Hint, '').severity).toBe(DiagnosticSeverity.Hint);
  });
});

describe('lineAt', () => {
  it('returns the first line of a single-line document', () => {
    const d = doc('hello world');
    const line = lineAt(d, 0);
    expect(line.text).toBe('hello world');
    expect(line.range.start.line).toBe(0);
    expect(line.range.start.character).toBe(0);
    expect(line.range.end.character).toBe(11);
  });

  it('returns the correct line in a multi-line document', () => {
    const d = doc('line0\nline1\nline2');
    expect(lineAt(d, 0).text).toBe('line0');
    expect(lineAt(d, 1).text).toBe('line1');
    expect(lineAt(d, 2).text).toBe('line2');
  });

  it('handles Windows-style line endings', () => {
    const d = doc('line0\r\nline1\r\nline2');
    expect(lineAt(d, 0).text).toBe('line0');
    expect(lineAt(d, 1).text).toBe('line1');
    expect(lineAt(d, 2).text).toBe('line2');
  });

  it('handles an empty last line', () => {
    const d = doc('line0\n');
    expect(lineAt(d, 0).text).toBe('line0');
    expect(lineAt(d, 1).text).toBe('');
  });
});

describe('rangeAtOffset', () => {
  it('creates a range from offset and length', () => {
    const d = doc('hello world');
    const range = rangeAtOffset(d, 6, 5);
    expect(range.start.line).toBe(0);
    expect(range.start.character).toBe(6);
    expect(range.end.character).toBe(11);
  });

  it('handles multi-line documents', () => {
    const d = doc('abc\ndef');
    const range = rangeAtOffset(d, 4, 3);
    expect(range.start.line).toBe(1);
    expect(range.start.character).toBe(0);
    expect(range.end.line).toBe(1);
    expect(range.end.character).toBe(3);
  });
});

describe('rangeOfText', () => {
  it('finds the range of text on a specific line', () => {
    const d = doc('add $t0, $t1');
    const range = rangeOfText(d, 0, '$t0');
    expect(range.start.character).toBe(4);
    expect(range.end.character).toBe(7);
  });

  it('returns a range at position 0 if text is not found', () => {
    const d = doc('hello');
    const range = rangeOfText(d, 0, 'world');
    expect(range.start.character).toBe(0);
  });
});
