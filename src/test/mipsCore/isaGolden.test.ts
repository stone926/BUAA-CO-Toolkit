import { describe, expect, it } from 'vitest';
import { encodeInstructionWord } from '../../mips/core/isa/encoder';
import { decodeCourseInstructionWord, matchRuntimeInstruction } from '../../mips/core/isa/decoder';
import {
  instructionExceptionsForProfile,
  instructionHasDelaySlot,
  isaInstructionByMnemonic,
  isaMnemonicsForProfile
} from '../../mips/core/generated/isaCatalog';

const p7Required = { profile: 'P7', enabledLayers: ['required'] } as const;
const p7All = {
  profile: 'P7',
  enabledLayers: ['required', 'commonExtensions', 'marsCompatibility']
} as const;

/**
 * Encode/decode golden values, hand-checked against the MIPS encoding spec and
 * the existing course validator. These expected values are independent of the
 * production catalog: they are not derived from it.
 */
const encodeGolden: Array<{ mnemonic: string; operands: Parameters<typeof encodeInstructionWord>[1]; word: number }> = [
  { mnemonic: 'nop', operands: {}, word: 0x00000000 },
  { mnemonic: 'add', operands: { rd: 9, rs: 10, rt: 11 }, word: 0x014b4820 },
  { mnemonic: 'addu', operands: { rd: 9, rs: 10, rt: 11 }, word: 0x014b4821 },
  { mnemonic: 'sub', operands: { rd: 9, rs: 10, rt: 11 }, word: 0x014b4822 },
  { mnemonic: 'subu', operands: { rd: 9, rs: 10, rt: 11 }, word: 0x014b4823 },
  { mnemonic: 'and', operands: { rd: 8, rs: 9, rt: 10 }, word: 0x012a4024 },
  { mnemonic: 'or', operands: { rd: 8, rs: 9, rt: 10 }, word: 0x012a4025 },
  { mnemonic: 'xor', operands: { rd: 8, rs: 9, rt: 10 }, word: 0x012a4026 },
  { mnemonic: 'nor', operands: { rd: 8, rs: 9, rt: 10 }, word: 0x012a4027 },
  { mnemonic: 'slt', operands: { rd: 8, rs: 9, rt: 10 }, word: 0x012a402a },
  { mnemonic: 'sltu', operands: { rd: 8, rs: 9, rt: 10 }, word: 0x012a402b },
  { mnemonic: 'sll', operands: { rd: 8, rt: 9, shamt: 3 }, word: 0x000940c0 },
  { mnemonic: 'srl', operands: { rd: 8, rt: 9, shamt: 3 }, word: 0x000940c2 },
  { mnemonic: 'sra', operands: { rd: 8, rt: 9, shamt: 3 }, word: 0x000940c3 },
  { mnemonic: 'sllv', operands: { rd: 8, rs: 10, rt: 9 }, word: 0x01494004 },
  { mnemonic: 'srlv', operands: { rd: 8, rs: 10, rt: 9 }, word: 0x01494006 },
  { mnemonic: 'srav', operands: { rd: 8, rs: 10, rt: 9 }, word: 0x01494007 },
  { mnemonic: 'jr', operands: { rs: 31 }, word: 0x03e00008 },
  { mnemonic: 'jalr', operands: { rd: 8, rs: 9 }, word: 0x01204009 },
  { mnemonic: 'movz', operands: { rd: 8, rs: 9, rt: 10 }, word: 0x012a400a },
  { mnemonic: 'movn', operands: { rd: 8, rs: 9, rt: 10 }, word: 0x012a400b },
  { mnemonic: 'syscall', operands: {}, word: 0x0000000c },
  { mnemonic: 'mfhi', operands: { rd: 8 }, word: 0x00004010 },
  { mnemonic: 'mthi', operands: { rs: 8 }, word: 0x01000011 },
  { mnemonic: 'mflo', operands: { rd: 8 }, word: 0x00004012 },
  { mnemonic: 'mtlo', operands: { rs: 8 }, word: 0x01000013 },
  { mnemonic: 'mult', operands: { rs: 8, rt: 9 }, word: 0x01090018 },
  { mnemonic: 'multu', operands: { rs: 8, rt: 9 }, word: 0x01090019 },
  { mnemonic: 'div', operands: { rs: 8, rt: 9 }, word: 0x0109001a },
  { mnemonic: 'divu', operands: { rs: 8, rt: 9 }, word: 0x0109001b },
  { mnemonic: 'tge', operands: { rs: 8, rt: 9 }, word: 0x01090030 },
  { mnemonic: 'tgeu', operands: { rs: 8, rt: 9 }, word: 0x01090031 },
  { mnemonic: 'tlt', operands: { rs: 8, rt: 9 }, word: 0x01090032 },
  { mnemonic: 'tltu', operands: { rs: 8, rt: 9 }, word: 0x01090033 },
  { mnemonic: 'teq', operands: { rs: 8, rt: 9 }, word: 0x01090034 },
  { mnemonic: 'tne', operands: { rs: 8, rt: 9 }, word: 0x01090036 },
  { mnemonic: 'bltz', operands: { rs: 8, immediate: -8 }, word: 0x0500fff8 },
  { mnemonic: 'bgez', operands: { rs: 8, immediate: -8 }, word: 0x0501fff8 },
  { mnemonic: 'bltzal', operands: { rs: 8, immediate: -8 }, word: 0x0510fff8 },
  { mnemonic: 'bgezal', operands: { rs: 8, immediate: -8 }, word: 0x0511fff8 },
  { mnemonic: 'tgei', operands: { rs: 8, immediate: 1 }, word: 0x05080001 },
  { mnemonic: 'tgeiu', operands: { rs: 8, immediate: 1 }, word: 0x05090001 },
  { mnemonic: 'tlti', operands: { rs: 8, immediate: 1 }, word: 0x050a0001 },
  { mnemonic: 'tltiu', operands: { rs: 8, immediate: 1 }, word: 0x050b0001 },
  { mnemonic: 'teqi', operands: { rs: 8, immediate: 1 }, word: 0x050c0001 },
  { mnemonic: 'tnei', operands: { rs: 8, immediate: 1 }, word: 0x050e0001 },
  { mnemonic: 'j', operands: { index: 0xc00 }, word: 0x08000c00 },
  { mnemonic: 'jal', operands: { index: 0xc00 }, word: 0x0c000c00 },
  { mnemonic: 'beq', operands: { rs: 8, rt: 9, immediate: -4 }, word: 0x1109fffc },
  { mnemonic: 'bne', operands: { rs: 8, rt: 9 }, word: 0x15090000 },
  { mnemonic: 'blez', operands: { rs: 8 }, word: 0x19000000 },
  { mnemonic: 'bgtz', operands: { rs: 8 }, word: 0x1d000000 },
  { mnemonic: 'addi', operands: { rs: 9, rt: 8, immediate: 0x1234 }, word: 0x21281234 },
  { mnemonic: 'addiu', operands: { rs: 9, rt: 8, immediate: 0x1234 }, word: 0x25281234 },
  { mnemonic: 'slti', operands: { rs: 9, rt: 8, immediate: 0x1234 }, word: 0x29281234 },
  { mnemonic: 'sltiu', operands: { rs: 9, rt: 8, immediate: 0x1234 }, word: 0x2d281234 },
  { mnemonic: 'andi', operands: { rs: 9, rt: 8, immediate: 0x1234 }, word: 0x31281234 },
  { mnemonic: 'ori', operands: { rs: 0, rt: 8, immediate: 0x1234 }, word: 0x34081234 },
  { mnemonic: 'xori', operands: { rs: 9, rt: 8, immediate: 0x1234 }, word: 0x39281234 },
  { mnemonic: 'lui', operands: { rt: 9, immediate: 0x1234 }, word: 0x3c091234 },
  { mnemonic: 'mfc0', operands: { rt: 8, rd: 12 }, word: 0x40086000 },
  { mnemonic: 'mtc0', operands: { rt: 8, rd: 12 }, word: 0x40886000 },
  { mnemonic: 'eret', operands: {}, word: 0x42000018 },
  { mnemonic: 'lb', operands: { rs: 9, rt: 8 }, word: 0x81280000 },
  { mnemonic: 'lh', operands: { rs: 9, rt: 8 }, word: 0x85280000 },
  { mnemonic: 'lwl', operands: { rs: 9, rt: 8 }, word: 0x89280000 },
  { mnemonic: 'lw', operands: { rs: 9, rt: 8, immediate: 4 }, word: 0x8d280004 },
  { mnemonic: 'lbu', operands: { rs: 9, rt: 8 }, word: 0x91280000 },
  { mnemonic: 'lhu', operands: { rs: 9, rt: 8 }, word: 0x95280000 },
  { mnemonic: 'lwr', operands: { rs: 9, rt: 8 }, word: 0x99280000 },
  { mnemonic: 'sb', operands: { rs: 9, rt: 8 }, word: 0xa1280000 },
  { mnemonic: 'sh', operands: { rs: 9, rt: 8 }, word: 0xa5280000 },
  { mnemonic: 'swl', operands: { rs: 9, rt: 8 }, word: 0xa9280000 },
  { mnemonic: 'sw', operands: { rs: 9, rt: 8, immediate: 8 }, word: 0xad280008 },
  { mnemonic: 'swr', operands: { rs: 9, rt: 8 }, word: 0xb9280000 },
  { mnemonic: 'madd', operands: { rs: 8, rt: 9 }, word: 0x71090000 },
  { mnemonic: 'maddu', operands: { rs: 8, rt: 9 }, word: 0x71090001 },
  { mnemonic: 'mul', operands: { rd: 8, rs: 9, rt: 10 }, word: 0x712a4002 },
  { mnemonic: 'msub', operands: { rs: 8, rt: 9 }, word: 0x71090004 },
  { mnemonic: 'msubu', operands: { rs: 8, rt: 9 }, word: 0x71090005 },
  { mnemonic: 'clz', operands: { rd: 8, rs: 9 }, word: 0x71204020 },
  { mnemonic: 'clo', operands: { rd: 8, rs: 9 }, word: 0x71204021 }
];

