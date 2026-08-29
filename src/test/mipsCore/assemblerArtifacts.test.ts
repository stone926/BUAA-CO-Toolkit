import { describe, expect, it } from 'vitest';
import type { ProgramImage, ProgramSegment } from '../../mips/core/api';
import {
  courseInstructionImageBaseAddress,
  courseInstructionImageHexText,
  courseInstructionImageWordCapacity,
  courseInstructionImageWords
} from '../../mips/core/assembler/artifacts';

function image(segments: readonly ProgramSegment[]): ProgramImage {
  return {
    formatVersion: 1,
    fingerprint: '0'.repeat(64),
    entryPc: courseInstructionImageBaseAddress,
    segments,
    symbols: [],
    sourceMap: [],
    inputGraph: [{ id: 'root', contentHash: '1'.repeat(64) }]
  };
}

describe('course instruction-image projection', () => {
  it('keeps a contiguous P3-P6 text image unchanged and ignores data memory', () => {
    const program = image([
      { name: 'data', baseAddress: 0, words: [0x11223344] },
      { name: 'text', baseAddress: 0x3000, words: [0x34080001, 0x1000ffff, 0] },
      { name: 'ktext', baseAddress: 0x4180, words: [] }
    ]);

    expect(courseInstructionImageWords(program)).toEqual([0x34080001, 0x1000ffff, 0]);
    expect(courseInstructionImageHexText(program)).toBe('34080001\n1000ffff\n00000000\n');
  });

  it('places P7 ktext at 0x4180 and zero-fills the user/kernel gap', () => {
    const handlerIndex = (0x4180 - courseInstructionImageBaseAddress) / 4;
    const program = image([
      { name: 'text', baseAddress: 0x3000, words: [0x1000ffff, 0] },
      { name: 'ktext', baseAddress: 0x4180, words: [0x401a6800, 0x42000018] }
    ]);

    const words = courseInstructionImageWords(program);
    expect(words).toHaveLength(handlerIndex + 2);
    expect(words.slice(0, 2)).toEqual([0x1000ffff, 0]);
    expect(words[2]).toBe(0);
    expect(words[handlerIndex - 1]).toBe(0);
    expect(words.slice(handlerIndex)).toEqual([0x401a6800, 0x42000018]);
  });

  it('rejects unaligned, overlapping, and out-of-range instruction segments', () => {
    expect(() => courseInstructionImageWords(image([
      { name: 'text', baseAddress: 0x3002, words: [0] }
    ]))).toThrow(/word-aligned/);

    expect(() => courseInstructionImageWords(image([
      { name: 'text', baseAddress: 0x3000, words: [1, 2] },
      { name: 'ktext', baseAddress: 0x3004, words: [3] }
    ]))).toThrow(/overlap.*0x00003004/);

    expect(() => courseInstructionImageWords(image([
      { name: 'text', baseAddress: 0x2ffc, words: [0] }
    ]))).toThrow(/starts outside/);

    expect(() => courseInstructionImageWords(image([
      { name: 'text', baseAddress: 0x6ffc, words: [0, 0] }
    ]))).toThrow(/extends outside/);
  });

  it('accepts all 4096 hardware words and rejects a 4097th word', () => {
    expect(courseInstructionImageWords(image([{
      name: 'text', baseAddress: 0x3000,
      words: new Array(courseInstructionImageWordCapacity).fill(0)
    }]))).toHaveLength(4096);

    expect(() => courseInstructionImageWords(image([{
      name: 'text', baseAddress: 0x3000,
      words: new Array(courseInstructionImageWordCapacity + 1).fill(0)
    }]))).toThrow(/extends outside/);
  });
});
