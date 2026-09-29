import { describe, expect, it, vi } from 'vitest';
import { automaticTestPolicy } from '../../courseTesting/automaticTestPolicy';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { CourseProfile } from '../../mips/core/generated/isaCatalog';
import { runCourseProgram } from '../../mips/core/machine/execution';
import { prepareCourseExecution, projectCourseExecutionOutcome } from '../../mips/core/machine/executeService';

function witnesses(profile: 'P5' | 'P6' | 'P7') {
  const generated = generateBuiltinAsmTestCase({
    ...automaticTestPolicy(profile), profile, instructionText: '', seed: 'observable-hazard-witnesses',
    p7StressMode: profile === 'P7' ? 'anchor' : 'off'
  });
  return [...generated.text.matchAll(/^(_co_hz_witness_(?!end)[\w]+):\r?\n([\s\S]*?)^_co_hz_witness_end\w*:/gm)]
    .map((match) => ({ name: match[1], lines: match[2].trim().split(/\r?\n/).map((line) => line.trim()) }));
}

function prepare(lines: readonly string[], profile: CourseProfile = 'P6') {
  const source = ['.text', 'main:', ...lines, '_co_test_end:', 'beq $0, $0, _co_test_end', 'nop'].join('\n');
  const assembled = assembleCourseSource({ id: 'hazard-witness', text: source }, { profile });
  expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
  return prepareCourseExecution({
    profile, segments: assembled.image!.segments, entryPc: assembled.image!.entryPc,
    haltPc: findCourseHaltPc(assembled.image!, profile), maxSteps: 256
  });
}

function execute(prepared: ReturnType<typeof prepare>) {
  const result = projectCourseExecutionOutcome(prepared,
    runCourseProgram(prepared.session, { collectTrace: true, finalSnapshotLevel: 'full' }));
  expect(result, result.diagnostic?.message).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
  return result;
}

/** Inject a stale operand at an architectural read; this is not a DUT pipeline model. */
function staleOperand(lines: readonly string[], consumer: number, operand: number) {
  const prepared = prepare(lines);
  const state = prepared.session.machine.state;
  const registers = state.gpr;
  const previous = new Map<number, number>();
  const read = registers.read.bind(registers);
  const write = registers.write.bind(registers);
  vi.spyOn(registers, 'write').mockImplementation((register, value) => {
    previous.set(register, read(register));
    write(register, value);
  });
  let seen = 0;
  let injected = false;
  vi.spyOn(registers, 'read').mockImplementation((register) => {
    if (state.pc === 0x3000 + consumer * 4 && seen++ === operand) {
      const stale = previous.get(register);
      expect(stale).toBeDefined();
      expect(stale).not.toBe(read(register));
      injected = true;
      return stale!;
    }
    return read(register);
  });
  const result = execute(prepared);
  expect(injected).toBe(true);
  return result;
}

describe('architecturally observable hazard witnesses', () => {
  it.each(['P5', 'P6', 'P7'] as const)('includes compact independently executable %s witnesses', (profile) => {
    const blocks = witnesses(profile);
    expect(blocks.filter(({ name }) => name.includes('_priority_'))).toHaveLength(6);
    expect(blocks.filter(({ name }) => name.includes('_dual_'))).toHaveLength(4);
    expect(blocks.filter(({ name }) => name.includes('_address_data_'))).toHaveLength(3);
    expect(blocks.filter(({ name }) => name.includes('_lane_'))).toHaveLength(profile === 'P5' ? 0 : 6);
    for (const { lines } of blocks) {
      expect(lines.length).toBeLessThanOrEqual(16);
      execute(prepare(lines, profile));
    }
  });

  it('exposes either stale read port for both newest-writer orders, dual sources and address/data dependencies', () => {
    for (const { name, lines } of witnesses('P6').filter(({ name }) => !name.includes('_lane_'))) {
      const consumer = name.includes('_address_data_')
        ? lines.findIndex((line) => /^sw (\$\d+), 0\(\1\)$/.test(line))
        : lines.findIndex((line) => /^(?:add|sub) /.test(line));
      expect(consumer, name).toBeGreaterThan(0);
      const golden = execute(prepare(lines));
      for (const operand of [0, 1]) {
        const mutant = staleOperand(lines, consumer, operand);
        expect(mutant.trace, `${name}, operand ${operand}`).not.toEqual(golden.trace);
        expect(mutant.finalState.dataWords, `${name}, operand ${operand}`).not.toEqual(golden.finalState.dataWords);
      }
    }
  });

  it('observes load-to-store data, preserves untouched lanes and forwards signed narrow loads', () => {
    for (const { name, lines } of witnesses('P6').filter(({ name }) => name.includes('_lane_'))) {
      const consumer = lines.findIndex((line) => /^(?:sb|sh) /.test(line));
      const operands = lines[consumer].match(/^(sb|sh) \$\d+, (0x[\da-f]+|\d+)\(\$0\)$/i)!;
      const address = Number(operands[2]);
      const lane = address & 3;
      const half = operands[1] === 'sh';
      const stored = half ? 0x81c3 + lane : 0x81 + lane;
      const shift = lane * 8;
      const mask = (half ? 0xffff : 0xff) << shift;
      const expected = ((0x12345678 & ~mask) | (stored << shift)) >>> 0;
      const golden = execute(prepare(lines));
      expect(golden.finalState.dataWords.find((word) => Number(word.address) === (address & ~3))?.value)
        .toBe(`0x${expected.toString(16).padStart(8, '0')}`);
      const signed = half ? (stored << 16) >> 16 : (stored << 24) >> 24;
      expect(golden.trace!.some((line) => line.endsWith(`<= ${(signed >>> 0).toString(16).padStart(8, '0').toUpperCase()}`)), name).toBe(true);
      // Store reads its base and then data in the architecture executor.
      const mutant = staleOperand(lines, consumer, 1);
      expect(mutant.trace, name).not.toEqual(golden.trace);
      expect(mutant.finalState.dataWords, name).not.toEqual(golden.finalState.dataWords);
    }
  });
});
