import { describe, expect, it } from 'vitest';

import { getEffectiveRequiredTools, includesLegacyMarsLane } from '../toolchainPolicy';

describe('mode-aware toolchain policy', () => {
  it.each(['auto', 'builtin'] as const)('%s keeps P4-P7 on builtin-only course dependencies', (mode) => {
    for (const profile of ['P4', 'P5', 'P6', 'P7'] as const) {
      expect(getEffectiveRequiredTools(profile, mode)).toEqual(['verilogSimulator']);
    }
    expect(includesLegacyMarsLane(mode)).toBe(false);
  });

  it.each(['mars', 'verify-both'] as const)('%s appends the profile-specific legacy lane for P4-P7', (mode) => {
    for (const profile of ['P4', 'P5', 'P6'] as const) {
      expect(getEffectiveRequiredTools(profile, mode)).toEqual(['verilogSimulator', 'java', 'mars']);
    }
    expect(getEffectiveRequiredTools('P7', mode)).toEqual(['verilogSimulator', 'java', 'marsP7']);
    expect(includesLegacyMarsLane(mode)).toBe(true);
  });

  it('keeps P3 Logisim and Java unconditional while adding MARS only for legacy modes', () => {
    expect(getEffectiveRequiredTools('P3', 'auto')).toEqual(['logisim', 'java']);
    expect(getEffectiveRequiredTools('P3', 'builtin')).toEqual(['logisim', 'java']);
    expect(getEffectiveRequiredTools('P3', 'mars')).toEqual(['logisim', 'java', 'mars']);
    expect(getEffectiveRequiredTools('P3', 'verify-both')).toEqual(['logisim', 'java', 'mars']);
  });

  it('does not let the P3-P7 engine setting rewrite P2 or earlier profile dependencies', () => {
    for (const mode of ['auto', 'builtin', 'mars', 'verify-both'] as const) {
      expect(getEffectiveRequiredTools('P2', mode)).toEqual(['mars', 'java']);
      expect(getEffectiveRequiredTools('P1', mode)).toEqual(['verilogSimulator']);
      expect(getEffectiveRequiredTools('P0', mode)).toEqual(['logisim', 'java']);
    }
  });
});