describe('ISA catalog encode golden', () => {
  it('encodes every golden word exactly', () => {
    for (const golden of encodeGolden) {
      expect(encodeInstructionWord(golden.mnemonic, golden.operands), golden.mnemonic)
        .toBe(golden.word >>> 0);
    }
  });

  it('rejects unknown mnemonics and out-of-range fields', () => {
    expect(() => encodeInstructionWord('not-an-instruction')).toThrow();
    expect(() => encodeInstructionWord('add', { rd: 32 })).toThrow();
    expect(() => encodeInstructionWord('beq', { immediate: 0x10000 })).toThrow();
    expect(() => encodeInstructionWord('nop', { rd: 1 })).toThrow();
    expect(() => encodeInstructionWord('add', { rd: 1, rs: 2, rt: 3, shamt: 1 })).toThrow();
    expect(() => encodeInstructionWord('add', { rd: 1, rs: 2, rt: 3, immediate: 1 })).toThrow();
    expect(() => encodeInstructionWord('j', { index: 0xc00, rs: 1 })).toThrow();
    expect(() => encodeInstructionWord('lui', { rs: 0, rt: 1, immediate: 1 })).toThrow();
    expect(() => encodeInstructionWord('mtc0', { rt: 8, rd: 13 })).toThrow();
  });

  it('round-trips every golden word through the canonical decoder', () => {
    for (const golden of encodeGolden) {
      expect(decodeCourseInstructionWord(golden.word), golden.mnemonic).toBe(golden.mnemonic);
    }
  });
});

