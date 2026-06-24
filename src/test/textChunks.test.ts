import { describe, expect, it } from 'vitest';
import { LineChunkScanner, TextChunkAccumulator } from '../textChunks';

describe('text chunk helpers', () => {
  it('joins appended chunks on demand', () => {
    const text = new TextChunkAccumulator();
    text.append('abc');
    text.append('');
    text.append('def');
    expect(text.toString()).toBe('abcdef');
  });

  it('scans newline-delimited text across chunk boundaries', () => {
    const lines: string[] = [];
    const scanner = new LineChunkScanner((line) => lines.push(line));
    scanner.append('first\r');
    scanner.append('\nsecond\n\n');
    scanner.append('tail');
    expect(lines).toEqual(['first', 'second', '']);
    scanner.flush();
    expect(lines).toEqual(['first', 'second', '', 'tail']);
  });
});
