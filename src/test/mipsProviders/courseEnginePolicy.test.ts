import { describe, expect, it } from 'vitest';

import {
  BUILTIN_TS_ENGINE_ID,
  courseEnginePlanProfileError,
  resolveCourseEnginePlan
} from '../../mips/providers/courseEnginePolicy';

describe('phase-6 course engine policy', () => {
  it('rejects a plan reused with a different case profile', () => {
    const plan = resolveCourseEnginePlan('auto', 'P3');
    expect(courseEnginePlanProfileError(plan, 'P3')).toBeUndefined();
    expect(courseEnginePlanProfileError(plan, 'P4')).toMatch(/P3.*P4/);
  });

  it('uses the internal engine outside course profiles in auto mode', () => {
    for (const profile of ['P2', 'P1', 'auto', undefined]) {
      expect(resolveCourseEnginePlan('auto', profile).primaryEngineId).toBe(BUILTIN_TS_ENGINE_ID);
    }
  });

  it('selects builtin atomically for every gated P3-P7 profile', () => {
    for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7']) {
      const plan = resolveCourseEnginePlan('auto', profile);
      expect(plan.primaryEngineId).toBe(BUILTIN_TS_ENGINE_ID);
      expect(plan.verificationEngineId).toBeUndefined();
      expect(Object.isFrozen(plan)).toBe(true);
    }
  });

  it.each([
    { deterministicConsole: true },
    { interactiveConsole: true },
    { deterministicConsole: true, interactiveConsole: true }
  ])('keeps course console requests on builtin for capability validation: %o', (capabilities) => {
    expect(resolveCourseEnginePlan('auto', 'P7', capabilities).primaryEngineId)
      .toBe(BUILTIN_TS_ENGINE_ID);
  });

  it('migrates fork modes without starting a verification lane', () => {
    expect(resolveCourseEnginePlan('builtin', 'P2', { interactiveConsole: true }))
      .toMatchObject({ primaryEngineId: BUILTIN_TS_ENGINE_ID });
    expect(resolveCourseEnginePlan('mars', 'P7'))
      .toMatchObject({ mode: 'auto', primaryEngineId: BUILTIN_TS_ENGINE_ID });
    expect(resolveCourseEnginePlan('verify-both', 'P2', { deterministicConsole: true }))
      .toMatchObject({
        mode: 'auto', primaryEngineId: BUILTIN_TS_ENGINE_ID
      });
    for (const mode of ['mars', 'verify-both'] as const) {
      for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7']) {
        expect(resolveCourseEnginePlan(mode, profile)).toMatchObject({ mode: 'auto', primaryEngineId: BUILTIN_TS_ENGINE_ID });
        expect(resolveCourseEnginePlan(mode, profile).verificationEngineId).toBeUndefined();
      }
    }
  });
});
