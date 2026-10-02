import { describe, expect, it } from 'vitest';
import { getEffectiveRequiredTools } from '../toolchainPolicy';

describe('course toolchain policy', () => {
  it.each(['auto', 'builtin', 'mars', 'verify-both'] as const)(
    '%s keeps every course path independent of MARS', (mode) => {
      for (const profile of ['P4', 'P5', 'P6', 'P7'] as const) {
        expect(getEffectiveRequiredTools(profile, mode)).toEqual(['verilogSimulator']);
      }
      expect(getEffectiveRequiredTools('P3', mode)).toEqual(['logisim', 'java']);
    }
  );

  it('keeps P2 independent of external MIPS tools and preserves Logisim dependencies', () => {
    for (const mode of ['auto', 'builtin', 'mars', 'verify-both'] as const) {
      expect(getEffectiveRequiredTools('P2', mode)).toEqual([]);
      expect(getEffectiveRequiredTools('P1', mode)).toEqual(['verilogSimulator']);
      expect(getEffectiveRequiredTools('P0', mode)).toEqual(['logisim', 'java']);
      expect(getEffectiveRequiredTools('P3', mode)).toEqual(['logisim', 'java']);
    }
  });
});
