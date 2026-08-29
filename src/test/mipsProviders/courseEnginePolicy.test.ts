import { describe, expect, it } from 'vitest';

import {
  BUILTIN_TS_ENGINE_ID,
  courseEnginePlanProfileError,
  LEGACY_MARS_ENGINE_ID,
  resolveCourseEnginePlan
} from '../../mips/providers/courseEnginePolicy';

describe('phase-6 course engine policy', () => {
  it('rejects a plan reused with a different case profile', () => {
    const plan = resolveCourseEnginePlan('auto', 'P3');
    expect(courseEnginePlanProfileError(plan, 'P3')).toBeUndefined();
    expect(courseEnginePlanProfileError(plan, 'P4')).toMatch(/P3.*P4/);
  });

  it('keeps P2 and unknown profiles on legacy in auto mode', () => {
    for (const profile of ['P2', 'P1', 'auto', undefined]) {
      expect(resolveCourseEnginePlan('auto', profile).primaryEngineId).toBe(LEGACY_MARS_ENGINE_ID);
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
  ])('keeps an auto full-stack console request on legacy: %o', (capabilities) => {
    expect(resolveCourseEnginePlan('auto', 'P7', capabilities).primaryEngineId)
      .toBe(LEGACY_MARS_ENGINE_ID);
  });

  it('never rewrites explicit builtin, mars or verify-both modes', () => {
    expect(resolveCourseEnginePlan('builtin', 'P2', { interactiveConsole: true }))
      .toMatchObject({ primaryEngineId: BUILTIN_TS_ENGINE_ID });
    expect(resolveCourseEnginePlan('mars', 'P7'))
      .toMatchObject({ primaryEngineId: LEGACY_MARS_ENGINE_ID });
    expect(resolveCourseEnginePlan('verify-both', 'P2', { deterministicConsole: true }))
      .toMatchObject({
        primaryEngineId: BUILTIN_TS_ENGINE_ID,
        verificationEngineId: LEGACY_MARS_ENGINE_ID
      });
  });
});
