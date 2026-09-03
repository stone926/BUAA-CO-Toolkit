import { describe, expect, it, vi } from 'vitest';
import { automaticTestPolicy } from '../../courseTesting/automaticTestPolicy';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { emitGeneralRegisterCoverage, emitRegisterJumpCoverage } from '../../courseTesting/builtinAsm/registerCoverage';
import { ProgramWriter } from '../../courseTesting/builtinAsm/programWriter';
import { CpuState } from '../../courseTesting/cpuState';
import { courseAsmHaltLoop } from '../../courseTesting/mipsUtil';
import { compareTraces } from '../../language/mips/traceCompare';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { CourseProfile } from '../../mips/core/generated/isaCatalog';
import { runCourseProgram } from '../../mips/core/machine/execution';
import { prepareCourseExecution, projectCourseExecutionOutcome } from '../../mips/core/machine/executeService';

const profiles = ['P3', 'P4', 'P5', 'P6', 'P7'] as const;
const allowed = new Set(['ori', 'add', 'sub', 'sw', 'lw', 'jr', 'nop']);

function prepare(text: string, profile: CourseProfile, interruptSchedule: readonly number[] = []) {
  const assembled = assembleCourseSource({ id: 'register-coverage', text }, { profile });
  expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
  const image = assembled.image!;
  const prepared = prepareCourseExecution({
    profile,
    segments: image.segments,
    entryPc: image.entryPc,
    haltPc: findCourseHaltPc(image, profile),
    maxSteps: 65_536,
    externalInterrupts: interruptSchedule.map((victimPc) => ({ victimPc, occurrence: 1 }))
  });
  return { ...prepared, assembled };
}

function execute(prepared: ReturnType<typeof prepare>) {
  return projectCourseExecutionOutcome(prepared,
    runCourseProgram(prepared.session, { collectTrace: true, finalSnapshotLevel: 'full' }));
}

function traceDiff(expected: readonly string[], actual: readonly string[]) {
  return compareTraces(parseSimOutput(expected.join('\n')), parseSimOutput(actual.join('\n')));
}

function directedProgram(kind: 'gpr' | 'jr', delaySlot = true): string {
  const program = new ProgramWriter(0x3000);
  const writer = {
    remaining: () => 1024 - program.count(),
    pc: () => program.pc(),
    emit: (_mnemonic: string, text: string) => program.emit(text),
    label: (label: string) => program.label(label)
  };
  const state = new CpuState();
  if (kind === 'gpr') emitGeneralRegisterCoverage(writer, state, allowed);
  else emitRegisterJumpCoverage(writer, state, allowed, delaySlot);
  return ['.text', 'main:', ...program.render(), ...courseAsmHaltLoop()].join('\n');
}

function sourceLabelPc(text: string, label: string): number {
  let pc = 0x3000;
  for (const line of text.split('main:\n')[1].split(/\r?\n/)) {
    if (line.trim() === `${label}:`) return pc;
    if (/^\s+(?:[a-z]|\.word)/.test(line)) pc += 4;
  }
  throw new Error(`Missing label ${label}`);
}

const hex = (value: number) => value.toString(16).padStart(8, '0').toUpperCase();

