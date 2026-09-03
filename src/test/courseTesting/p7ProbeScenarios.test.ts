import { describe, expect, it } from 'vitest';
import { planProbeScenarioKinds } from '../../courseTesting/builtinAsm/p7/probeScenarios';
import { automaticProbeShards, probeVariantsFor } from '../../courseTesting/builtinAsm/p7/probeVariants';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import {
  p7ExceptionHandlerAddress,
  p7ProbeLogBase,
  p7ProbeMaxScenarioCount,
  p7ProbeRecordWords,
  p7UserTextBaseAddress
} from '../../courseTesting/p7Hardware';
import { Random, hashSeed } from '../../courseTesting/random';

const requiredKinds = [
  'external', 'timer0', 'timer1', 'adel', 'ades', 'syscall', 'ri', 'ov'
] as const;
const allRequiredKinds = new Set(requiredKinds);
const shardScenarioCounts = { core: 64, mmio: 26, timer: 10, priority: 14, mdu: 18 } as const;
const enabledSources = {
  externalInterrupt: true,
  timerInterrupt: true,
  externalIntensity: 1,
  timerIntensity: 1,
  exceptionTypes: ['AdEL', 'AdES', 'Syscall', 'RI', 'Ov']
} as const;

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

  it('reserves every explicit variant within its automatic shard before adding filler', () => {
    for (let seed = 0; seed < 64; seed++) {
      for (const shard of automaticProbeShards) {
        const kinds = planProbeScenarioKinds({
          ...enabledSources,
          count: shardScenarioCounts[shard],
          shard
        }, new Random(hashSeed(`variant-coverage-${seed}-${shard}`)));
        for (const kind of requiredKinds) {
          const required = probeVariantsFor(kind, shard).length;
          const count = kinds.filter((candidate) => candidate === kind).length;
          if (shard === 'core' && kind === 'ri') {
            expect(count).toBeGreaterThanOrEqual(required);
          } else {
            expect(count, `${seed}/${shard}/${kind}`).toBe(required);
          }
        }
      }
    }
  });

  it('assigns each registered kind/variant to exactly one of the five automatic shards', () => {
    expect(automaticProbeShards).toEqual(['core', 'mmio', 'timer', 'priority', 'mdu']);
    const registered = requiredKinds.flatMap((kind) => probeVariantsFor(kind).map((variant) => `${kind}/${variant}`));
    const assigned = automaticProbeShards.flatMap((shard) => requiredKinds.flatMap((kind) =>
      probeVariantsFor(kind, shard).map((variant) => `${kind}/${variant}`)));
    expect(new Set(assigned)).toEqual(new Set(registered));
    expect(assigned).toHaveLength(new Set(assigned).size);
    for (const shard of automaticProbeShards) {
      const minimum = requiredKinds.reduce((sum, kind) => sum + probeVariantsFor(kind, shard).length, 0);
      expect(minimum).toBeLessThanOrEqual(shardScenarioCounts[shard]);
      if (shard !== 'core') expect(minimum).toBe(shardScenarioCounts[shard]);
    }
  });

  it.each(Array.from({ length: 16 }, (_, seed) => seed))(
    'assembles every automatic shard within real IM/DM capacity and covers each variant once for seed %i', (seed) => {
      const registered = new Set(requiredKinds.flatMap((kind) =>
        probeVariantsFor(kind).map((variant) => `${kind}/${variant}`)));
      const emitted = new Map<string, { shard: string; count: number }>();
      for (const shard of automaticProbeShards) {
        const generated = generateBuiltinAsmTestCase({
          profile: 'P7',
          instructionText: seed % 2 === 0 ? '' : 'eret jr mult',
          instructionCount: 1118,
          seed: `p7-assembled-shard-${seed}-${shard}`,
          interrupt: true,
          timerInterrupt: true,
          externalInterruptIntensity: seed % 2 === 0 ? 0.01 : 1,
          timerIntensity: seed % 2 === 0 ? 1 : 0.01,
          exceptionTypes: [...enabledSources.exceptionTypes],
          p7StressMode: 'probe',
          probeShard: shard,
          probeScenarioCount: shardScenarioCounts[shard]
        });
        const metadata = generated.probe!;
        expect(metadata.shard).toBe(shard);
        expect(metadata.scenarios).toHaveLength(shardScenarioCounts[shard]);
        expect(metadata.scenarios.length).toBeLessThanOrEqual(p7ProbeMaxScenarioCount);
        expect(p7ProbeLogBase + metadata.scenarios.length * p7ProbeRecordWords * 4)
          .toBeLessThanOrEqual(p7UserTextBaseAddress);
        const expectedVariants = new Set(requiredKinds.flatMap((kind) =>
          probeVariantsFor(kind, shard).map((variant) => `${kind}/${variant}`)));
        expect(new Set(metadata.scenarios.map((scenario) => `${scenario.kind}/${scenario.variant}`)))
          .toEqual(expectedVariants);
        for (const scenario of metadata.scenarios) {
          const key = `${scenario.kind}/${scenario.variant}`;
          const previous = emitted.get(key);
          if (previous) {
            expect(previous.shard).toBe(shard);
            expect(shard).toBe('core');
            expect(scenario.kind).toBe('ri');
          }
          emitted.set(key, { shard, count: (previous?.count ?? 0) + 1 });
        }

        // Assemble the actual words, so pseudo expansion, raw RI words, duplicate
        // labels and handler growth cannot be hidden by ProgramWriter's counter.
        const assembled = assembleCourseSource({ id: `${shard}-${seed}`, text: generated.text }, { profile: 'P7' });
        expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
        const text = assembled.image!.segments.find((segment) => segment.name === 'text')!;
        const handler = assembled.image!.segments.find((segment) => segment.name === 'ktext')!;
        expect(text.baseAddress).toBe(p7UserTextBaseAddress);
        expect(text.words).toHaveLength(generated.instructionCount);
        expect(text.baseAddress + text.words.length * 4).toBeLessThanOrEqual(p7ExceptionHandlerAddress);
        expect(text.words.slice(-2)).toEqual([0x1000ffff, 0]);
        expect(handler.baseAddress).toBe(p7ExceptionHandlerAddress);
        expect(handler.words.length).toBeGreaterThan(0);
        expect(handler.baseAddress + handler.words.length * 4).toBeLessThanOrEqual(0x7000);
      }
      expect(new Set(emitted.keys())).toEqual(registered);
      for (const [variant, coverage] of emitted) {
        if (!variant.startsWith('ri/')) expect(coverage.count, variant).toBe(1);
      }
    }
  );
});
