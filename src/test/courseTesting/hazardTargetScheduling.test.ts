import { describe, expect, it, vi } from 'vitest';
import { automaticTestPolicy } from '../../courseTesting/automaticTestPolicy';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { HazardTarget, HazardTargetPlanner, predictForwardTuples } from '../../courseTesting/builtinAsm/hazard/hazardTargets';
import { forwardOperandKey } from '../../courseTesting/builtinAsm/hazard/targetKeys';
import { defaultInstructionSets } from '../../courseTesting/mnemonicSets';
import { forwardClassKey, HazardCoverage } from '../../hazardAnalysis/hazardCoverage';
import { hazardClassOf } from '../../hazardAnalysis/hazardTiming';

describe('bounded hazard target scheduling', () => {
  it('services both tiers while class debt remains, rotating concrete class-pair/port buckets', () => {
    const planner = new HazardTargetPlanner(new Set(defaultInstructionSets.P6), new HazardCoverage(), (items) => items);
    const tiers: number[] = [];
    const concreteBuckets: string[] = [];
    for (let index = 0; index < 18; index++) {
      const planned = planner.next(() => true)!;
      expect(planned).toBeDefined();
      tiers.push(planner.lastSelectionTier!);
      if (planner.lastSelectionTier === 2 && planned.target.kind === 'forward') {
        const target = planned.target;
        concreteBuckets.push(`${hazardClassOf(target.producer)}>${hazardClassOf(target.consumer)}.${target.role}`);
      }
      // No observations are supplied: all the initial class debt deliberately stays open.
    }
    expect(tiers).toEqual(Array.from({ length: 6 }, () => [2, 2, 1]).flat());
    expect(new Set(concreteBuckets).size).toBe(concreteBuckets.length);
  });

  it('keeps a mnemonic/port target open when its course tuple and coarse class were already covered', () => {
    const coverage = new HazardCoverage();
    const operands = new Set([forwardOperandKey('add', 'sub', 'rs', 0)]);
    coverage.classKeys.add(forwardClassKey('cal_rr', 'cal_rr', 'rt', 0));
    for (const tuple of predictForwardTuples('add', 'sub', 'rt', 0)) coverage.forwardTuples.add(tuple);
    const planner = new HazardTargetPlanner(new Set(['add', 'sub']), coverage, (items) => items, operands);
    const matches = (target: HazardTarget): boolean =>
      target.kind === 'forward' && target.producer === 'add' && target.consumer === 'sub' && target.role === 'rt' && target.gap === 0;
    const planned = planner.next(matches)!;
    expect(planned?.operandKey).toBe(forwardOperandKey('add', 'sub', 'rt', 0));
    expect(planner.lastSelectionTier).toBe(2);
    operands.add(planned.operandKey!);
    expect(planner.next(matches)).toBeUndefined();
  });

  it.each(['hazard-audit-0', 'hazard-audit-1', 'hazard-audit-2'])(
    'reaches concrete targets inside the unchanged P7 payload budget (%s)', (seed) => {
      const original = HazardTargetPlanner.prototype.next;
      const counts = { class: 0, operand: 0 };
      const spy = vi.spyOn(HazardTargetPlanner.prototype, 'next').mockImplementation(function (this: HazardTargetPlanner, realizable) {
        const planned = original.call(this, realizable);
        if (planned) counts[this.lastSelectionTier === 1 ? 'class' : 'operand']++;
        return planned;
      });
      try {
        const generated = generateBuiltinAsmTestCase({
          ...automaticTestPolicy('P7'), profile: 'P7', instructionText: '', seed, p7StressMode: 'anchor'
        });
        expect(generated.instructionCount).toBe(1118);
        expect(generated.interruptSchedule).toHaveLength(1);
        expect(counts.class).toBeGreaterThan(0);
        expect(counts.operand).toBeGreaterThan(0);
      } finally { spy.mockRestore(); }
    }
  );
});
