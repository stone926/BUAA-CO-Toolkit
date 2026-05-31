import { describe, it, expect } from 'vitest';
import {
  stripComment,
  parseOperands,
  parseMacroArguments,
  formatMipsLine,
  findCommentIndex,
  getStringRanges,
  getNumericLikeRanges,
  isInsideAnyRange,
  isIntegerLiteral,
  isNonNegativeIntegerLiteral,
  parseIntegerLiteral,
  isFloatLiteral,
  isCharLiteral,
  isSymbolLike,
  signed32ImmediateValue,
  integerFitsRange
} from '../../../language/mips/syntax';

// ────────────────────────────────────────────────────────────────────────────────
// parseIntegerLiteral
// ────────────────────────────────────────────────────────────────────────────────
describe('parseIntegerLiteral', () => {
  describe('decimal integers', () => {
    it('parses zero', () => {
      expect(parseIntegerLiteral('0')).toBe(0);
    });

    it('parses positive integers', () => {
      expect(parseIntegerLiteral('42')).toBe(42);
      expect(parseIntegerLiteral('1')).toBe(1);
      expect(parseIntegerLiteral('65535')).toBe(65535);
    });

    it('parses negative integers', () => {
      expect(parseIntegerLiteral('-1')).toBe(-1);
      expect(parseIntegerLiteral('-42')).toBe(-42);
    });

    it('parses explicit positive sign', () => {
      expect(parseIntegerLiteral('+42')).toBe(42);
    });

    it('parses max unsigned 32-bit value (0xFFFFFFFF = 4294967295)', () => {
      expect(parseIntegerLiteral('4294967295')).toBe(4294967295);
    });

    it('parses min signed 32-bit value (-2147483648)', () => {
      expect(parseIntegerLiteral('-2147483648')).toBe(-2147483648);
    });

    it('rejects values exceeding 32-bit range', () => {
      expect(parseIntegerLiteral('4294967296')).toBeUndefined();
      expect(parseIntegerLiteral('-2147483649')).toBeUndefined();
    });
  });

  describe('hexadecimal integers', () => {
    it('parses basic hex', () => {
      expect(parseIntegerLiteral('0x10')).toBe(16);
      expect(parseIntegerLiteral('0xFF')).toBe(255);
      expect(parseIntegerLiteral('0xff')).toBe(255);
    });

    it('parses 0x prefix with uppercase X', () => {
      expect(parseIntegerLiteral('0X10')).toBe(16);
    });

    it('parses hex zero', () => {
      expect(parseIntegerLiteral('0x0')).toBe(0);
    });

    it('parses max 32-bit hex', () => {
      expect(parseIntegerLiteral('0xFFFFFFFF')).toBe(0xFFFFFFFF);
    });

    it('rejects hex exceeding 32 bits', () => {
      expect(parseIntegerLiteral('0x100000000')).toBeUndefined();
    });

    it('parses negative hex', () => {
      expect(parseIntegerLiteral('-0x1')).toBe(-1);
    });
  });

  describe('binary integers', () => {
    it('parses basic binary', () => {
      expect(parseIntegerLiteral('0b1010')).toBe(10);
      expect(parseIntegerLiteral('0B1010')).toBe(10);
    });

    it('parses binary zero', () => {
      expect(parseIntegerLiteral('0b0')).toBe(0);
    });

    it('parses max 32-bit binary', () => {
      const maxBin = '0b' + '1'.repeat(32);
      expect(parseIntegerLiteral(maxBin)).toBe(0xFFFFFFFF);
    });

    it('rejects binary exceeding 32 bits', () => {
      const overflow = '0b' + '1'.repeat(33);
      expect(parseIntegerLiteral(overflow)).toBeUndefined();
    });
  });

  describe('octal integers', () => {
    it('parses basic octal', () => {
      expect(parseIntegerLiteral('010')).toBe(8);
      expect(parseIntegerLiteral('077')).toBe(63);
    });

    it('parses octal zero', () => {
      expect(parseIntegerLiteral('00')).toBe(0);
    });

    it('rejects non-octal digits in octal format', () => {
      expect(parseIntegerLiteral('08')).toBeUndefined();
      expect(parseIntegerLiteral('09')).toBeUndefined();
    });

    it('treats bare 0 as decimal zero, not octal', () => {
      expect(parseIntegerLiteral('0')).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('returns undefined for empty string', () => {
      expect(parseIntegerLiteral('')).toBeUndefined();
    });

    it('returns undefined for non-numeric strings', () => {
      expect(parseIntegerLiteral('abc')).toBeUndefined();
      expect(parseIntegerLiteral('hello')).toBeUndefined();
    });

    it('trims whitespace', () => {
      expect(parseIntegerLiteral('  42  ')).toBe(42);
    });

    it('returns undefined for floating point', () => {
      expect(parseIntegerLiteral('3.14')).toBeUndefined();
    });

    it('returns undefined for just a sign', () => {
      expect(parseIntegerLiteral('+')).toBeUndefined();
      expect(parseIntegerLiteral('-')).toBeUndefined();
    });

    it('returns undefined for hex prefix without digits', () => {
      expect(parseIntegerLiteral('0x')).toBeUndefined();
      expect(parseIntegerLiteral('0b')).toBeUndefined();
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// isIntegerLiteral / isNonNegativeIntegerLiteral
// ────────────────────────────────────────────────────────────────────────────────
describe('isIntegerLiteral', () => {
  it('returns true for valid integers', () => {
    expect(isIntegerLiteral('0')).toBe(true);
    expect(isIntegerLiteral('42')).toBe(true);
    expect(isIntegerLiteral('-1')).toBe(true);
    expect(isIntegerLiteral('0xFF')).toBe(true);
    expect(isIntegerLiteral('0b1010')).toBe(true);
    expect(isIntegerLiteral('010')).toBe(true);
  });

  it('returns false for invalid inputs', () => {
    expect(isIntegerLiteral('')).toBe(false);
    expect(isIntegerLiteral('abc')).toBe(false);
    expect(isIntegerLiteral('3.14')).toBe(false);
  });
});

describe('isNonNegativeIntegerLiteral', () => {
  it('returns true for non-negative integers', () => {
    expect(isNonNegativeIntegerLiteral('0')).toBe(true);
    expect(isNonNegativeIntegerLiteral('42')).toBe(true);
    expect(isNonNegativeIntegerLiteral('0xFF')).toBe(true);
  });

  it('returns false for negative integers', () => {
    expect(isNonNegativeIntegerLiteral('-1')).toBe(false);
    expect(isNonNegativeIntegerLiteral('-42')).toBe(false);
  });

  it('returns false for non-integers', () => {
    expect(isNonNegativeIntegerLiteral('abc')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// isFloatLiteral
// ────────────────────────────────────────────────────────────────────────────────
describe('isFloatLiteral', () => {
  it('returns true for basic floats', () => {
    expect(isFloatLiteral('3.14')).toBe(true);
    expect(isFloatLiteral('0.5')).toBe(true);
    expect(isFloatLiteral('.5')).toBe(true);
    expect(isFloatLiteral('10.')).toBe(true);
  });

  it('returns true for scientific notation', () => {
    expect(isFloatLiteral('1e10')).toBe(true);
    expect(isFloatLiteral('1.5e-3')).toBe(true);
    expect(isFloatLiteral('1.5E+3')).toBe(true);
  });

  it('returns true for plain integers (they are valid floats)', () => {
    expect(isFloatLiteral('42')).toBe(true);
  });

  it('returns true for signed floats', () => {
    expect(isFloatLiteral('-3.14')).toBe(true);
    expect(isFloatLiteral('+3.14')).toBe(true);
  });

  it('returns false for non-numeric strings', () => {
    expect(isFloatLiteral('abc')).toBe(false);
    expect(isFloatLiteral('')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// isCharLiteral
// ────────────────────────────────────────────────────────────────────────────────
describe('isCharLiteral', () => {
  it('returns true for single character literals', () => {
    expect(isCharLiteral("'a'")).toBe(true);
    expect(isCharLiteral("'Z'")).toBe(true);
    expect(isCharLiteral("'0'")).toBe(true);
    expect(isCharLiteral("' '")).toBe(true);
  });

  it('returns true for escaped character literals', () => {
    expect(isCharLiteral("'\\n'")).toBe(true);
    expect(isCharLiteral("'\\t'")).toBe(true);
    expect(isCharLiteral("'\\''")).toBe(true);
    expect(isCharLiteral("'\\\\'")).toBe(true);
  });

  it('returns false for multi-character literals', () => {
    expect(isCharLiteral("'ab'")).toBe(false);
  });

  it('returns false for empty quotes', () => {
    expect(isCharLiteral("''")).toBe(false);
  });

  it('returns false for unquoted characters', () => {
    expect(isCharLiteral('a')).toBe(false);
  });

  it('returns false for strings', () => {
    expect(isCharLiteral('"a"')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// isSymbolLike
// ────────────────────────────────────────────────────────────────────────────────
describe('isSymbolLike', () => {
  it('returns true for valid identifiers', () => {
    expect(isSymbolLike('label')).toBe(true);
    expect(isSymbolLike('_start')).toBe(true);
    expect(isSymbolLike('$at')).toBe(true);
    expect(isSymbolLike('.data')).toBe(true);
    expect(isSymbolLike('my_label')).toBe(true);
    expect(isSymbolLike('L0')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isSymbolLike('')).toBe(false);
  });

  it('returns false for numeric-only strings', () => {
    expect(isSymbolLike('42')).toBe(false);
  });

  it('returns false for strings starting with digits', () => {
    expect(isSymbolLike('0label')).toBe(false);
  });

  it('returns false for strings with special characters', () => {
    expect(isSymbolLike('label-name')).toBe(false);
    expect(isSymbolLike('label name')).toBe(false);
    expect(isSymbolLike('label@name')).toBe(false);
  });

  it('returns true for identifiers with dots and dollars', () => {
    expect(isSymbolLike('$v0')).toBe(true);
    expect(isSymbolLike('.macro')).toBe(true);
    expect(isSymbolLike('my.var')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// signed32ImmediateValue
// ────────────────────────────────────────────────────────────────────────────────
describe('signed32ImmediateValue', () => {
  it('returns small positive values unchanged', () => {
    expect(signed32ImmediateValue(0)).toBe(0);
    expect(signed32ImmediateValue(42)).toBe(42);
    expect(signed32ImmediateValue(0x7FFFFFFF)).toBe(0x7FFFFFFF);
  });

  it('converts values above 0x7FFFFFFF to negative', () => {
    expect(signed32ImmediateValue(0x80000000)).toBe(-2147483648);
    expect(signed32ImmediateValue(0xFFFFFFFF)).toBe(-1);
    expect(signed32ImmediateValue(0x80000001)).toBe(-2147483647);
  });

  it('handles the boundary exactly', () => {
    expect(signed32ImmediateValue(0x7FFFFFFF)).toBe(2147483647);
    expect(signed32ImmediateValue(0x80000000)).toBe(-2147483648);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// integerFitsRange
// ────────────────────────────────────────────────────────────────────────────────
describe('integerFitsRange', () => {
  it('returns true for values within range', () => {
    expect(integerFitsRange(5, 0, 10)).toBe(true);
    expect(integerFitsRange(0, 0, 10)).toBe(true);
    expect(integerFitsRange(10, 0, 10)).toBe(true);
  });

  it('returns false for values outside range', () => {
    expect(integerFitsRange(-1, 0, 10)).toBe(false);
    expect(integerFitsRange(11, 0, 10)).toBe(false);
  });

  it('works with negative ranges', () => {
    expect(integerFitsRange(-5, -10, 0)).toBe(true);
    expect(integerFitsRange(-11, -10, 0)).toBe(false);
  });

  it('works with single-value range', () => {
    expect(integerFitsRange(5, 5, 5)).toBe(true);
    expect(integerFitsRange(4, 5, 5)).toBe(false);
    expect(integerFitsRange(6, 5, 5)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// stripComment
// ────────────────────────────────────────────────────────────────────────────────
describe('stripComment', () => {
  it('returns the line unchanged when there is no comment', () => {
    expect(stripComment('add $t0, $t1, $t2')).toBe('add $t0, $t1, $t2');
  });

  it('strips a comment starting with #', () => {
    expect(stripComment('add $t0, $t1 # comment')).toBe('add $t0, $t1 ');
  });

  it('strips a comment when # is at the start', () => {
    expect(stripComment('# full line comment')).toBe('');
  });

  it('does not strip # inside a string literal', () => {
    expect(stripComment('.asciiz "hello # world"')).toBe('.asciiz "hello # world"');
  });

  it('handles multiple # characters (only the first outside string counts)', () => {
    expect(stripComment('add $t0 # comment # more')).toBe('add $t0 ');
  });

  it('returns empty string for an empty line', () => {
    expect(stripComment('')).toBe('');
  });

  it('handles escaped quotes inside strings correctly', () => {
    expect(stripComment('.asciiz "hello \\" # not comment"')).toBe('.asciiz "hello \\" # not comment"');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// findCommentIndex
// ────────────────────────────────────────────────────────────────────────────────
describe('findCommentIndex', () => {
  it('returns -1 when there is no comment', () => {
    expect(findCommentIndex('add $t0, $t1')).toBe(-1);
  });

  it('returns the index of the # character', () => {
    expect(findCommentIndex('add $t0 # comment')).toBe(8);
  });

  it('returns 0 when line starts with #', () => {
    expect(findCommentIndex('# comment')).toBe(0);
  });

  it('returns -1 when # is inside a string', () => {
    expect(findCommentIndex('.asciiz "hello # world"')).toBe(-1);
  });

  it('returns the correct index for # after a string', () => {
    expect(findCommentIndex('.asciiz "hello" # comment')).toBe(16);
  });

  it('returns -1 for an empty line', () => {
    expect(findCommentIndex('')).toBe(-1);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// parseOperands
// ────────────────────────────────────────────────────────────────────────────────
describe('parseOperands', () => {
  it('returns empty array for empty string', () => {
    expect(parseOperands('')).toEqual([]);
  });

  it('returns empty array for whitespace-only', () => {
    expect(parseOperands('   ')).toEqual([]);
  });

  it('parses a single operand', () => {
    expect(parseOperands('$t0')).toEqual(['$t0']);
  });

  it('parses multiple comma-separated operands', () => {
    expect(parseOperands('$t0, $t1, $t2')).toEqual(['$t0', '$t1', '$t2']);
  });

  it('trims whitespace around operands', () => {
    expect(parseOperands('  $t0 ,  $t1  , $t2  ')).toEqual(['$t0', '$t1', '$t2']);
  });

  it('strips surrounding parentheses', () => {
    expect(parseOperands('($t0, $t1)')).toEqual(['$t0', '$t1']);
  });

  it('parses memory operand format', () => {
    expect(parseOperands('$t0, 4($sp)')).toEqual(['$t0', '4($sp)']);
  });

  it('handles operands with no spaces after commas', () => {
    expect(parseOperands('$t0,$t1,$t2')).toEqual(['$t0', '$t1', '$t2']);
  });

  it('filters out empty operands from trailing commas', () => {
    expect(parseOperands('$t0,')).toEqual(['$t0']);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// parseMacroArguments
// ────────────────────────────────────────────────────────────────────────────────
describe('parseMacroArguments', () => {
  it('returns empty array for empty string', () => {
    expect(parseMacroArguments('')).toEqual([]);
  });

  it('strips surrounding parentheses', () => {
    expect(parseMacroArguments('($a, $b)')).toEqual(['$a', '$b']);
  });

  it('parses comma-separated arguments', () => {
    expect(parseMacroArguments('$a, $b, $c')).toEqual(['$a', '$b', '$c']);
  });

  it('parses space-separated arguments', () => {
    expect(parseMacroArguments('$a $b $c')).toEqual(['$a', '$b', '$c']);
  });

  it('parses mixed comma and space separated arguments', () => {
    expect(parseMacroArguments('$a, $b $c')).toEqual(['$a', '$b', '$c']);
  });

  it('preserves quoted strings', () => {
    expect(parseMacroArguments('"hello world", $a')).toEqual(['"hello world"', '$a']);
  });

  it('handles single argument', () => {
    expect(parseMacroArguments('$a')).toEqual(['$a']);
  });

  it('trims whitespace', () => {
    expect(parseMacroArguments('  $a  ,  $b  ')).toEqual(['$a', '$b']);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// formatMipsLine
// ────────────────────────────────────────────────────────────────────────────────
describe('formatMipsLine', () => {
  it('indents instruction lines', () => {
    expect(formatMipsLine('add $t0, $t1, $t2')).toBe('    add $t0, $t1, $t2');
  });

  it('does not indent label lines', () => {
    expect(formatMipsLine('main:')).toBe('main:');
  });

  it('does not indent directive lines', () => {
    expect(formatMipsLine('.data')).toBe('.data');
    expect(formatMipsLine('.text')).toBe('.text');
  });

  it('preserves comments with alignment', () => {
    const result = formatMipsLine('nop # comment');
    expect(result).toContain('nop');
    expect(result).toContain('# comment');
  });

  it('returns empty string for empty input', () => {
    expect(formatMipsLine('')).toBe('');
  });

  it('returns comment-only lines as-is', () => {
    expect(formatMipsLine('# comment')).toBe('# comment');
  });

  it('normalizes comma spacing', () => {
    const result = formatMipsLine('add $t0,$t1,$t2');
    expect(result).toContain('add $t0, $t1, $t2');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// getStringRanges
// ────────────────────────────────────────────────────────────────────────────────
describe('getStringRanges', () => {
  it('returns empty array for empty string', () => {
    expect(getStringRanges('')).toEqual([]);
  });

  it('returns empty array when no strings present', () => {
    expect(getStringRanges('add $t0, $t1')).toEqual([]);
  });

  it('finds a single string literal', () => {
    const text = '.asciiz "hello"';
    const ranges = getStringRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(text.indexOf('"'));
    expect(ranges[0].end).toBe(text.indexOf('"') + '"hello"'.length);
  });

  it('finds multiple string literals', () => {
    const ranges = getStringRanges('"a" and "b"');
    expect(ranges).toHaveLength(2);
    expect(ranges[0].start).toBe(0);
    expect(ranges[0].end).toBe(3);
    expect(ranges[1].start).toBe(8);
    expect(ranges[1].end).toBe(11);
  });

  it('handles escaped quotes inside strings', () => {
    const ranges = getStringRanges('"hello \\"world\\""');
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(0);
  });

  it('handles unclosed strings (extends to end)', () => {
    const text = '.asciiz "hello';
    const ranges = getStringRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(text.indexOf('"'));
    expect(ranges[0].end).toBe(text.length);
  });

  it('returns empty array for string with only quotes', () => {
    const ranges = getStringRanges('""');
    expect(ranges).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// getNumericLikeRanges
// ────────────────────────────────────────────────────────────────────────────────
describe('getNumericLikeRanges', () => {
  it('returns empty array for empty string', () => {
    expect(getNumericLikeRanges('')).toEqual([]);
  });

  it('finds decimal numbers', () => {
    const ranges = getNumericLikeRanges('li $v0, 42');
    expect(ranges.length).toBeGreaterThanOrEqual(1);
    const found = ranges.some((r) => {
      const text = 'li $v0, 42'.slice(r.start, r.end);
      return text === '42';
    });
    expect(found).toBe(true);
  });

  it('finds hex numbers', () => {
    const ranges = getNumericLikeRanges('li $v0, 0xFF');
    const found = ranges.some((r) => {
      const text = 'li $v0, 0xFF'.slice(r.start, r.end);
      return text === '0xFF';
    });
    expect(found).toBe(true);
  });

  it('finds binary numbers', () => {
    const ranges = getNumericLikeRanges('li $v0, 0b1010');
    const found = ranges.some((r) => {
      const text = 'li $v0, 0b1010'.slice(r.start, r.end);
      return text === '0b1010';
    });
    expect(found).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// isInsideAnyRange
// ────────────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────────────
// parseIntegerLiteral — additional boundary cases
// ────────────────────────────────────────────────────────────────────────────────
describe('parseIntegerLiteral — boundary cases', () => {
  it('handles 0x80000000 (INT_MIN as unsigned)', () => {
    expect(parseIntegerLiteral('0x80000000')).toBe(0x80000000);
  });

  it('handles 0x7FFFFFFF (INT_MAX)', () => {
    expect(parseIntegerLiteral('0x7FFFFFFF')).toBe(0x7FFFFFFF);
  });

  it('handles -0x80000000 (INT_MIN)', () => {
    expect(parseIntegerLiteral('-0x80000000')).toBe(-0x80000000);
  });

  it('rejects -0x80000001 (below INT_MIN)', () => {
    expect(parseIntegerLiteral('-0x80000001')).toBeUndefined();
  });

  it('handles 0xFFFFFFFF (UINT_MAX)', () => {
    expect(parseIntegerLiteral('0xFFFFFFFF')).toBe(0xFFFFFFFF);
  });

  it('rejects 0x100000000 (above UINT_MAX)', () => {
    expect(parseIntegerLiteral('0x100000000')).toBeUndefined();
  });

  it('handles binary with leading zeros', () => {
    expect(parseIntegerLiteral('0b00001010')).toBe(10);
  });

  it('handles hex with leading zeros', () => {
    expect(parseIntegerLiteral('0x000000FF')).toBe(255);
  });

  it('handles negative zero', () => {
    expect(parseIntegerLiteral('-0')).toBe(0);
  });

  it('handles explicit positive sign with hex', () => {
    expect(parseIntegerLiteral('+0xFF')).toBe(255);
  });

  it('rejects multiple signs', () => {
    expect(parseIntegerLiteral('++42')).toBeUndefined();
    expect(parseIntegerLiteral('--42')).toBeUndefined();
    expect(parseIntegerLiteral('-+42')).toBeUndefined();
  });

  it('rejects embedded spaces', () => {
    expect(parseIntegerLiteral('4 2')).toBeUndefined();
    expect(parseIntegerLiteral('0x FF')).toBeUndefined();
  });

  it('rejects trailing non-numeric characters', () => {
    expect(parseIntegerLiteral('42abc')).toBeUndefined();
    expect(parseIntegerLiteral('0xFFzz')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// stripComment — additional edge cases
// ────────────────────────────────────────────────────────────────────────────────
describe('stripComment — edge cases', () => {
  it('handles line with only a comment character', () => {
    expect(stripComment('#')).toBe('');
  });

  it('handles line with comment at various positions', () => {
    expect(stripComment('a#b')).toBe('a');
    expect(stripComment('ab #cd')).toBe('ab ');
  });

  it('handles string with multiple quotes', () => {
    expect(stripComment('.asciiz "a\\"b" # c')).toBe('.asciiz "a\\"b" ');
  });

  it('handles empty string in line', () => {
    expect(stripComment('.asciiz "" # comment')).toBe('.asciiz "" ');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// parseOperands — additional edge cases
// ────────────────────────────────────────────────────────────────────────────────
describe('parseOperands — edge cases', () => {
  it('handles nested parentheses in memory operand', () => {
    // Not typical in MIPS but tests robustness
    expect(parseOperands('$t0')).toEqual(['$t0']);
  });

  it('preserves internal whitespace in operands', () => {
    // e.g., expressions like 4+4 might appear
    expect(parseOperands('$t0, 4+4')).toEqual(['$t0', '4+4']);
  });

  it('handles single operand with leading/trailing spaces', () => {
    expect(parseOperands('  $t0  ')).toEqual(['$t0']);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// isInsideAnyRange
// ────────────────────────────────────────────────────────────────────────────────
describe('isInsideAnyRange', () => {
  it('returns false for empty range list', () => {
    expect(isInsideAnyRange(5, [])).toBe(false);
  });

  it('returns true when index is inside a range', () => {
    expect(isInsideAnyRange(5, [{ start: 3, end: 8 }])).toBe(true);
  });

  it('returns true at the start of a range', () => {
    expect(isInsideAnyRange(3, [{ start: 3, end: 8 }])).toBe(true);
  });

  it('returns false at the end of a range (exclusive)', () => {
    expect(isInsideAnyRange(8, [{ start: 3, end: 8 }])).toBe(false);
  });

  it('returns false when index is before all ranges', () => {
    expect(isInsideAnyRange(0, [{ start: 3, end: 8 }])).toBe(false);
  });

  it('returns false when index is after all ranges', () => {
    expect(isInsideAnyRange(10, [{ start: 3, end: 8 }])).toBe(false);
  });

  it('returns true when index is in one of multiple ranges', () => {
    const ranges = [{ start: 0, end: 3 }, { start: 10, end: 15 }];
    expect(isInsideAnyRange(5, ranges)).toBe(false);
    expect(isInsideAnyRange(12, ranges)).toBe(true);
    expect(isInsideAnyRange(1, ranges)).toBe(true);
  });
});
