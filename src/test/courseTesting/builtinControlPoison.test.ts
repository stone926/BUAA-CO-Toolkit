import { describe, expect, it } from 'vitest';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsm/randomBody';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { CourseProfile } from '../../mips/core/generated/isaCatalog';
import { executeProgramForService } from '../../mips/core/machine/executeService';

const controls = ['beq', 'bne', 'bgez', 'bgtz', 'blez', 'bltz', 'bgezal', 'bltzal', 'j', 'jal', 'jr', 'jalr'];

function mainInstructions(text: string): string[] {
  return text.split('main:\n')[1].split('_co_test_end:')[0].split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => /^[a-z]/.test(line) && !line.endsWith(':'));
}

function execute(text: string, profile: CourseProfile) {
  const assembled = assembleCourseSource({ id: 'control-poison', text }, { profile });
  expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
  const image = assembled.image!;
  return executeProgramForService({
    profile,
    enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
    segments: image.segments,
    entryPc: image.entryPc,
    haltPc: findCourseHaltPc(image, profile),
    maxSteps: 2048,
    collectTrace: true
  });
}

describe('observable control-flow poison', () => {
  it.each(['P4', 'P6'] as const)('reserves a sentinel for every %s jump, including tiny payloads', (profile) => {
    // Stay below the directed hazard-block threshold to exercise the random emitter's exact
    // minimum budgets. Larger directed blocks are covered by builtinHazardGenerator tests.
    const selectedControls = profile === 'P4' ? ['beq', 'j', 'jal', 'jr'] : controls;
    const seen = new Set<string>();
    for (const control of selectedControls) {
      for (let count = 1; count <= 15; count++) {
        for (let seed = 0; seed < 3; seed++) {
          const result = generateBuiltinAsmTestCase({
            profile, instructionText: `ori ${control}`, instructionCount: count,
            seed: `poison-budget-${seed}`
          });
          const instructions = mainInstructions(result.text);
          expect(instructions).toHaveLength(count);
          for (let index = 0; index < instructions.length; index++) {
            if (instructions[index].split(' ')[0] !== control) continue;
            seen.add(control);
            const poisonIndex = index + (profile === 'P4' ? 1 : 2);
            expect(instructions[poisonIndex], `${profile} ${control}, budget ${count}`).toMatch(/^ori \$26, \$0,/);
            if (control === 'jr' || control === 'jalr') {
              const target = Number(instructions[index - 1].split(', ').at(-1));
              expect(target).toBe(0x3000 + (poisonIndex + 1) * 4);
            } else {
              const label = instructions[index].split(/[ ,]+/).at(-1)!;
              expect(result.text).toContain(`    ${instructions[poisonIndex]}\n${label}:`);
            }
          }
        }
      }
    }
    expect(seen).toEqual(new Set(selectedControls));
  });

  it.each(['add', 'sub', 'andi', 'xori', 'slti', 'sltiu', 'sllv', 'srlv', 'srav', 'clz', 'clo'])(
    'uses a safe observable %s write for a restricted instruction set', (mnemonic) => {
      const result = generateBuiltinAsmTestCase({
        profile: 'P6', instructionText: `beq ${mnemonic}`, instructionCount: 15,
        seed: `poison-${mnemonic}`
      });
      const instructions = mainInstructions(result.text);
      const branches = instructions.map((instruction, index) => ({ instruction, index }))
        .filter(({ instruction }) => instruction.startsWith('beq '));
      expect(branches.length).toBeGreaterThan(0);
      for (const { index } of branches) {
        expect(instructions[index + 2]).toMatch(new RegExp(`^${mnemonic} \\$26,`));
      }
      expect(execute(result.text, 'P6')).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
    }
  );

  it('fills unusable control-only focuses without emitting unobservable jumps', () => {
    for (const instructionText of ['beq nop', 'j', 'jal nop', 'jr nop']) {
      const result = generateBuiltinAsmTestCase({
        profile: 'P6', instructionText, instructionCount: 40, seed: 'no-poison-candidate'
      });
      expect(mainInstructions(result.text)).toEqual(Array(40).fill('nop'));
    }
  });

  it.each(['beq', 'bne', 'j', 'jal', 'jr', 'jalr'])(
    'exposes a wrong %s path as an extra or missing poison commit', (control) => {
      const result = generateBuiltinAsmTestCase({
        profile: 'P6', instructionText: `ori ${control}`, instructionCount: 15,
        seed: `poison-mutation-${control}`
      });
      const instructions = mainInstructions(result.text);
      const index = instructions.findIndex((instruction) => instruction.startsWith(`${control} `));
      expect(index).toBeGreaterThanOrEqual(0);
      const poisonPc = (0x3000 + (index + 2) * 4).toString(16).padStart(8, '0').toUpperCase();
      const original = execute(result.text, 'P6');
      const replacement = control === 'beq' ? instructions[index].replace(/^beq/, 'bne')
        : control === 'bne' ? instructions[index].replace(/^bne/, 'beq') : 'nop';
      const mutated = execute(result.text.replace(`    ${instructions[index]}\n`, `    ${replacement}\n`), 'P6');
      expect(original).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
      expect(mutated).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
      const committed = (trace: readonly string[]) => trace.some((line) => line.startsWith(`@${poisonPc}: $26 <=`));
      expect(committed(mutated.trace!)).toBe(!committed(original.trace!));
    }
  );
});
