import { describe, expect, it } from 'vitest';
import { addSigned32WithOverflow, subSigned32WithOverflow } from '../../mips/core/values';

describe('MIPS fixed-width arithmetic helpers', () => {
  it('detects subtraction overflow when the right operand is INT_MIN', () => {
    expect(subSigned32WithOverflow(0, 0x80000000)).toEqual({
      result: 0x80000000,
      overflow: true
    });
    expect(subSigned32WithOverflow(0x7fffffff, 0xffffffff)).toEqual({
      result: 0x80000000,
      overflow: true
    });
    expect(subSigned32WithOverflow(0x80000000, 1)).toEqual({
      result: 0x7fffffff,
      overflow: true
    });
  });

  it('keeps non-overflowing add/sub results exact at signed boundaries', () => {
    expect(subSigned32WithOverflow(0x80000000, 0xffffffff)).toEqual({
      result: 0x80000001,
      overflow: false
    });
    expect(addSigned32WithOverflow(0x7ffffffe, 1)).toEqual({
      result: 0x7fffffff,
      overflow: false
    });
  });
});
