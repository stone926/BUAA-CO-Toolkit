import { describe, expect, it } from 'vitest';
import { decodeCourseInstructionWord } from '../../mips/core/isa/decoder';
import { isaInstructions } from '../../mips/core/generated/isaCatalog';
import { decodeCourseMachineInstruction } from '../../courseTesting/machineCodeValidation';
import { Random } from '../../courseTesting/random';

/**
 * Equivalence harness between the new catalog-backed canonical decoder and the
 * pre-existing course validator decoder. The expected side is the established
 * production implementation; any mismatch here is a catalog data bug or an
 * unintended semantic drift and must be fixed before convergence.
 */
describe('catalog decoder matches the established course validator decoder', () => {
  it('agrees on every catalog instruction encoding', () => {
    for (const entry of isaInstructions) {
      const word = buildWordForEntry(entry);
      expect(decodeCourseInstructionWord(word), entry.mnemonic)
        .toBe(decodeCourseMachineInstruction(word));
    }
  });

  it('agrees on single-bit and single-nibble mutations of every catalog encoding', () => {
    for (const entry of isaInstructions) {
      const word = buildWordForEntry(entry);
      const mutants = new Set<number>([word]);
      for (let bit = 0; bit < 32; bit += 3) {
        mutants.add(word ^ (1 << bit));
      }
      for (let nibble = 0; nibble < 32; nibble += 4) {
        mutants.add(word ^ (0xf << nibble));
      }
      for (const mutant of mutants) {
        expect(
          decodeCourseInstructionWord(mutant),
          `${entry.mnemonic} mutant 0x${(mutant >>> 0).toString(16)}`
        ).toBe(decodeCourseMachineInstruction(mutant));
      }
    }
  });

  it('agrees on a fixed random word sample', () => {
    const random = new Random(0x1a2b3c4d);
    for (let index = 0; index < 20_000; index++) {
      const word = random.nextInt();
      expect(decodeCourseInstructionWord(word), `random word 0x${(word >>> 0).toString(16)}`)
        .toBe(decodeCourseMachineInstruction(word));
    }
  });
});

/** Build one canonical word for a catalog entry using the layout-agnostic encoder rules. */
function buildWordForEntry(entry: (typeof isaInstructions)[number]): number {
  const rs = entry.formatKind === 'regimm' ? 8 : entry.formatRs !== 0 ? entry.formatRs : 0;
  const rt = entry.formatRt !== 0 ? entry.formatRt : 0;
  switch (entry.formatKind) {
    case 'nop':
      return 0;
    case 'eret':
      return 0x42000018;
    case 'r':
      return ((rs << 21) | (8 << 16) | (9 << 11) | (3 << 6) | entry.formatFunct) >>> 0;
    case 'regimm':
      return ((0x01 << 26) | (8 << 21) | (entry.formatRt << 16) | 4) >>> 0;
    case 'j':
      return ((entry.formatOpcode << 26) | 0xc00) >>> 0;
    case 'branch':
    case 'imm':
    case 'load':
    case 'store':
      return ((entry.formatOpcode << 26) | (8 << 21) | (9 << 16) | 4) >>> 0;
    case 'cop0':
      return ((entry.formatOpcode << 26) | (entry.formatRs << 21) | (8 << 16) | (12 << 11)) >>> 0;
    case 'special2':
      return ((entry.formatOpcode << 26) | (rs << 21) | (rt << 16) | (9 << 11) | (3 << 6) | entry.formatFunct) >>> 0;
    default:
      throw new Error(`unexpected format kind ${entry.formatKind}`);
  }
}
