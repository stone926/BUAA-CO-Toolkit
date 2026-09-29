import { describe, expect, it } from 'vitest';
import { emitControlTargetCoverage } from '../../courseTesting/builtinAsm/controlTargetCoverage';
import { ProgramWriter } from '../../courseTesting/builtinAsm/programWriter';
import { CpuState } from '../../courseTesting/cpuState';
import { courseAsmHaltLoop } from '../../courseTesting/mipsUtil';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { executeProgramForService } from '../../mips/core/machine/executeService';
import { CourseProfile } from '../../mips/core/generated/isaCatalog';

const focus = new Set(['ori', 'sub', 'beq', 'nop']);
const hex = (value: number) => value.toString(16).padStart(8, '0').toUpperCase();

function fixture(profile: CourseProfile, budget: number) {
  const writer = new ProgramWriter(0x3000);
  const state = new CpuState();
  let label = 0;
  emitControlTargetCoverage({
    allowed: focus, state,
    remaining: () => budget - writer.count(),
    usesDelaySlot: () => profile !== 'P3' && profile !== 'P4',
    emit: (_mnemonic, instruction) => writer.emit(instruction),
    label: (name) => writer.label(name),
    nextLabel: (prefix) => `_co_${prefix}_${++label}`,
    skippedPoison: () => writer.emit('ori $26, $0, 0x77'),
    beginControlRegion: () => undefined,
    endControlRegion: () => undefined
  });
  const text = ['.text', 'main:', ...writer.render(), ...courseAsmHaltLoop()].join('\n');
  return { text, state, count: writer.count() };
}

function run(text: string, profile: CourseProfile) {
  const assembled = assembleCourseSource({ id: 'control-targets', text }, { profile });
  expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
  const image = assembled.image!;
  const result = executeProgramForService({
    profile, segments: image.segments, entryPc: image.entryPc,
    haltPc: findCourseHaltPc(image, profile), maxSteps: 128, collectTrace: true,
    enabledLayers: ['required', 'commonExtensions', 'marsCompatibility']
  });
  expect(result).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
  return { image, result };
}

function sourcePc(text: string, fragment: string): number {
  let pc = 0x3000;
  for (const line of text.split(/\r?\n/)) {
    if (line.includes(fragment)) return pc;
    if (/^\s+[a-z]/.test(line)) pc += 4;
  }
  throw new Error(`Missing ${fragment}`);
}

describe('directed bidirectional control targets', () => {
  it.each(['P3', 'P4', 'P5', 'P6', 'P7'] as const)('executes the three-visit graph for %s with both forward arms and a backward edge', (profile) => {
    const { text, state, count } = fixture(profile, 80);
    expect(count).toBe(profile === 'P3' || profile === 'P4' ? 17 : 23);
    const { image, result } = run(text, profile);
    const trace = result.trace!;
    const low = sourcePc(text, 'sub $21, $21, $22');
    const high = sourcePc(text, 'ori $20, $0, 0x52');
    const choose = sourcePc(text, 'beq $21, $22,');
    const back = sourcePc(text, `beq $0, $0, _co_backward_`);
    const words = image.segments.find((segment) => segment.name === 'text')!.words;
    const offset = (pc: number) => (words[(pc - 0x3000) / 4] << 16) >> 16;
    expect(offset(choose)).toBe((high - choose - 4) / 4);
    expect(offset(choose)).toBeGreaterThan(0);
    expect(offset(back)).toBe((low - back - 4) / 4);
    expect(offset(back)).toBeLessThan(0);
    expect(trace.filter((line) => line.startsWith(`@${hex(low)}: $21 <=`))).toEqual([
      `@${hex(low)}: $21 <= 00000002`,
      `@${hex(low)}: $21 <= 00000001`,
      `@${hex(low)}: $21 <= 00000000`
    ]);
    expect(trace.filter((line) => line.includes(': $20 <='))).toEqual([
      expect.stringContaining('$20 <= 00000040'),
      expect.stringContaining('$20 <= 00000051'),
      expect.stringContaining('$20 <= 00000052'),
      expect.stringContaining('$20 <= 00000053')
    ]);
    expect(trace.filter((line) => line.includes(': $23 <='))).toEqual([
      expect.stringContaining('$23 <= 00000002'),
      expect.stringContaining('$23 <= 00000001')
    ]);
    expect(trace.some((line) => line.includes(': $26 <='))).toBe(false);
    expect(state.regValue('$20')).toBe(0x53);
    expect(state.regValue('$21')).toBe(0);
    expect(state.regValue('$22')).toBe(1);
    expect(state.regValue('$23')).toBe(1);
    expect(result.finalState.gpr[20]).toBe('0x00000053');
    expect(result.finalState.gpr[21]).toBe('0x00000000');
    expect(result.finalState.gpr[23]).toBe('0x00000001');
  });

  it('makes an incorrect choice, backward target, or join edge observable in the trace', () => {
    const { text } = fixture('P5', 80);
    const original = run(text, 'P5').result.trace!;
    const done = /(_co_backward_done_\d+):/.exec(text)![1];
    const middle = /(_co_forward_middle_\d+):/.exec(text)![1];
    const mutants = [
      text.replace(/beq \$21, \$22, (_co_forward_high_\d+)/, 'beq $0, $0, $1'),
      text.replace(/beq \$0, \$0, (_co_backward_\d+)/, `beq $0, $0, ${done}`),
      text.replace(/beq \$0, \$0, (_co_branch_join_\d+)/, `beq $0, $0, ${middle}`)
    ];
    for (const mutant of mutants) {
      const changed = run(mutant, 'P5').result.trace!;
      expect(changed).not.toEqual(original);
      expect(changed.filter((line) => line.includes(': $20 <='))).not.toEqual(
        original.filter((line) => line.includes(': $20 <=')));
    }
  });

  it('leaves short budgets whole and falls back to the compact loop', () => {
    expect(fixture('P5', 11).count).toBe(0);
    const compact = fixture('P5', 12);
    expect(compact.count).toBe(12);
    expect(run(compact.text, 'P5').result.status).toBe('halted');
  });
});
