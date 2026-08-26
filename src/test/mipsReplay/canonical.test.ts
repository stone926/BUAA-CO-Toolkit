import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Canonical, type CanonicalJson } from '../../mips/replay/canonical';

describe('canonical replay JSON', () => {
  it('retains an own __proto__ key instead of invoking the prototype setter', () => {
    const withProto = Object.create(null) as Record<string, CanonicalJson>;
    withProto.safe = 1;
    withProto.__proto__ = { injected: true };

    expect(canonicalJson(withProto)).toBe('{"__proto__":{"injected":true},"safe":1}');
    expect(sha256Canonical(withProto)).not.toBe(sha256Canonical({ safe: 1 }));
  });

  it('sorts dangerous and ordinary keys deterministically at every depth', () => {
    const value = JSON.parse('{"z":0,"nested":{"constructor":2,"__proto__":1,"a":3}}') as CanonicalJson;
    expect(canonicalJson(value)).toBe('{"nested":{"__proto__":1,"a":3,"constructor":2},"z":0}');
  });
});
