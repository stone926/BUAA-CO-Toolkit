import { describe, expect, it } from 'vitest';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { courseMachineCodeValidationError } from '../../courseTesting/machineCodeValidation';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { courseProgramImagePolicyIssues, wordAt } from '../../courseTesting/pipeline/courseImagePolicy';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { courseInstructionImageHexText, courseInstructionImageWords, findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { executeProgramForService } from '../../mips/core/machine/executeService';

describe('directed P7 automatic probes', () => {
  it('rechecks archived SR witnesses against the six IM bits, EXL and IE', () => {
    const { generated, image, haltPc } = assembleShard('architecture');
    const probe = structuredClone(generated.probe!);
    const events = execute(image, haltPc, [1]);
    const readbacks = probe.scenarios[1].requiredPreHandlerCommits!.filter(commit => commit.cp0Sample === 'status');
    expect(readbacks.map(commit => commit.value)).toEqual([0xfc01, 0xa800]);
    for (const commit of readbacks) delete commit.cp0Sample;
    const raw = ['fffffffd', 'aaaaaaa8'];
    const input = events.map(event => {
      const index = readbacks.findIndex(commit => commit.pc === Number.parseInt(event.pc, 16));
      return index < 0 ? event : { ...event, value: raw[index] };
    });
    expect(checkP7Probe('', input, probe, image).failures).toEqual([]);
    const damaged = input.map(event => Number.parseInt(event.pc, 16) === readbacks[0].pc
      ? { ...event, value: 'ffff7ffd' } : event);
    expect(checkP7Probe('', damaged, probe, image).passed).toBe(false);
  });

  it('takes reset syscall at 0x3000 and protects precise exception and mask witnesses', () => {
    const { generated, image, haltPc } = assembleShard('architecture');
    expect(wordAt(image, 0x3000)).toBe(0x0c);
    const probe = generated.probe!;
    expect(probe.scenarios.map(item => item.variant)).toEqual([
      'reset-syscall', 'misaligned-ie-clear', 'misaligned-ie-clear',
      'age-before-syscall', 'age-retry-after-adel', 'age-before-ades', 'age-retry-after-syscall',
      'age-before-ri', 'age-retry-after-ades',
      'sub-overflow-positive', 'sub-overflow-negative',
      'timer0-decode-hole-load', 'timer0-decode-hole-store', 'timer1-decode-hole-load', 'timer1-decode-hole-store',
      'im0-only', 'im1-only', 'both-pending-ie-clear'
    ]);
    const [olderLoad, youngerSyscall, olderSyscall, youngerStore, olderStore, youngerRi] = probe.scenarios.slice(3, 9);
    expect(youngerSyscall.victimPc).toBe(olderLoad.victimPc! + 4);
    expect(youngerStore.victimPc).toBe(olderSyscall.victimPc! + 4);
    expect(youngerRi.victimPc).toBe(olderStore.victimPc! + 4);
    expect(wordAt(image, olderStore.victimPc!)).toBe(0xac080001);
    expect(wordAt(image, youngerRi.victimPc!)).toBe(0xfc000000);
    const expected = [
      [0x2, 0x20], [0x1402, 0x10], [0x802, 0x14],
      [0x2, 0x10], [0x2, 0x20], [0x2, 0x20], [0x2, 0x14], [0x2, 0x14], [0x2, 0x28], [0x2, 0x30], [0x2, 0x30],
      [0x2, 0x10], [0x2, 0x14], [0x2, 0x10], [0x2, 0x14], [0x403, 0xc00], [0x803, 0xc00], [0xc03, 0xc00]
    ];
    for (const clocks of [[1], [1, 7, 2, 11]]) {
      const events = execute(image, haltPc, clocks);
      const checked = checkP7Probe('', events, probe, image);
      expect(checked.failures).toEqual([]);
      expect(checked.records.map(record => [record.status, record.cause])).toEqual(expected);
      for (const scenario of probe.scenarios) {
        for (const required of [...(scenario.requiredPreHandlerCommits ?? []), ...(scenario.requiredCommits ?? [])]) {
          const withoutWitness = events.filter(event => Number.parseInt(event.pc, 16) !== required.pc);
          expect(checkP7Probe('', withoutWitness, probe, image).passed, scenario.variant).toBe(false);
        }
        const recordAddress = probe.logBase + (scenario.id - 1) * probe.recordWords * 4;
        if (scenario.kind === 'timer0' || scenario.kind === 'timer1') {
          expect(scenario.allowedEpc).toEqual([scenario.waitPc]);
          const early = events.map(event => event.kind === 'dm' && Number.parseInt(event.target, 16) === recordAddress + 20
            ? { ...event, value: (scenario.waitPc! - 4).toString(16).padStart(8, '0') } : event);
          expect(checkP7Probe('', early, probe, image).passed).toBe(false);
        }
        for (const [offset, xor] of [[12, 2], [16, 0x400], [20, 0x80000000]]) {
          const faulty = events.map(event => event.kind === 'dm' && Number.parseInt(event.target, 16) === recordAddress + offset
            ? { ...event, value: ((Number.parseInt(event.value, 16) ^ xor) >>> 0).toString(16).padStart(8, '0') } : event);
          expect(checkP7Probe('', faulty, probe, image).passed, scenario.variant).toBe(false);
        }
      }
    }
  });

  it('executes loaded code through the entire IM, including the ordinary vector fall-through', () => {
    const { generated, image, haltPc } = assembleShard('im-boundaries');
    expect(courseInstructionImageWords(image)).toHaveLength(4096);
    expect(wordAt(image, 0x417c)).toBe(0x340b417c);
    expect(wordAt(image, 0x4180)).toBe(0x40186000);
    expect(wordAt(image, 0x6ffc)).toBe(0x340d6ffc);
    const probe = generated.probe!;
    const events = execute(image, haltPc, [1]);
    const checked = checkP7Probe('', events, probe, image);
    expect(checked.failures).toEqual([]);
    expect(checked.records.map(record => [record.epc, record.cause])).toEqual([
      0x7000, 0x2ffc, 0x4001, 0x4002, 0x4003, 0x4005, 0x4006, 0x4007, 0x4009, 0x400a, 0x400b
    ].map(epc => [epc, 0x10]));
    expect([wordAt(image, 0x4000), wordAt(image, 0x4004), wordAt(image, 0x4008)])
      .toEqual([0x0c, 0xfc000000, 0x3f]);
    for (const witness of probe.scenarios[0].requiredPreHandlerCommits!) {
      const withoutWitness = events.filter(event => Number.parseInt(event.pc, 16) !== witness.pc);
      expect(checkP7Probe('', withoutWitness, probe, image).passed).toBe(false);
    }
  });
});

function assembleShard(probeShard: 'architecture' | 'im-boundaries') {
  const generated = generateBuiltinAsmTestCase({ profile: 'P7', instructionText: '', instructionCount: 1118,
    seed: `directed-${probeShard}`, p7StressMode: 'probe', probeShard });
  const assembled = assembleCourseSource({ id: `directed-${probeShard}`, text: generated.text }, { profile: 'P7' });
  expect(assembled.ok, assembled.diagnostics.map(item => item.message).join('\n')).toBe(true);
  const image = assembled.image!;
  const haltPc = findCourseHaltPc(image, 'P7')!;
  expect(haltPc).toBe(0x3000 + (generated.instructionCount - 2) * 4);
  expect(courseProgramImagePolicyIssues('P7', image, haltPc)).toEqual([]);
  expect(courseMachineCodeValidationError('P7', courseInstructionImageHexText(image), generated.text, true)).toBeUndefined();
  return { generated, image, haltPc };
}

function execute(image: ReturnType<typeof assembleShard>['image'], haltPc: number, clocks: number[]) {
  const maxSteps = 3000;
  const executed = executeProgramForService({
    profile: 'P7', segments: image.segments, entryPc: image.entryPc, haltPc, maxSteps,
    collectTrace: true, enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
    deviceSchedule: { kind: 'timeline', entries: Array.from({ length: maxSteps }, (_, afterInstruction) => ({
      afterInstruction, cycles: clocks[afterInstruction % clocks.length]
    })) }
  });
  expect(executed, executed.trace?.slice(-30).join('\n')).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
  return parseSimOutput(executed.trace!.join('\n'));
}
