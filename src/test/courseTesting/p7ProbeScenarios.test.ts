import { describe, expect, it } from 'vitest';
import { planProbeScenarioKinds } from '../../courseTesting/builtinAsm/p7/probeScenarios';
import { probeVariantsFor } from '../../courseTesting/builtinAsm/p7/probeVariants';
import { Random, hashSeed } from '../../courseTesting/random';

const allRequiredKinds = new Set([
  'external', 'timer0', 'timer1', 'adel', 'ades', 'syscall', 'ri', 'ov'
]);

describe('P7 probe scenario planning', () => {
  it('includes every enabled category whenever the requested count can hold them', () => {
    for (let seed = 0; seed < 64; seed++) {
      const kinds = planProbeScenarioKinds({
        count: allRequiredKinds.size,
        externalInterrupt: true,
        timerInterrupt: true,
        externalIntensity: 0.01,
        timerIntensity: 0.01,
        exceptionTypes: ['AdEL', 'AdES', 'Syscall', 'RI', 'Ov']
      }, new Random(hashSeed(`required-kinds-${seed}`)));

      expect(new Set(kinds)).toEqual(allRequiredKinds);
    }
  });

  it('reserves enough default-plan occurrences to rotate through every explicit variant', () => {
    for (let seed = 0; seed < 64; seed++) {
      const kinds = planProbeScenarioKinds({
        count: 64,
        externalInterrupt: true,
        timerInterrupt: true,
        externalIntensity: 0.25,
        timerIntensity: 0.2,
        exceptionTypes: ['AdEL', 'AdES', 'Syscall', 'RI', 'Ov']
      }, new Random(hashSeed(`variant-coverage-${seed}`)));

      for (const kind of ['external', 'timer0', 'timer1', 'adel', 'ades', 'syscall', 'ri', 'ov'] as const) {
        expect(kinds.filter((candidate) => candidate === kind).length)
          .toBeGreaterThanOrEqual(probeVariantsFor(kind).length);
      }
    }
  });

  it('partitions core and timer coverage without losing any shard variant', () => {
    const common = {
      externalInterrupt: true,
      timerInterrupt: true,
      externalIntensity: 1,
      timerIntensity: 1,
      exceptionTypes: ['AdEL', 'AdES', 'Syscall', 'RI', 'Ov']
    } as const;
    const core = planProbeScenarioKinds({
      ...common,
      count: 64,
      shard: 'core'
    }, new Random(hashSeed('core-shard')));
    const timer = planProbeScenarioKinds({
      ...common,
      count: 10,
      shard: 'timer'
    }, new Random(hashSeed('timer-shard')));

    expect(core).not.toContain('timer0');
    expect(core).not.toContain('timer1');
    expect(new Set(timer)).toEqual(new Set(['timer0', 'timer1']));
    for (const kind of ['external', 'adel', 'ades', 'syscall', 'ri', 'ov'] as const) {
      expect(core.filter((candidate) => candidate === kind).length).toBeGreaterThanOrEqual(probeVariantsFor(kind).length);
    }
    expect(core.filter((candidate) => candidate === 'ri').length).toBe(probeVariantsFor('ri').length + 12);
    for (const kind of ['timer0', 'timer1'] as const) {
      expect(timer.filter((candidate) => candidate === kind).length).toBe(probeVariantsFor(kind).length);
    }
  });
});
