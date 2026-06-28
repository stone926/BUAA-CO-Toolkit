import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  dedupePaths,
  dedupeUris,
  samePath,
  sanitizeFileStem
} from '../pathUtils';

describe('path utilities', () => {
  it('compares normalized filesystem paths', () => {
    expect(samePath(path.join('root', 'out', '..', 'code.txt'), path.join('root', 'code.txt'))).toBe(true);
  });

  it('deduplicates paths and Uri-like objects while preserving first entries', () => {
    expect(dedupePaths([
      path.join('root', 'a.v'),
      path.join('root', 'sub', '..', 'a.v'),
      path.join('root', 'b.v')
    ])).toEqual([
      path.join('root', 'a.v'),
      path.join('root', 'b.v')
    ]);

    const first = { fsPath: path.join('root', 'a.v'), tag: 1 };
    const duplicate = { fsPath: path.join('root', 'sub', '..', 'a.v'), tag: 2 };
    const second = { fsPath: path.join('root', 'b.v'), tag: 3 };
    expect(dedupeUris([first, duplicate, second])).toEqual([first, second]);
  });

  it('sanitizes file stems with explicit fallback behavior', () => {
    expect(sanitizeFileStem('p3/generated case #1.asm', { stripExtension: true })).toBe('p3_generated_case_1');
    expect(sanitizeFileStem('***', { fallback: 'stdin', trimOuterUnderscores: false })).toBe('_');
    expect(sanitizeFileStem('***', { fallback: 'case' })).toBe('case');
  });
});
