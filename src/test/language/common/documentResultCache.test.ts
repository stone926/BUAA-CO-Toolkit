import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentResultCache } from '../../../language/common/documentResultCache';

describe('DocumentResultCache', () => {
  it('reuses exact content across versions without retaining stale generations', () => {
    const cache = new DocumentResultCache<object>();
    let creates = 0;
    const get = (version: number, text: string): object => cache.getOrCreate(
      TextDocument.create('test://cache/current.v', 'verilog', version, text),
      'parse',
      () => ({ generation: ++creates })
    );

    const first = get(1, 'module A; endmodule');
    expect(get(2, 'module A; endmodule')).toBe(first);

    const second = get(3, 'module B; endmodule');
    expect(second).not.toBe(first);
    expect(get(4, 'module B; endmodule')).toBe(second);

    expect(get(5, 'module A; endmodule')).not.toBe(first);
    expect(creates).toBe(3);
  });

  it('keeps independent discriminators for the same document', () => {
    const cache = new DocumentResultCache<object>();
    const document = TextDocument.create('test://cache/current.asm', 'mipsasm', 1, 'nop');
    const syntax = cache.getOrCreate(document, 'syntax', () => ({ kind: 'syntax' }));
    const semantic = cache.getOrCreate(document, 'semantic', () => ({ kind: 'semantic' }));

    expect(semantic).not.toBe(syntax);
    expect(cache.getOrCreate(document, 'syntax', () => ({}))).toBe(syntax);
    expect(cache.getOrCreate(document, 'semantic', () => ({}))).toBe(semantic);
  });
});