describe('directed architectural register coverage', () => {
  it.each(profiles)('completes default automatic %s programs inside the original IM budget', (profile) => {
    const policy = automaticTestPolicy(profile);
    const generated = generateBuiltinAsmTestCase({
      ...policy, profile, instructionText: '', seed: `register-coverage-${profile}`,
      p7StressMode: profile === 'P7' ? 'anchor' : 'off'
    });
    const prepared = prepare(generated.text, profile, generated.interruptSchedule);
    const result = execute(prepared);
    expect(result, result.diagnostic?.message).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
    expect(generated.instructionCount).toBe(profile === 'P7' ? 1118 : 4094);
    const words = prepared.assembled.image!.segments.find((segment) => segment.name === 'text')!.words;
    expect(words).toHaveLength(generated.instructionCount + 2);
    expect(words.slice(-3)).toEqual([0x34196d6e, 0x1000ffff, 0]);
    const markerPc = 0x3000 + (generated.instructionCount - 1) * 4;
    expect(sourceLabelPc(generated.text, '_co_test_complete')).toBe(markerPc);
    expect(result.trace![result.trace!.length - 1]).toBe(`@${hex(markerPc)}: $25 <= 00006D6E`);
    expect(traceDiff(result.trace!, result.trace!.slice(0, -1)).matched).toBe(false);

    for (let register = 1; register <= 31; register++) {
      const address = 0x100 + (register - 1) * 4;
      expect(result.trace!.some((line) => line.endsWith(`*${hex(address)} <= ${hex(register * 0x101)}`)), `$${register} observation`).toBe(true);
    }
    for (const producer of generated.instructionSet.includes('jr') ? ['ori', 'add', 'sub', 'lw'] : []) {
      for (const gap of [0, 1, 2]) {
        const pc = sourceLabelPc(generated.text, `_co_jr_${producer}_gap${gap}`);
        expect(result.trace!.some((line) => line.startsWith(`@${hex(pc)}: $22 <=`)), `${producer} -> jr, gap ${gap}`).toBe(true);
      }
    }
    const body = generated.text.split('_co_gpr_coverage_done:')[1].split('.ktext')[0];
    for (const line of body.split(/\r?\n/)) {
      const registers = line.match(/\$\d+\b/g) ?? [];
      expect(registers.slice(1), line).not.toContain('$26');
      expect(registers.slice(1), line).not.toContain('$27');
    }
  });

  it.each(['stuck-zero', 'alias-29'] as const)('exposes a $28 %s register-file fault through stored read results', (fault) => {
    const source = directedProgram('gpr');
    const golden = execute(prepare(source, 'P3'));
    const mutant = prepare(source, 'P3');
    const registers = mutant.session.machine.state.gpr;
    const read = registers.read.bind(registers);
    vi.spyOn(registers, 'read').mockImplementation((index) =>
      index === 28 ? (fault === 'stuck-zero' ? 0 : read(29)) : read(index));
    if (fault === 'alias-29') {
      const write = registers.write.bind(registers);
      vi.spyOn(registers, 'write').mockImplementation((index, value) => write(index === 28 ? 29 : index, value));
    }
    const result = execute(mutant);
    expect(result.status).toBe('halted');
    const observation = result.finalState.dataWords.find((word) => word.address === '0x0000016c');
    expect(observation?.value ?? '0x00000000').toBe(fault === 'stuck-zero' ? '0x00000000' : '0x00001d1d');
    expect(traceDiff(golden.trace!, result.trace!).matched).toBe(false);
    expect(golden.finalState.gpr[26]).toBe('0x00000000');
    expect(golden.finalState.gpr[27]).toBe('0x00000000');
  });

  it.each(['P4', 'P5'] as const)('observes every producer and 0/1/2 gap with %s jump semantics', (profile) => {
    const source = directedProgram('jr', profile === 'P5');
    const golden = execute(prepare(source, profile));
    expect(golden.status).toBe('halted');
    expect(golden.trace!.filter((line) => line.includes(': $26 <='))).toHaveLength(0);
    let index = 0;
    for (const producer of ['ori', 'add', 'sub', 'lw']) {
      for (const gap of [0, 1, 2]) {
        const label = `_co_jr_${producer}_gap${gap}`;
        const block = source.split(`${label}_start:\n`)[1].split(`${label}:`)[0];
        const instructions = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const jrIndex = instructions.indexOf('jr $25');
        expect(instructions[jrIndex - gap - 1]).toMatch(new RegExp(`^${producer} \\$25,`));
        expect(instructions.slice(jrIndex - gap, jrIndex)).toEqual(Array(gap).fill('nop'));
        const targetPc = sourceLabelPc(source, label);
        expect(golden.trace).toContain(`@${hex(targetPc)}: $22 <= ${hex(++index)}`);

        const mutant = prepare(source, profile);
        const registers = mutant.session.machine.state.gpr;
        const read = registers.read.bind(registers);
        const jrPc = sourceLabelPc(source, `${label}_start`) + jrIndex * 4;
        vi.spyOn(registers, 'read').mockImplementation((register) =>
          register === 25 && mutant.session.machine.state.pc === jrPc ? read(register) - 4 : read(register));
        const result = execute(mutant);
        expect(result.status).toBe('halted');
        expect(result.trace!.filter((line) => line.includes(': $26 <='))).toHaveLength(1);
        expect(traceDiff(golden.trace!, result.trace!).matched).toBe(false);
      }
    }
  });
});
