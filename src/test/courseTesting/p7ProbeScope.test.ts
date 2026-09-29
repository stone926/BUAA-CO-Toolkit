import { describe, expect, it } from 'vitest';
import { probeScope, probeScopeFromCase } from '../../courseTesting/p7ProbeScope';

describe('P7 probe evidence scope', () => {
  it('recognizes historical mixed Timer cases without a scope field', () => {
    expect(probeScope({ scenarios: [
      { kind: 'external', variant: 'mdu-retry-div' },
      { kind: 'timer0', variant: 'hazard-load-jr' }
    ] })).toBe('special-timer-exl');
    expect(probeScope({ scenarios: [{ kind: 'timer1', variant: 'mode1-repeat' }] })).toBe('standard');
    expect(probeScope({ scenarios: [{ kind: 'external', variant: 'mdu-retry-div' }] })).toBe('standard');
  });

  it('retains scope when a tool fails before probe metadata can be checked', () => {
    expect(probeScopeFromCase(undefined, { 'source.probeScope': 'special-timer-exl' }))
      .toBe('special-timer-exl');
  });

  it('does not crash while inspecting incomplete historical scenario entries', () => {
    expect(() => probeScope({ scenarios: [null, undefined, { kind: 'external' }] })).not.toThrow();
  });
});
