import { describe, expect, it, vi } from 'vitest';
import { automaticTestPolicy } from '../../courseTesting/automaticTestPolicy';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { forwardTupleKey, stallTupleKey } from '../../courseTesting/builtinAsm/hazard/hazardCoverage';
import { decodeHazardInstruction } from '../../courseTesting/builtinAsm/hazard/hazardInstruction';
import { HazardObservation, HazardPipelineModel } from '../../courseTesting/builtinAsm/hazard/hazardPipeline';
import { predictForwardTuples } from '../../courseTesting/builtinAsm/hazard/hazardTargets';
import { CpuState } from '../../courseTesting/cpuState';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { CourseProfile } from '../../mips/core/generated/isaCatalog';
import { runCourseProgram } from '../../mips/core/machine/execution';
import { prepareCourseExecution, projectCourseExecutionOutcome } from '../../mips/core/machine/executeService';

function run(model: HazardPipelineModel, program: Array<[string, number?]>): HazardObservation[] {
  let previous = 0;
  return program.map(([text, next]) => {
    const decoded = decodeHazardInstruction(text);
    if (!decoded) throw new Error(`cannot decode ${text}`);
    const observation = model.observe(decoded, { previous, next: next ?? 0, raw: next ?? 0 });
    previous = next ?? previous;
    return observation;
  });
}

describe('course AT hazard model', () => {
  it('decodes operand roles from the canonical instruction formats', () => {
    expect(decodeHazardInstruction('sw $3, -4($7)')).toMatchObject({
      hazardClass: 'store',
      reads: [{ register: '$7', role: 'rs', useStage: 'E' }, { register: '$3', role: 'rt', useStage: 'M' }]
    });
    expect(decodeHazardInstruction('sllv $1, $2, $3')?.reads.map((read) => [read.register, read.role]))
      .toEqual([['$3', 'rs'], ['$2', 'rt']]);
    expect(decodeHazardInstruction('jal _x')?.write).toEqual({ register: '$31', readyStage: 'E' });
    expect(decodeHazardInstruction('lw $0, 0($1)')?.write).toEqual({ register: '$0', readyStage: 'W' });
    expect(decodeHazardInstruction('.word 0xfc000000')).toBeUndefined();
  });

  it('stalls a load-use pair once and forwards the first correct value from W', () => {
    const [, use] = run(new HazardPipelineModel(), [['lw $1, 0($0)', 7], ['add $2, $1, $0', 7]]);
    expect(use.stalls).toEqual([expect.objectContaining({ cause: 'lw', consumer: 'add', interval: 0 })]);
    expect(use.forwards).toEqual([expect.objectContaining({ source: 'W', destination: 'E', valid: true })]);
  });

  it('matches the course D-stage branch stalls for ALU and load producers', () => {
    expect(predictForwardTuples('add', 'beq', 'rs', 0)).toEqual([
      forwardTupleKey('add', 'beq', 'M', 'D'),
      stallTupleKey('beq', 'add', 0)
    ]);
    expect(predictForwardTuples('lw', 'beq', 'rs', 0)).toEqual([
      forwardTupleKey('lw', 'beq', 'W', 'D'),
      stallTupleKey('beq', 'lw', 0),
      stallTupleKey('beq', 'lw', 1)
    ]);
    expect(predictForwardTuples('lui', 'beq', 'rs', 0)).toEqual([forwardTupleKey('lui', 'beq', 'E', 'D')]);
    expect(predictForwardTuples('ori', 'sw', 'rt', 0)).toEqual([forwardTupleKey('ori', 'sw', 'M', 'E')]);
    expect(predictForwardTuples('ori', 'add', 'rs', 2)).toEqual([forwardTupleKey('ori', 'add', 'W', 'D')]);
  });

  it('marks a forward invalid when the register file already holds the same value', () => {
    const model = new HazardPipelineModel();
    const [, use] = run(model, [['ori $1, $0, 0', 0], ['addu $2, $1, $1', 0]]);
    expect(use.forwards.every((forward) => !forward.valid)).toBe(true);
  });

  it('never forwards a discarded $0 write but reports it as an observable hazard', () => {
    const model = new HazardPipelineModel();
    const [, use] = run(model, [['ori $0, $0, 5', 5], ['addu $2, $0, $0', 0]]);
    expect(use.forwards).toEqual([]);
    expect(use.zeroDestinations.length).toBeGreaterThan(0);
    expect(use.zeroDestinations.every((event) => event.valid)).toBe(true);
  });
});