describe('ISA catalog runtime recognition vs canonical decode', () => {
  it('does not trigger P7 RI for non-canonical reserved bits (course contract counterexample)', () => {
    // add with non-zero shamt: runtime recognition must still name `add`,
    // while the canonical validator rejects the word.
    const nonCanonicalAdd = 0x014b48e0; // add $t1,$t2,$t3 with shamt=3
    expect(matchRuntimeInstruction(nonCanonicalAdd, p7Required)?.exactInstruction?.mnemonic).toBe('add');
    expect(decodeCourseInstructionWord(nonCanonicalAdd)).toBeUndefined();
    // jr with non-zero rt field
    const nonCanonicalJr = 0x03e90008; // rt=9
    expect(matchRuntimeInstruction(nonCanonicalJr, p7Required)?.exactInstruction?.mnemonic).toBe('jr');
    expect(decodeCourseInstructionWord(nonCanonicalJr)).toBeUndefined();
    // lui with non-zero rs field
    const nonCanonicalLui = 0x3d291234; // rs=9
    expect(matchRuntimeInstruction(nonCanonicalLui, p7Required)?.exactInstruction?.mnemonic).toBe('lui');
    expect(decodeCourseInstructionWord(nonCanonicalLui)).toBeUndefined();
  });

  it('restricts mfc0/mtc0 to the required course CP0 registers', () => {
    expect(decodeCourseInstructionWord(0x40086000)).toBe('mfc0'); // SR(12)
    expect(decodeCourseInstructionWord(0x40086800)).toBe('mfc0'); // Cause(13)
    expect(decodeCourseInstructionWord(0x40087000)).toBe('mfc0'); // EPC(14)
    expect(decodeCourseInstructionWord(0x40087800)).toBeUndefined(); // rd=15 not required
    expect(decodeCourseInstructionWord(0x40887800)).toBeUndefined(); // mtc0 rd=15
    // Runtime recognition is opcode/rs based and must not reject those.
    expect(matchRuntimeInstruction(0x40087800, p7Required)?.exactInstruction?.mnemonic).toBe('mfc0');
  });

  it('dispatches shared REGIMM/COP0 recognition groups without first-entry bias', () => {
    const bgez = matchRuntimeInstruction(0x05010000, p7All);
    expect(bgez?.candidates.map((entry) => entry.mnemonic)).toContain('bltz');
    expect(bgez?.candidates.map((entry) => entry.mnemonic)).toContain('bgez');
    expect(bgez?.exactInstruction?.mnemonic).toBe('bgez');

    const mtc0 = matchRuntimeInstruction(0x40886000, p7Required);
    expect(mtc0?.candidates.map((entry) => entry.mnemonic)).toEqual(expect.arrayContaining(['mfc0', 'mtc0']));
    expect(mtc0?.exactInstruction?.mnemonic).toBe('mtc0');
  });

  it('keeps MARS compatibility instructions out of the P7 required runtime scope', () => {
    expect(matchRuntimeInstruction(0x00000026, p7Required)).toBeUndefined(); // xor
    expect(matchRuntimeInstruction(0x00000026, p7All)?.exactInstruction?.mnemonic).toBe('xor');
    expect(decodeCourseInstructionWord(0x00000026, p7Required)).toBeUndefined();
  });

  it('recognizes an unimplemented encoding as unknown (RI source)', () => {
    // opcode 0x3f (not in the catalog), and R-type funct 0x3f.
    expect(matchRuntimeInstruction(0xfc000000, p7All)).toBeUndefined();
    expect(matchRuntimeInstruction(0x0000003f, p7All)).toBeUndefined();
  });
});

