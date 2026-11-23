import { describe, expect, it } from 'vitest';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { p7CourseInstructionCountMaximum } from '../../courseTesting/p7Hardware';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { executeProgramForService } from '../../mips/core/machine/executeService';

const registerTraps = ['teq', 'tne', 'tge', 'tgeu', 'tlt', 'tltu'];
const immediateTraps = ['teqi', 'tnei', 'tgei', 'tgeiu', 'tlti', 'tltiu'];
const trapMnemonics = [...registerTraps, ...immediateTraps];
const allRegisters = new Set(Array.from({ length: 32 }, (_, index) => `$${index}`));

describe('native P3-P7 trap operands', () => {
  it.each(['P3', 'P4', 'P5', 'P6', 'P7'] as const)('executes non-raising traps across all %s GPRs', (profile) => {
    const { text } = generateBuiltinAsmTestCase({
      profile,
      instructionText: ['ori', 'addiu', 'lui', ...trapMnemonics].join(' '),
      instructionCount: profile === 'P7' ? p7CourseInstructionCountMaximum : 2048,
      seed: 'native-trap-registers'
    });
    expect(text).not.toMatch(/^\.ktext\b/m);
    const registerSources = new Set<string>();
    const registerTargets = new Set<string>();
    const immediateSources = new Set<string>();
    const counts = new Map<string, number>();
    let negativeUnsignedImmediate = false;
    for (const line of text.split('\n')) {
      const [mnemonic, rs, operand] = line.trim().split(/[ ,]+/);
      if (registerTraps.includes(mnemonic)) {
        registerSources.add(rs);
        registerTargets.add(operand);
      } else if (immediateTraps.includes(mnemonic)) {
        immediateSources.add(rs);
        if (mnemonic === 'tgeiu' && Number(operand) < 0) negativeUnsignedImmediate = true;
      } else {
        continue;
      }
      counts.set(mnemonic, (counts.get(mnemonic) ?? 0) + 1);
    }
    expect(registerSources).toEqual(allRegisters);
    expect(registerTargets).toEqual(allRegisters);
    expect(immediateSources).toEqual(allRegisters);
    expect(negativeUnsignedImmediate).toBe(true);
    expect(new Set(counts.keys())).toEqual(new Set(trapMnemonics));

    const assembled = assembleCourseSource({ id: 'native-traps', text }, { profile });
    expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
    const image = assembled.image!;
    const outcome = executeProgramForService({
      profile,
      enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
      segments: image.segments,
      entryPc: image.entryPc,
      haltPc: findCourseHaltPc(image, profile),
      maxSteps: 4096,
      collectCoverage: true
    });
    expect(outcome, outcome.diagnostic?.message).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
    expect(outcome.coverage?.some(({ id }) => id.startsWith('execution.exception.'))).toBe(false);
    for (const [mnemonic, hits] of counts) {
      expect(outcome.coverage).toContainEqual({ id: `execution.instruction.${profile}.${mnemonic}`, hits });
    }
  });
});
