import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { decodeCourseInstructionWord } from '../../mips/core/isa/decoder';
import { isaInstructions } from '../../mips/core/generated/isaCatalog';
import { decodeCourseMachineInstruction } from '../../courseTesting/machineCodeValidation';
import { Random } from '../../courseTesting/random';

describe('course validator delegates to the unique catalog decoder', () => {
  it('contains no production opcode/funct tables', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'courseTesting', 'machineCodeValidation.ts'),
      'utf8'
    );
    expect(source).toContain('decodeCourseInstructionWord');
    expect(source).not.toMatch(/(?:opcodeMnemonics|rTypeFunct|special2Funct|regimmRt)/);
    expect(source).not.toMatch(/new Map<number, string>/);
  });

  it('agrees on every catalog instruction encoding', () => {
    for (const entry of isaInstructions) {
      const word = buildWordForEntry(entry);
      const catalogDecoded = decodeCourseInstructionWord(word);
      expect(catalogDecoded, `${entry.mnemonic} must have a genuinely canonical witness`)
        .toBe(entry.mnemonic);
      expect(catalogDecoded, entry.mnemonic).toBe(decodeCourseMachineInstruction(word));
    }
  });

  it('keeps the compatibility export identical for encoding mutations', () => {
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

  it('keeps the compatibility export identical for a fixed random word sample', () => {
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
  const reads = new Set(entry.gprReads);
  const writes = new Set(entry.gprWrites);
  const rs = reads.has('rs') || writes.has('rs') ? 8 : 0;
  const rt = reads.has('rt') || writes.has('rt') ? 9 : 0;
  const rd = reads.has('rd') || writes.has('rd') ? 10 : 0;
  switch (entry.formatKind) {
    case 'eret':
      return 0x42000018;
    case 'r':
      if (entry.mnemonic === 'nop') {
        return 0;
      }
      return ((rs << 21) | (rt << 16) | (rd << 11)
        | ((['sll', 'srl', 'sra'].includes(entry.mnemonic) ? 3 : 0) << 6)
        | entry.formatFunct) >>> 0;
    case 'regimm':
      return ((entry.formatOpcode << 26) | (rs << 21) | (entry.formatRt << 16) | 4) >>> 0;
    case 'j':
      return ((entry.formatOpcode << 26) | 0xc00) >>> 0;
    case 'branch':
    case 'imm':
    case 'load':
    case 'store':
      return ((entry.formatOpcode << 26) | (rs << 21) | (rt << 16) | 4) >>> 0;
    case 'cop0':
      return ((entry.formatOpcode << 26) | (entry.formatRs << 21) | (rt << 16) | (12 << 11)) >>> 0;
    case 'special2':
      return ((entry.formatOpcode << 26) | (rs << 21) | (rt << 16) | (rd << 11) | entry.formatFunct) >>> 0;
    default:
      throw new Error(`unexpected format kind ${entry.formatKind}`);
  }
}
