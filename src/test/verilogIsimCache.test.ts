import { describe, expect, it } from 'vitest';
import {
  createIsimCompileCache,
  isimCompileArtifactStem,
  isimCompileCacheKey
} from '../verilogIsimCache';

describe('Verilog ISim compile cache helpers', () => {
  it('normalizes paths when building cache keys', () => {
    const left = isimCompileCacheKey({
      workspaceRoot: 'E:\\work\\cpu',
      isePath: 'D:\\ISE\\fuse.exe',
      moduleName: 'mips_tb',
      testbenchKind: 'generated',
      testbenchSource: 'E:\\work\\cpu\\.co\\isim\\tb.v',
      testbenchSha256: 'abc',
      projectSignature: 'files',
      tclText: 'run 200us;\nexit\n',
      debug: false
    });
    const right = isimCompileCacheKey({
      workspaceRoot: 'E:/work/cpu',
      isePath: 'D:/ISE/fuse.exe',
      moduleName: 'mips_tb',
      testbenchKind: 'generated',
      testbenchSource: 'E:/work/cpu/.co/isim/tb.v',
      testbenchSha256: 'abc',
      projectSignature: 'files',
      tclText: 'run 200us;\nexit\n',
      debug: false
    });
    expect(left).toBe(right);
  });

  it('uses a stable safe artifact stem per cache key', () => {
    const key = isimCompileCacheKey({
      isePath: 'fuse',
      moduleName: 'cpu tb',
      testbenchKind: 'user',
      projectSignature: 'a.v:1:2',
      tclText: 'run 200us;\nexit\n',
      debug: false
    });
    expect(isimCompileArtifactStem('cpu tb', key)).toMatch(/^cpu_tb_[0-9a-f]{12}$/);
    expect(isimCompileArtifactStem('cpu tb', `${key}!`)).not.toBe(isimCompileArtifactStem('cpu tb', key));
  });

  it('creates an isolated mutable cache', () => {
    const cache = createIsimCompileCache();
    cache.set('a', { ok: true });
    expect(cache.get('a')).toEqual({ ok: true });
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });
});
