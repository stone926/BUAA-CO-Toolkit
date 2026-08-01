import { describe, expect, it } from 'vitest';
import {
  courseDataDumpChunkWordCount,
  courseDataDumpChunks,
  courseDataInitializationError
} from '../../courseTesting/courseDataInitialization';

const zeroChunk = `${'00000000\n'.repeat(courseDataDumpChunkWordCount)}`;

describe('course data-memory initialization preflight', () => {
  it('locks modified-MARS chunk boundaries to every course DM word exactly once', () => {
    expect(courseDataDumpChunks).toEqual([
      expect.objectContaining({ startAddress: 0x0000, endAddressExclusive: 0x1000, marsRange: '0x00000000-0x00001000' }),
      expect.objectContaining({ startAddress: 0x1000, endAddressExclusive: 0x2000, marsRange: '0x00001000-0x00002000' }),
      expect.objectContaining({ startAddress: 0x2000, endAddressExclusive: 0x3000, marsRange: '0x00002000-0x00003000' })
    ]);
    expect(courseDataDumpChunks.flatMap((chunk) =>
      Array.from({ length: courseDataDumpChunkWordCount }, (_, index) => chunk.startAddress + index * 4)
    )).toEqual(Array.from({ length: 3072 }, (_, index) => index * 4));
  });

  it('accepts fully allocated zero .space and wholly unallocated blocks', () => {
    expect(courseDataInitializationError([zeroChunk, zeroChunk, zeroChunk])).toBeUndefined();
    expect(courseDataInitializationError(['', '', ''])).toBeUndefined();
    expect(courseDataInitializationError(['', zeroChunk, ''])).toBeUndefined();
  });

  it('reports the first nonzero word with its exact course DM address', () => {
    const middle = zeroChunk.split('\n');
    middle[64] = '12345678';
    const later = zeroChunk.split('\n');
    later[0] = 'deadbeef';

    const error = courseDataInitializationError(['', middle.join('\n'), later.join('\n')]);

    expect(error).toContain('0x00001100');
    expect(error).toContain('0x12345678');
    expect(error).toContain('P3–P7 硬件 DM 复位初态全为零');
    expect(error).not.toContain('0xdeadbeef');
  });

  it('rejects truncated, overlong, blank-line, prefixed, and non-hex dumps', () => {
    const malformed = [
      `${'00000000\n'.repeat(courseDataDumpChunkWordCount - 1)}`,
      `${zeroChunk}00000000\n`,
      zeroChunk.replace('00000000\n00000000', '00000000\n\n00000000'),
      zeroChunk.replace('00000000', '0x000000'),
      zeroChunk.replace('00000000', 'xxxxxxxx')
    ];

    for (const text of malformed) {
      expect(courseDataInitializationError([text, '', ''])).toContain('dump 格式异常');
    }
  });

  it('rejects a missing chunk result instead of silently assuming zero', () => {
    expect(courseDataInitializationError(['', ''])).toContain('应有 3 个');
  });
});