describe('hazard-directed generation', () => {
  const profiles = ['P5', 'P6', 'P7'] as const;

  it.each(profiles)('keeps the %s software model exact while realizing hazard blocks', (profile) => {
    for (const seed of ['a', 'b', 'c']) {
      let modelState: CpuState | undefined;
      const original = CpuState.prototype.setRegister;
      const spy = vi.spyOn(CpuState.prototype, 'setRegister').mockImplementation(function (this: CpuState, register, value) {
        modelState ??= this;
        return original.call(this, register, value);
      });
      let generated: ReturnType<typeof generateBuiltinAsmTestCase>;
      try {
        generated = generateBuiltinAsmTestCase({
          ...automaticTestPolicy(profile), profile, instructionText: '', seed: `hazard-model-${seed}`,
          p7StressMode: profile === 'P7' ? 'anchor' : 'off'
        });
      } finally {
        spy.mockRestore();
      }
      const assembled = assembleCourseSource({ id: 'hazard', text: generated.text }, { profile: profile as CourseProfile });
      expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
      const prepared = prepareCourseExecution({
        profile,
        segments: assembled.image!.segments,
        entryPc: assembled.image!.entryPc,
        haltPc: findCourseHaltPc(assembled.image!, profile),
        maxSteps: 65_536,
        externalInterrupts: generated.interruptSchedule.map((victimPc) => ({ victimPc, occurrence: 1 }))
      });
      const result = projectCourseExecutionOutcome(prepared,
        runCourseProgram(prepared.session, { collectTrace: true, finalSnapshotLevel: 'full' }));
      expect(result, result.diagnostic?.message).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
      for (const register of [...Array.from({ length: 24 }, (_, index) => index + 1), 31]) {
        const expected = `0x${(modelState!.regValue(`$${register}`) >>> 0).toString(16).padStart(8, '0')}`;
        expect(result.finalState.gpr[register], `${profile}/${seed} $${register}`).toBe(expected);
      }
      // $25 finally holds the static completion marker.
      expect(result.finalState.gpr[25]).toBe('0x00006d6e');
      for (const word of result.finalState.dataWords) {
        const address = Number(word.address);
        if (address < 0x3000) {
          const expected = `0x${(modelState!.wordAt(address) >>> 0).toString(16).padStart(8, '0')}`;
          expect(word.value, `${profile}/${seed} DM ${word.address}`).toBe(expected);
        }
      }
      expect(generated.hazardCoverage?.stallTuples).toBeGreaterThan(0);
    }
  });

  it('reaches most course forward and stall tuples in one default P6 program', () => {
    const generated = generateBuiltinAsmTestCase({
      ...automaticTestPolicy('P6'), profile: 'P6', instructionText: '', seed: 'hazard-strength'
    });
    // Course Hazard-Calculator upper bounds for P6: 1036 forward, 110 stall tuples.
    expect(generated.hazardCoverage!.forwardTuples).toBeGreaterThan(550);
    expect(generated.hazardCoverage!.stallTuples).toBeGreaterThan(55);
    expect(generated.text).toMatch(/^# hazard_coverage: forward_tuples=\d+ stall_tuples=\d+/m);
  });

  it('does not add hazard metadata to single-cycle profiles', () => {
    const generated = generateBuiltinAsmTestCase({
      ...automaticTestPolicy('P3'), profile: 'P3', instructionText: '', seed: 'single-cycle'
    });
    expect(generated.hazardCoverage).toBeUndefined();
    expect(generated.text).not.toContain('hazard_coverage');
  });
});
