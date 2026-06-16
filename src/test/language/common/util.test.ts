import { describe, it, expect } from 'vitest';
import { rangeKey, escapeHtml, escapeRegExp, createMipsTokenRegex } from '../../../language/common/util';

describe('rangeKey', () => {
  it('produces a deterministic key for the same range', () => {
    const range = { start: { line: 1, character: 5 }, end: { line: 1, character: 10 } };
    expect(rangeKey(range)).toBe('1:5:1:10');
    expect(rangeKey(range)).toBe(rangeKey(range));
  });

  it('produces different keys for different ranges', () => {
    const a = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
    const b = { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } };
    expect(rangeKey(a)).not.toBe(rangeKey(b));
  });

  it('distinguishes same positions but different start/end lines', () => {
    const a = { start: { line: 0, character: 5 }, end: { line: 1, character: 5 } };
    const b = { start: { line: 1, character: 5 }, end: { line: 0, character: 5 } };
    expect(rangeKey(a)).not.toBe(rangeKey(b));
  });

  it('handles zero positions', () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    expect(rangeKey(range)).toBe('0:0:0:0');
  });

  it('handles large line/character numbers', () => {
    const range = { start: { line: 99999, character: 99999 }, end: { line: 99999, character: 99999 } };
    expect(rangeKey(range)).toBe('99999:99999:99999:99999');
  });
});

describe('escapeRegExp', () => {
  it('returns plain strings unchanged', () => {
    expect(escapeRegExp('hello')).toBe('hello');
    expect(escapeRegExp('abc123')).toBe('abc123');
    expect(escapeRegExp('')).toBe('');
  });

  it('escapes all special regex characters', () => {
    expect(escapeRegExp('.')).toBe('\\.');
    expect(escapeRegExp('*')).toBe('\\*');
    expect(escapeRegExp('+')).toBe('\\+');
    expect(escapeRegExp('?')).toBe('\\?');
    expect(escapeRegExp('^')).toBe('\\^');
    expect(escapeRegExp('$')).toBe('\\$');
    expect(escapeRegExp('{')).toBe('\\{');
    expect(escapeRegExp('}')).toBe('\\}');
    expect(escapeRegExp('(')).toBe('\\(');
    expect(escapeRegExp(')')).toBe('\\)');
    expect(escapeRegExp('|')).toBe('\\|');
    expect(escapeRegExp('[')).toBe('\\[');
    expect(escapeRegExp(']')).toBe('\\]');
    expect(escapeRegExp('\\')).toBe('\\\\');
  });

  it('escapes mixed content', () => {
    expect(escapeRegExp('$v0')).toBe('\\$v0');
    expect(escapeRegExp('a.b')).toBe('a\\.b');
    expect(escapeRegExp('[0:31]')).toBe('\\[0:31\\]');
    expect(escapeRegExp('(a|b)')).toBe('\\(a\\|b\\)');
  });

  it('result can be used in a RegExp constructor to match the original string', () => {
    const specials = '.*+?^${}()|[]\\';
    const escaped = escapeRegExp(specials);
    const regex = new RegExp(escaped);
    expect(regex.test(specials)).toBe(true);
  });
});

describe('escapeHtml', () => {
  it('escapes HTML-sensitive characters', () => {
    expect(escapeHtml('&<>"')).toBe('&amp;&lt;&gt;&quot;');
    expect(escapeHtml('a < b && c > "d"')).toBe('a &lt; b &amp;&amp; c &gt; &quot;d&quot;');
  });

  it('stringifies non-string values before escaping', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(undefined)).toBe('undefined');
  });
});

describe('createMipsTokenRegex', () => {
  it('returns a new instance each time (no lastIndex sharing)', () => {
    const r1 = createMipsTokenRegex();
    const r2 = createMipsTokenRegex();
    expect(r1).not.toBe(r2);
  });

  it('matches plain identifiers', () => {
    const regex = createMipsTokenRegex();
    expect('add'.match(regex)).toEqual(['add']);
    expect('_label'.match(regex)).toEqual(['_label']);
    expect('$L0'.match(regex)).toEqual(['$L0']);
  });

  it('matches register names starting with $', () => {
    const regex = createMipsTokenRegex();
    const result = '$t0 $ra $0 $31'.match(regex);
    expect(result).toEqual(['$t0', '$ra', '$0', '$31']);
  });

  it('matches macro parameters starting with %', () => {
    const regex = createMipsTokenRegex();
    expect('%arg'.match(regex)).toEqual(['%arg']);
    expect('%dst'.match(regex)).toEqual(['%dst']);
  });

  it('does not match empty strings or whitespace-only', () => {
    const regex = createMipsTokenRegex();
    expect(''.match(regex)).toBeNull();
    expect('   '.match(regex)).toBeNull();
  });

  it('matches tokens with dots and dollar signs in names', () => {
    const regex = createMipsTokenRegex();
    expect('$v0'.match(regex)).toEqual(['$v0']);
  });

  it('matches multiple tokens in a line', () => {
    const regex = createMipsTokenRegex();
    const result = 'add $t0, $t1, $t2'.match(regex);
    expect(result).toEqual(['add', '$t0', '$t1', '$t2']);
  });
});