describe('ISA catalog profile availability', () => {
  it('qualifies delay-slot and architectural-exception facts by profile', () => {
    const beq = isaInstructionByMnemonic.get('beq')!;
    const add = isaInstructionByMnemonic.get('add')!;
    const lw = isaInstructionByMnemonic.get('lw')!;
    expect(instructionHasDelaySlot(beq, 'P3')).toBe(false);
    expect(instructionHasDelaySlot(beq, 'P4')).toBe(false);
    expect(instructionHasDelaySlot(beq, 'P5')).toBe(true);
    expect(instructionHasDelaySlot(beq, 'P7')).toBe(true);
    expect(instructionExceptionsForProfile(add, 'P3')).toEqual([]);
    expect(instructionExceptionsForProfile(add, 'P6')).toEqual([]);
    expect(instructionExceptionsForProfile(add, 'P7')).toEqual(['ov']);
    expect(instructionExceptionsForProfile(lw, 'P7')).toEqual(['adel']);
  });

  it('matches the generator profiles for every course profile (required layer only)', () => {
    // Expected sets come from resources/mips/generatorProfiles.json, the
    // pre-existing machine-readable course instruction fact.
    const expected: Record<string, string[]> = {
      P3: ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'nop'],
      P4: ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'jal', 'jr', 'nop'],
      P5: ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'jal', 'jr', 'nop'],
      P6: [
        'add', 'sub', 'and', 'or', 'slt', 'sltu', 'lui',
        'addi', 'andi', 'ori',
        'lb', 'lh', 'lw', 'sb', 'sh', 'sw',
        'mult', 'multu', 'div', 'divu', 'mfhi', 'mflo', 'mthi', 'mtlo',
        'beq', 'bne', 'jal', 'jr', 'nop'
      ],
      P7: [
        'add', 'sub', 'and', 'or', 'slt', 'sltu', 'lui',
        'addi', 'andi', 'ori',
        'lb', 'lh', 'lw', 'sb', 'sh', 'sw',
        'mult', 'multu', 'div', 'divu', 'mfhi', 'mflo', 'mthi', 'mtlo',
        'beq', 'bne', 'jal', 'jr',
        'mfc0', 'mtc0', 'eret', 'syscall', 'nop'
      ]
    };
    for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7'] as const) {
      const requiredFromCatalog = [...isaInstructionByMnemonic.values()]
        .filter((entry) => entry.layer === 'required' && entry.profiles.includes(profile))
        .map((entry) => entry.mnemonic)
        .sort();
      expect(requiredFromCatalog, profile).toEqual([...expected[profile]].sort());
    }
  });

  it('provides the complete P3 profile through isaMnemonicsForProfile', () => {
    // P3-usable set = required(8) + commonExtensions + marsCompatibility
    // layers with P3 in their profiles; P4+ additions and P6/P7-only required
    // instructions must not appear.
    expect([...isaMnemonicsForProfile('P3')].sort()).toEqual([
      'add', 'addu', 'addiu', 'beq', 'bgez', 'bgezal', 'blez', 'bltz',
      'bltzal', 'bgtz', 'clo', 'clz', 'j', 'jalr', 'lbu', 'lhu', 'lui', 'lw',
      'lwl', 'lwr', 'madd', 'maddu', 'movn', 'movz', 'msub', 'msubu', 'mul',
      'nop', 'nor', 'ori', 'sll', 'sllv', 'slti', 'sltiu', 'sra', 'srav',
      'srl', 'srlv', 'sub', 'subu', 'sw', 'swl', 'swr', 'tge', 'tgei',
      'tgeiu', 'tgeu', 'teq', 'teqi', 'tlt', 'tlti', 'tltiu', 'tltu', 'tne',
      'tnei', 'xor', 'xori'
    ].sort());
  });
});
