import { describe, expect, it } from 'vitest';
import { InstructionLayer } from '../../mips/core/generated/isaCatalog';
import {
  branchCondition,
  immediateAlu,
  immediateTrapCondition,
  registerAlu,
  trapCondition
} from '../../mips/core/machine/semantics';
import {
  committedEvents,
  gprWrites,
  haltSequence,
  makeSession,
  op,
  runToCompletion
} from './programFixtures';

/**
 * Pure ALU / compare / shift / trap semantics of
 * `src/mips/core/machine/semantics.ts`, plus the same values observed end to end
 * through `CourseSystemSession`.
 *
 * Every expected number below is hand-computed from the 32-bit two's-complement
 * definition the course inherits from MIPS32, never read back from the executor:
 *
 * - Instruction families and their operand roles: `cscore/markdown/P5/testcases/P5-4-5.md`
 *   表「指令分类」（cal_rr = add/addu/subu/slt/sltu/and/nor/or/xor/sllv/srav/srlv,
 *   cal_ri = addi/addiu/slti/sltiu/andi/ori/xori/sll/sra/srl）and
 *   `cscore/markdown/P5/testcases/P5-4-1.md` 第 31-32 行.
 * - P6 arithmetic wraps and never raises an exception: `cscore/markdown/P6/P6-1.md`
 *   「所有运算类指令均暂不考虑因溢出而产生的异常」(COURSE-P6-ARITH-001).
 * - Only `add/addi/sub` carry the signed-overflow flag, and only P7 turns it into
 *   `Ov` with `Cause.ExcCode = 12`: `cscore/markdown/P7/implement/P7-2-3.md` 异常表
 *   第 12 行 (COURSE-P7-EXC-002, COURSE-P7-EXC-015).
 * - `$0` reads as zero and is never written: `courseProfiles.ts` reset state and
 *   `TraceProjectionPolicy.suppressZeroRegisterWrites` (COURSE-P3-RESET-001).
 * - P5+ control transfers own exactly one delay slot (COURSE-P6-DELAY-001), which
 *   is why the branch program below still commits its delay-slot write when the
 *   branch is not taken.
 *
 * Memory and multiply/divide semantics are deliberately out of scope here.
 */

const hex = (value: number): string => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;

/** Shifts, xor/nor, slti/sltiu/xori and clz/clo live in the MARS-compatible layer. */
const allLayers: readonly InstructionLayer[] = ['required', 'commonExtensions', 'marsCompatibility'];

interface RegisterAluCase {
  readonly handler: string;
  readonly rs: number;
  readonly rt: number;
  readonly shamt?: number;
  readonly value: number;
  readonly overflow?: boolean;
}

/** Every handler `registerAlu` implements, in source order. */
const registerAluHandlers: readonly string[] = [
  'add', 'addu', 'sub', 'subu', 'and', 'or', 'xor', 'nor', 'slt', 'sltu',
  'sll', 'srl', 'sra', 'sllv', 'srlv', 'srav', 'clz', 'clo'
];

const registerAluCases: readonly RegisterAluCase[] = [
  // ── add: signed 32-bit sum, wraps into the result and raises the flag ──────
  { handler: 'add', rs: 0x0000_0000, rt: 0x0000_0000, value: 0x0000_0000 },
  { handler: 'add', rs: 0x0000_0001, rt: 0xffff_ffff, value: 0x0000_0000 },
  { handler: 'add', rs: 0x0000_ffff, rt: 0x0000_8000, value: 0x0001_7fff },
  { handler: 'add', rs: 0x7fff_ffff, rt: 0x0000_0001, value: 0x8000_0000, overflow: true },
  { handler: 'add', rs: 0x8000_0000, rt: 0xffff_ffff, value: 0x7fff_ffff, overflow: true },
  { handler: 'add', rs: 0x8000_0000, rt: 0x8000_0000, value: 0x0000_0000, overflow: true },
  // -2^31 + (2^31 - 1) = -1 stays representable: mixed signs can never overflow.
  { handler: 'add', rs: 0x7fff_ffff, rt: 0x8000_0000, value: 0xffff_ffff },

  // ── addu: identical bit pattern, flag always clear ────────────────────────
  { handler: 'addu', rs: 0x7fff_ffff, rt: 0x0000_0001, value: 0x8000_0000 },
  { handler: 'addu', rs: 0x8000_0000, rt: 0xffff_ffff, value: 0x7fff_ffff },
  { handler: 'addu', rs: 0xffff_ffff, rt: 0x0000_0001, value: 0x0000_0000 },
  { handler: 'addu', rs: 0xffff_ffff, rt: 0xffff_ffff, value: 0xffff_fffe },
  { handler: 'addu', rs: 0x8000_0000, rt: 0x8000_0000, value: 0x0000_0000 },
  { handler: 'addu', rs: 0xffff_ffff, rt: 0x0000_ffff, value: 0x0000_fffe },

  // ── sub: rs - rt ──────────────────────────────────────────────────────────
  { handler: 'sub', rs: 0x0000_0000, rt: 0x0000_0000, value: 0x0000_0000 },
  { handler: 'sub', rs: 0x0000_0000, rt: 0x0000_0001, value: 0xffff_ffff },
  { handler: 'sub', rs: 0x0000_8000, rt: 0x0000_ffff, value: 0xffff_8001 },
  { handler: 'sub', rs: 0x8000_0000, rt: 0x0000_0001, value: 0x7fff_ffff, overflow: true },
  { handler: 'sub', rs: 0x7fff_ffff, rt: 0xffff_ffff, value: 0x8000_0000, overflow: true },
  { handler: 'sub', rs: 0x0000_0000, rt: 0x8000_0000, value: 0x8000_0000, overflow: true },
  { handler: 'sub', rs: 0xffff_ffff, rt: 0xffff_ffff, value: 0x0000_0000 },
  { handler: 'sub', rs: 0x7fff_ffff, rt: 0x7fff_ffff, value: 0x0000_0000 },

  // ── subu ──────────────────────────────────────────────────────────────────
  { handler: 'subu', rs: 0x0000_0000, rt: 0x0000_0001, value: 0xffff_ffff },
  { handler: 'subu', rs: 0x8000_0000, rt: 0x0000_0001, value: 0x7fff_ffff },
  { handler: 'subu', rs: 0x0000_0000, rt: 0x8000_0000, value: 0x8000_0000 },
  { handler: 'subu', rs: 0x0000_0001, rt: 0xffff_ffff, value: 0x0000_0002 },
  { handler: 'subu', rs: 0x7fff_ffff, rt: 0xffff_ffff, value: 0x8000_0000 },

  // ── and / or / xor / nor ──────────────────────────────────────────────────
  { handler: 'and', rs: 0xffff_ffff, rt: 0xffff_ffff, value: 0xffff_ffff },
  { handler: 'and', rs: 0x7fff_ffff, rt: 0x8000_0000, value: 0x0000_0000 },
  { handler: 'and', rs: 0xffff_ffff, rt: 0x0000_8000, value: 0x0000_8000 },
  { handler: 'and', rs: 0x0000_ffff, rt: 0x0000_8000, value: 0x0000_8000 },
  { handler: 'and', rs: 0x0000_0000, rt: 0xffff_ffff, value: 0x0000_0000 },

  { handler: 'or', rs: 0x0000_0000, rt: 0x0000_0000, value: 0x0000_0000 },
  { handler: 'or', rs: 0x7fff_ffff, rt: 0x8000_0000, value: 0xffff_ffff },
  { handler: 'or', rs: 0x0000_ffff, rt: 0x0000_8000, value: 0x0000_ffff },
  { handler: 'or', rs: 0x8000_0000, rt: 0x0000_0001, value: 0x8000_0001 },

  { handler: 'xor', rs: 0xffff_ffff, rt: 0xffff_ffff, value: 0x0000_0000 },
  { handler: 'xor', rs: 0x7fff_ffff, rt: 0x8000_0000, value: 0xffff_ffff },
  { handler: 'xor', rs: 0xffff_ffff, rt: 0x0000_8000, value: 0xffff_7fff },
  { handler: 'xor', rs: 0x0000_ffff, rt: 0x0000_8000, value: 0x0000_7fff },
  { handler: 'xor', rs: 0x0000_0000, rt: 0x8000_0000, value: 0x8000_0000 },

  { handler: 'nor', rs: 0x0000_0000, rt: 0x0000_0000, value: 0xffff_ffff },
  { handler: 'nor', rs: 0x7fff_ffff, rt: 0x8000_0000, value: 0x0000_0000 },
  { handler: 'nor', rs: 0x0000_ffff, rt: 0x0000_0000, value: 0xffff_0000 },
  { handler: 'nor', rs: 0x0000_8000, rt: 0x0000_8000, value: 0xffff_7fff },
  { handler: 'nor', rs: 0xffff_ffff, rt: 0x0000_0000, value: 0x0000_0000 },

  // ── slt: signed comparison, so 0x80000000 is the smallest operand ─────────
  { handler: 'slt', rs: 0x0000_0000, rt: 0x0000_0001, value: 0x0000_0001 },
  { handler: 'slt', rs: 0x0000_0001, rt: 0x0000_0000, value: 0x0000_0000 },
  { handler: 'slt', rs: 0xffff_ffff, rt: 0x0000_0000, value: 0x0000_0001 },
  { handler: 'slt', rs: 0x0000_0000, rt: 0xffff_ffff, value: 0x0000_0000 },
  { handler: 'slt', rs: 0x8000_0000, rt: 0x7fff_ffff, value: 0x0000_0001 },
  { handler: 'slt', rs: 0x7fff_ffff, rt: 0x8000_0000, value: 0x0000_0000 },
  { handler: 'slt', rs: 0xffff_ffff, rt: 0xffff_ffff, value: 0x0000_0000 },
  { handler: 'slt', rs: 0x0000_8000, rt: 0x0000_ffff, value: 0x0000_0001 },

  // ── sltu: unsigned, so 0x80000000 is the larger operand ───────────────────
  { handler: 'sltu', rs: 0x0000_0000, rt: 0x0000_0001, value: 0x0000_0001 },
  { handler: 'sltu', rs: 0xffff_ffff, rt: 0x0000_0000, value: 0x0000_0000 },
  { handler: 'sltu', rs: 0x0000_0000, rt: 0xffff_ffff, value: 0x0000_0001 },
  { handler: 'sltu', rs: 0x8000_0000, rt: 0x7fff_ffff, value: 0x0000_0000 },
  { handler: 'sltu', rs: 0x7fff_ffff, rt: 0x8000_0000, value: 0x0000_0001 },
  { handler: 'sltu', rs: 0x0000_8000, rt: 0x0000_ffff, value: 0x0000_0001 },
  { handler: 'sltu', rs: 0xffff_ffff, rt: 0xffff_ffff, value: 0x0000_0000 },

  // ── sll / srl / sra: `rt` shifted by the 5-bit shamt field; rs is ignored ──
  { handler: 'sll', rs: 0xffff_ffff, rt: 0x0000_0001, shamt: 0, value: 0x0000_0001 },
  { handler: 'sll', rs: 0x0000_0000, rt: 0x0000_0001, shamt: 31, value: 0x8000_0000 },
  { handler: 'sll', rs: 0x0000_0000, rt: 0xffff_ffff, shamt: 1, value: 0xffff_fffe },
  { handler: 'sll', rs: 0x0000_0000, rt: 0x8000_0000, shamt: 1, value: 0x0000_0000 },
  { handler: 'sll', rs: 0x0000_0000, rt: 0x0000_ffff, shamt: 16, value: 0xffff_0000 },
  { handler: 'sll', rs: 0x0000_0000, rt: 0x0000_8000, shamt: 16, value: 0x8000_0000 },
  { handler: 'sll', rs: 0x0000_0000, rt: 0x7fff_ffff, shamt: 1, value: 0xffff_fffe },

  { handler: 'srl', rs: 0xffff_ffff, rt: 0x0000_0001, shamt: 0, value: 0x0000_0001 },
  { handler: 'srl', rs: 0x0000_0000, rt: 0x8000_0000, shamt: 31, value: 0x0000_0001 },
  // Logical shift: the sign bit is replaced by zero, unlike `sra` below.
  { handler: 'srl', rs: 0x0000_0000, rt: 0x8000_0000, shamt: 4, value: 0x0800_0000 },
  { handler: 'srl', rs: 0x0000_0000, rt: 0xffff_ffff, shamt: 16, value: 0x0000_ffff },
  { handler: 'srl', rs: 0x0000_0000, rt: 0xffff_ffff, shamt: 31, value: 0x0000_0001 },
  { handler: 'srl', rs: 0x0000_0000, rt: 0x0000_8000, shamt: 15, value: 0x0000_0001 },
  { handler: 'srl', rs: 0x0000_0000, rt: 0x0000_ffff, shamt: 16, value: 0x0000_0000 },

  { handler: 'sra', rs: 0xffff_ffff, rt: 0x0000_0001, shamt: 1, value: 0x0000_0000 },
  { handler: 'sra', rs: 0x0000_0000, rt: 0x8000_0000, shamt: 31, value: 0xffff_ffff },
  // Arithmetic shift on the same negative operand as the `srl` case above.
  { handler: 'sra', rs: 0x0000_0000, rt: 0x8000_0000, shamt: 4, value: 0xf800_0000 },
  { handler: 'sra', rs: 0x0000_0000, rt: 0xffff_ffff, shamt: 16, value: 0xffff_ffff },
  { handler: 'sra', rs: 0x0000_0000, rt: 0x7fff_ffff, shamt: 16, value: 0x0000_7fff },
  { handler: 'sra', rs: 0x0000_0000, rt: 0x0000_ffff, shamt: 4, value: 0x0000_0fff },
  { handler: 'sra', rs: 0x0000_0000, rt: 0x0000_8000, shamt: 15, value: 0x0000_0001 },

  // ── sllv / srlv / srav: shift amount is `rs & 31`; the shamt field is unused ──
  { handler: 'sllv', rs: 0x0000_0000, rt: 0x0000_0001, value: 0x0000_0001 },
  { handler: 'sllv', rs: 0x0000_0001, rt: 0x0000_0001, shamt: 7, value: 0x0000_0002 },
  { handler: 'sllv', rs: 0x0000_001f, rt: 0x0000_0001, value: 0x8000_0000 },
  // 0xffff & 31 = 31 and 0x8000 & 31 = 0: the masking rule, both directions.
  { handler: 'sllv', rs: 0x0000_ffff, rt: 0x0000_0001, value: 0x8000_0000 },
  { handler: 'sllv', rs: 0x0000_8000, rt: 0x0000_0001, value: 0x0000_0001 },
  { handler: 'sllv', rs: 0x8000_0000, rt: 0xffff_ffff, value: 0xffff_ffff },
  { handler: 'sllv', rs: 0xffff_ffff, rt: 0x0000_0001, value: 0x8000_0000 },
  { handler: 'sllv', rs: 0x0000_0004, rt: 0x0000_ffff, value: 0x000f_fff0 },

  { handler: 'srlv', rs: 0x0000_0000, rt: 0x8000_0000, value: 0x8000_0000 },
  { handler: 'srlv', rs: 0x0000_0020, rt: 0x8000_0000, value: 0x8000_0000 },
  { handler: 'srlv', rs: 0xffff_ffff, rt: 0x8000_0000, value: 0x0000_0001 },
  { handler: 'srlv', rs: 0x0000_0004, rt: 0xffff_ffff, value: 0x0fff_ffff },
  { handler: 'srlv', rs: 0x0000_8000, rt: 0xffff_ffff, value: 0xffff_ffff },
  { handler: 'srlv', rs: 0x0000_ffff, rt: 0x0000_ffff, value: 0x0000_0000 },

  { handler: 'srav', rs: 0x0000_0000, rt: 0x8000_0000, value: 0x8000_0000 },
  { handler: 'srav', rs: 0x0000_0020, rt: 0x8000_0000, value: 0x8000_0000 },
  { handler: 'srav', rs: 0xffff_ffff, rt: 0x8000_0000, value: 0xffff_ffff },
  { handler: 'srav', rs: 0x0000_0004, rt: 0xffff_ffff, value: 0xffff_ffff },
  { handler: 'srav', rs: 0x0000_0004, rt: 0x8000_0000, value: 0xf800_0000 },
  { handler: 'srav', rs: 0x0000_ffff, rt: 0x7fff_ffff, value: 0x0000_0000 },
  { handler: 'srav', rs: 0x0000_0001, rt: 0x0000_ffff, value: 0x0000_7fff },

  // ── clz / clo: count leading zeros / ones of `rs`; rt and shamt are unused ──
  { handler: 'clz', rs: 0x0000_0000, rt: 0x0000_0000, value: 32 },
  { handler: 'clz', rs: 0x0000_0001, rt: 0x0000_0000, value: 31 },
  { handler: 'clz', rs: 0xffff_ffff, rt: 0x0000_0000, value: 0 },
  { handler: 'clz', rs: 0x7fff_ffff, rt: 0x0000_0000, value: 1 },
  { handler: 'clz', rs: 0x8000_0000, rt: 0x0000_0000, value: 0 },
  { handler: 'clz', rs: 0x0000_ffff, rt: 0x0000_0000, value: 16 },
  { handler: 'clz', rs: 0x0000_8000, rt: 0x0000_0000, value: 16 },
  { handler: 'clz', rs: 0x0000_0002, rt: 0xffff_ffff, shamt: 31, value: 30 },

  { handler: 'clo', rs: 0x0000_0000, rt: 0x0000_0000, value: 0 },
  { handler: 'clo', rs: 0xffff_ffff, rt: 0x0000_0000, value: 32 },
  { handler: 'clo', rs: 0x8000_0000, rt: 0x0000_0000, value: 1 },
  { handler: 'clo', rs: 0x7fff_ffff, rt: 0x0000_0000, value: 0 },
  { handler: 'clo', rs: 0xffff_8000, rt: 0x0000_0000, value: 17 },
  { handler: 'clo', rs: 0xc000_0000, rt: 0x0000_0000, value: 2 },
  { handler: 'clo', rs: 0x0000_ffff, rt: 0xffff_ffff, shamt: 31, value: 0 }
];

describe('register-register ALU semantics', () => {
  it('computes the 32-bit result of every register handler', () => {
    for (const testCase of registerAluCases) {
      const label = `${testCase.handler} rs=${hex(testCase.rs)} rt=${hex(testCase.rt)}`
        + ` shamt=${testCase.shamt ?? 0}`;
      const outcome = registerAlu(
        testCase.handler,
        testCase.rs,
        testCase.rt,
        testCase.shamt ?? 0
      );
      expect(outcome, label).toBeDefined();
      expect(outcome!.value, label).toBe(testCase.value);
      expect(outcome!.overflow, label).toBe(testCase.overflow ?? false);
    }
  });

  it('exercises every handler registerAlu implements', () => {
    const covered = [...new Set(registerAluCases.map((testCase) => testCase.handler))].sort();
    expect(covered).toEqual([...registerAluHandlers].sort());
  });

  it('rejects handlers that belong to another dispatch table', () => {
    // `registerAlu` must not silently answer for the immediate, memory or
    // multiply families: transition.ts relies on `undefined` to fall through.
    for (const handler of ['addi', 'ori', 'lui', 'lw', 'sw', 'mult', 'beq', 'nop', '']) {
      expect(registerAlu(handler, 1, 1, 1), handler).toBeUndefined();
    }
  });
});

describe('signed overflow flags of the arithmetic handlers', () => {
  it('raises the flag exactly on the signed 32-bit boundary crossings', () => {
    // 0x7fffffff + 1 leaves the positive range; 0x80000000 + (-1) leaves the
    // negative range. Both are Ov on P7 (P7-2-3 异常表, ExcCode 12).
    expect(registerAlu('add', 0x7fff_ffff, 0x0000_0001, 0)!.overflow).toBe(true);
    expect(registerAlu('add', 0x8000_0000, 0xffff_ffff, 0)!.overflow).toBe(true);
    // Operands of opposite sign can never leave the range.
    expect(registerAlu('add', 0x7fff_ffff, 0x8000_0000, 0)!.overflow).toBe(false);
    // 0x80000000 - 1 = -2147483649, one below the representable minimum.
    expect(registerAlu('sub', 0x8000_0000, 0x0000_0001, 0)!.overflow).toBe(true);
    expect(registerAlu('sub', 0x7fff_ffff, 0xffff_ffff, 0)!.overflow).toBe(true);
    expect(registerAlu('sub', 0xffff_ffff, 0x0000_0001, 0)!.overflow).toBe(false);
    // addi shares the add flag; addiu never sets one.
    expect(immediateAlu('addi', 0x7fff_ffff, 0x0001)!.overflow).toBe(true);
    expect(immediateAlu('addi', 0x8000_0000, 0xffff)!.overflow).toBe(true);
    expect(immediateAlu('addi', 0x7fff_ffff, 0x8000)!.overflow).toBe(false);
  });

  it('never raises the flag on the unsigned arithmetic handlers', () => {
    const overflowingPairs: ReadonlyArray<readonly [number, number]> = [
      [0x7fff_ffff, 0x0000_0001],
      [0x8000_0000, 0xffff_ffff],
      [0x8000_0000, 0x8000_0000],
      [0x0000_0000, 0x8000_0000],
      [0x7fff_ffff, 0x7fff_ffff]
    ];
    for (const [rs, rt] of overflowingPairs) {
      const label = `${hex(rs)}, ${hex(rt)}`;
      expect(registerAlu('addu', rs, rt, 0)!.overflow, label).toBe(false);
      expect(registerAlu('subu', rs, rt, 0)!.overflow, label).toBe(false);
      // The bit pattern still matches the trapping form (P6-1: 运算按 32 位结果执行).
      expect(registerAlu('addu', rs, rt, 0)!.value, label)
        .toBe(registerAlu('add', rs, rt, 0)!.value);
      expect(registerAlu('subu', rs, rt, 0)!.value, label)
        .toBe(registerAlu('sub', rs, rt, 0)!.value);
    }
    for (const immediate of [0x0001, 0xffff, 0x8000, 0x7fff]) {
      const label = `addiu imm=0x${immediate.toString(16)}`;
      expect(immediateAlu('addiu', 0x7fff_ffff, immediate)!.overflow, label).toBe(false);
      expect(immediateAlu('addiu', 0x8000_0000, immediate)!.overflow, label).toBe(false);
    }
  });
});

interface ImmediateAluCase {
  readonly handler: string;
  readonly rs: number;
  /** Raw 16-bit immediate field, exactly as it sits in the instruction word. */
  readonly immediate: number;
  readonly value: number;
  readonly overflow?: boolean;
}

const immediateAluHandlers: readonly string[] = [
  'addi', 'addiu', 'slti', 'sltiu', 'andi', 'ori', 'xori', 'lui'
];

const immediateAluCases: readonly ImmediateAluCase[] = [
  // ── addi / addiu: the immediate is sign-extended ──────────────────────────
  { handler: 'addi', rs: 0x0000_0000, immediate: 0x0001, value: 0x0000_0001 },
  { handler: 'addi', rs: 0x0000_0000, immediate: 0xffff, value: 0xffff_ffff },
  { handler: 'addi', rs: 0x0000_0001, immediate: 0x8000, value: 0xffff_8001 },
  { handler: 'addi', rs: 0xffff_ffff, immediate: 0x0001, value: 0x0000_0000 },
  { handler: 'addi', rs: 0x7fff_ffff, immediate: 0x8000, value: 0x7fff_7fff },
  { handler: 'addi', rs: 0x7fff_ffff, immediate: 0x0001, value: 0x8000_0000, overflow: true },
  { handler: 'addi', rs: 0x8000_0000, immediate: 0xffff, value: 0x7fff_ffff, overflow: true },
  { handler: 'addi', rs: 0x8000_0000, immediate: 0x8000, value: 0x7fff_8000, overflow: true },

  { handler: 'addiu', rs: 0x0000_0000, immediate: 0xffff, value: 0xffff_ffff },
  { handler: 'addiu', rs: 0x0000_0001, immediate: 0xffff, value: 0x0000_0000 },
  { handler: 'addiu', rs: 0x7fff_ffff, immediate: 0x0001, value: 0x8000_0000 },
  { handler: 'addiu', rs: 0x8000_0000, immediate: 0x8000, value: 0x7fff_8000 },
  { handler: 'addiu', rs: 0x0000_0000, immediate: 0x8000, value: 0xffff_8000 },

  // ── slti: sign-extend, then compare SIGNED ────────────────────────────────
  // rs = 0, imm = 0xffff -> 0 < -1 is false. Paired with the sltiu row below.
  { handler: 'slti', rs: 0x0000_0000, immediate: 0xffff, value: 0x0000_0000 },
  { handler: 'slti', rs: 0x0000_0000, immediate: 0x0001, value: 0x0000_0001 },
  { handler: 'slti', rs: 0xffff_ffff, immediate: 0x0000, value: 0x0000_0001 },
  { handler: 'slti', rs: 0xffff_ffff, immediate: 0xffff, value: 0x0000_0000 },
  { handler: 'slti', rs: 0x8000_0000, immediate: 0x7fff, value: 0x0000_0001 },
  { handler: 'slti', rs: 0x7fff_ffff, immediate: 0xffff, value: 0x0000_0000 },
  { handler: 'slti', rs: 0x7fff_ffff, immediate: 0x8000, value: 0x0000_0000 },
  { handler: 'slti', rs: 0x0000_8000, immediate: 0xffff, value: 0x0000_0000 },

  // ── sltiu: sign-extend, then compare UNSIGNED ─────────────────────────────
  // rs = 0, imm = 0xffff -> 0 < 0xffffffff is true, the opposite of slti above.
  { handler: 'sltiu', rs: 0x0000_0000, immediate: 0xffff, value: 0x0000_0001 },
  { handler: 'sltiu', rs: 0x0000_0000, immediate: 0x0001, value: 0x0000_0001 },
  { handler: 'sltiu', rs: 0x0000_0001, immediate: 0x0000, value: 0x0000_0000 },
  { handler: 'sltiu', rs: 0xffff_ffff, immediate: 0xffff, value: 0x0000_0000 },
  { handler: 'sltiu', rs: 0xffff_fffe, immediate: 0xffff, value: 0x0000_0001 },
  { handler: 'sltiu', rs: 0x8000_0000, immediate: 0x7fff, value: 0x0000_0000 },
  { handler: 'sltiu', rs: 0x7fff_ffff, immediate: 0x8000, value: 0x0000_0001 },
  { handler: 'sltiu', rs: 0x0000_8000, immediate: 0xffff, value: 0x0000_0001 },

  // ── andi / ori / xori: the immediate is ZERO-extended ─────────────────────
  // Each row would differ if the immediate were sign-extended instead.
  { handler: 'andi', rs: 0xffff_ffff, immediate: 0xffff, value: 0x0000_ffff },
  { handler: 'andi', rs: 0xffff_ffff, immediate: 0x8000, value: 0x0000_8000 },
  { handler: 'andi', rs: 0x1234_5678, immediate: 0xffff, value: 0x0000_5678 },
  { handler: 'andi', rs: 0xffff_ffff, immediate: 0x0000, value: 0x0000_0000 },
  { handler: 'andi', rs: 0x8000_0000, immediate: 0xffff, value: 0x0000_0000 },

  { handler: 'ori', rs: 0x0000_0000, immediate: 0xffff, value: 0x0000_ffff },
  { handler: 'ori', rs: 0xffff_0000, immediate: 0x8000, value: 0xffff_8000 },
  { handler: 'ori', rs: 0x8000_0000, immediate: 0xffff, value: 0x8000_ffff },
  { handler: 'ori', rs: 0x0000_0000, immediate: 0x0000, value: 0x0000_0000 },

  { handler: 'xori', rs: 0xffff_ffff, immediate: 0xffff, value: 0xffff_0000 },
  { handler: 'xori', rs: 0x0000_0000, immediate: 0x8000, value: 0x0000_8000 },
  { handler: 'xori', rs: 0x0000_ffff, immediate: 0xffff, value: 0x0000_0000 },
  { handler: 'xori', rs: 0x8000_0000, immediate: 0xffff, value: 0x8000_ffff },

  // ── lui: the immediate becomes the high half; rs is not read ──────────────
  { handler: 'lui', rs: 0xffff_ffff, immediate: 0x1234, value: 0x1234_0000 },
  { handler: 'lui', rs: 0xffff_ffff, immediate: 0xffff, value: 0xffff_0000 },
  { handler: 'lui', rs: 0x0000_0000, immediate: 0x8000, value: 0x8000_0000 },
  { handler: 'lui', rs: 0x0000_0000, immediate: 0x0001, value: 0x0001_0000 },
  { handler: 'lui', rs: 0x0000_0000, immediate: 0x0000, value: 0x0000_0000 }
];

describe('register-immediate ALU semantics', () => {
  it('computes the 32-bit result of every immediate handler', () => {
    for (const testCase of immediateAluCases) {
      const label = `${testCase.handler} rs=${hex(testCase.rs)}`
        + ` imm=0x${testCase.immediate.toString(16).padStart(4, '0')}`;
      const outcome = immediateAlu(testCase.handler, testCase.rs, testCase.immediate);
      expect(outcome, label).toBeDefined();
      expect(outcome!.value, label).toBe(testCase.value);
      expect(outcome!.overflow, label).toBe(testCase.overflow ?? false);
    }
  });

  it('splits slti and sltiu on the same sign-extended immediate', () => {
    // The single most mutation-prone pair: both sign-extend 0xffff to
    // 0xffffffff, then slti reads it as -1 and sltiu as 4294967295.
    for (const rs of [0x0000_0000, 0x0000_0001, 0x0000_8000, 0x7fff_ffff]) {
      const label = `rs=${hex(rs)}`;
      expect(immediateAlu('slti', rs, 0xffff)!.value, label).toBe(0);
      expect(immediateAlu('sltiu', rs, 0xffff)!.value, label).toBe(1);
    }
    // A negative rs flips it back: -1 < -1 is false, but 0xffffffff is not
    // unsigned-less-than itself either.
    expect(immediateAlu('slti', 0xffff_ffff, 0xffff)!.value).toBe(0);
    expect(immediateAlu('sltiu', 0xffff_ffff, 0xffff)!.value).toBe(0);
  });

  it('exercises every handler immediateAlu implements', () => {
    const covered = [...new Set(immediateAluCases.map((testCase) => testCase.handler))].sort();
    expect(covered).toEqual([...immediateAluHandlers].sort());
  });

  it('rejects handlers that belong to another dispatch table', () => {
    for (const handler of ['add', 'sll', 'lw', 'beq', 'teqi', 'nop', '']) {
      expect(immediateAlu(handler, 1, 1), handler).toBeUndefined();
    }
  });
});

interface BranchCase {
  readonly handler: string;
  readonly rs: number;
  readonly rt: number;
  readonly taken: boolean;
}

/** `blez/bgtz/bltz/bgez` read only `rs`; a junk `rt` must not change the verdict. */
const junkRt = 0xdead_beef;

const branchCases: readonly BranchCase[] = [
  { handler: 'beq', rs: 0x0000_0000, rt: 0x0000_0000, taken: true },
  { handler: 'beq', rs: 0xffff_ffff, rt: 0xffff_ffff, taken: true },
  { handler: 'beq', rs: 0x8000_0000, rt: 0x8000_0000, taken: true },
  { handler: 'beq', rs: 0x0000_0000, rt: 0x0000_0001, taken: false },
  { handler: 'beq', rs: 0x8000_0000, rt: 0x0000_0000, taken: false },
  { handler: 'beq', rs: 0x7fff_ffff, rt: 0x8000_0000, taken: false },

  { handler: 'bne', rs: 0x0000_0000, rt: 0x0000_0000, taken: false },
  { handler: 'bne', rs: 0xffff_ffff, rt: 0xffff_ffff, taken: false },
  { handler: 'bne', rs: 0x8000_0000, rt: 0x8000_0000, taken: false },
  { handler: 'bne', rs: 0x0000_0000, rt: 0x0000_0001, taken: true },
  { handler: 'bne', rs: 0x8000_0000, rt: 0x0000_0000, taken: true },
  { handler: 'bne', rs: 0x7fff_ffff, rt: 0x8000_0000, taken: true },

  // blez: rs <= 0 read as a signed value.
  { handler: 'blez', rs: 0x0000_0000, rt: junkRt, taken: true },
  { handler: 'blez', rs: 0x0000_0001, rt: junkRt, taken: false },
  { handler: 'blez', rs: 0xffff_ffff, rt: junkRt, taken: true },
  { handler: 'blez', rs: 0x8000_0000, rt: junkRt, taken: true },
  { handler: 'blez', rs: 0x7fff_ffff, rt: junkRt, taken: false },
  { handler: 'blez', rs: 0x0000_8000, rt: junkRt, taken: false },

  // bgtz: rs > 0 signed.
  { handler: 'bgtz', rs: 0x0000_0000, rt: junkRt, taken: false },
  { handler: 'bgtz', rs: 0x0000_0001, rt: junkRt, taken: true },
  { handler: 'bgtz', rs: 0xffff_ffff, rt: junkRt, taken: false },
  { handler: 'bgtz', rs: 0x8000_0000, rt: junkRt, taken: false },
  { handler: 'bgtz', rs: 0x7fff_ffff, rt: junkRt, taken: true },
  { handler: 'bgtz', rs: 0x0000_ffff, rt: junkRt, taken: true },

  // bltz: rs < 0 signed.
  { handler: 'bltz', rs: 0x0000_0000, rt: junkRt, taken: false },
  { handler: 'bltz', rs: 0x0000_0001, rt: junkRt, taken: false },
  { handler: 'bltz', rs: 0xffff_ffff, rt: junkRt, taken: true },
  { handler: 'bltz', rs: 0x8000_0000, rt: junkRt, taken: true },
  { handler: 'bltz', rs: 0x7fff_ffff, rt: junkRt, taken: false },

  // bgez: rs >= 0 signed.
  { handler: 'bgez', rs: 0x0000_0000, rt: junkRt, taken: true },
  { handler: 'bgez', rs: 0x0000_0001, rt: junkRt, taken: true },
  { handler: 'bgez', rs: 0xffff_ffff, rt: junkRt, taken: false },
  { handler: 'bgez', rs: 0x8000_0000, rt: junkRt, taken: false },
  { handler: 'bgez', rs: 0x7fff_ffff, rt: junkRt, taken: true }
];

describe('conditional branch predicates', () => {
  it('decides every branch handler across the signed sign boundary', () => {
    for (const testCase of branchCases) {
      const label = `${testCase.handler} rs=${hex(testCase.rs)} rt=${hex(testCase.rt)}`;
      expect(branchCondition(testCase.handler, testCase.rs, testCase.rt), label)
        .toBe(testCase.taken);
    }
  });

  it('reuses the bltz/bgez predicate for the linking REGIMM forms', () => {
    for (const rs of [0x0000_0000, 0x0000_0001, 0xffff_ffff, 0x8000_0000, 0x7fff_ffff]) {
      const label = hex(rs);
      expect(branchCondition('bltzal', rs, 0), label).toBe(branchCondition('bltz', rs, 0));
      expect(branchCondition('bgezal', rs, 0), label).toBe(branchCondition('bgez', rs, 0));
    }
  });

  it('rejects handlers that are not conditional branches', () => {
    for (const handler of ['j', 'jal', 'jr', 'add', 'teq', 'nop', '']) {
      expect(branchCondition(handler, 1, 1), handler).toBeUndefined();
    }
  });
});

interface TrapMatrixRow {
  readonly rs: number;
  readonly rt: number;
  readonly tge: boolean;
  readonly tgeu: boolean;
  readonly tlt: boolean;
  readonly tltu: boolean;
  readonly teq: boolean;
  readonly tne: boolean;
}

const registerTrapHandlers = ['tge', 'tgeu', 'tlt', 'tltu', 'teq', 'tne'] as const;

const registerTrapMatrix: readonly TrapMatrixRow[] = [
  // -1 vs 0: signed says less, unsigned says greater.
  { rs: 0xffff_ffff, rt: 0x0000_0000, tge: false, tgeu: true, tlt: true, tltu: false, teq: false, tne: true },
  // The extreme sign-boundary pair: 0x80000000 vs 0x7fffffff.
  { rs: 0x8000_0000, rt: 0x7fff_ffff, tge: false, tgeu: true, tlt: true, tltu: false, teq: false, tne: true },
  { rs: 0x7fff_ffff, rt: 0x8000_0000, tge: true, tgeu: false, tlt: false, tltu: true, teq: false, tne: true },
  // Equal operands: the `ge` forms hold, the `lt` forms do not.
  { rs: 0x8000_0000, rt: 0x8000_0000, tge: true, tgeu: true, tlt: false, tltu: false, teq: true, tne: false },
  { rs: 0x0000_0000, rt: 0x0000_0001, tge: false, tgeu: false, tlt: true, tltu: true, teq: false, tne: true },
  { rs: 0x0000_0001, rt: 0x0000_0000, tge: true, tgeu: true, tlt: false, tltu: false, teq: false, tne: true },
  { rs: 0x0000_ffff, rt: 0x0000_8000, tge: true, tgeu: true, tlt: false, tltu: false, teq: false, tne: true }
];

interface ImmediateTrapMatrixRow {
  readonly rs: number;
  readonly immediate: number;
  readonly tgei: boolean;
  readonly tgeiu: boolean;
  readonly tlti: boolean;
  readonly tltiu: boolean;
  readonly teqi: boolean;
  readonly tnei: boolean;
}

const immediateTrapHandlers = ['tgei', 'tgeiu', 'tlti', 'tltiu', 'teqi', 'tnei'] as const;

const immediateTrapMatrix: readonly ImmediateTrapMatrixRow[] = [
  // imm 0xffff sign-extends to 0xffffffff: -1 to the signed forms, 4294967295
  // to the unsigned ones. Every `*iu` column below flips against its `*i` twin.
  { rs: 0x0000_0000, immediate: 0xffff, tgei: true, tgeiu: false, tlti: false, tltiu: true, teqi: false, tnei: true },
  { rs: 0xffff_ffff, immediate: 0xffff, tgei: true, tgeiu: true, tlti: false, tltiu: false, teqi: true, tnei: false },
  // imm 0x8000 sign-extends to 0xffff8000 (-32768).
  { rs: 0x7fff_ffff, immediate: 0x8000, tgei: true, tgeiu: false, tlti: false, tltiu: true, teqi: false, tnei: true },
  { rs: 0x0000_8000, immediate: 0x8000, tgei: true, tgeiu: false, tlti: false, tltiu: true, teqi: false, tnei: true },
  { rs: 0xffff_8000, immediate: 0x8000, tgei: true, tgeiu: true, tlti: false, tltiu: false, teqi: true, tnei: false },
  { rs: 0x8000_0000, immediate: 0x0000, tgei: false, tgeiu: true, tlti: true, tltiu: false, teqi: false, tnei: true },
  { rs: 0x0000_0000, immediate: 0x0001, tgei: false, tgeiu: false, tlti: true, tltiu: true, teqi: false, tnei: true }
];

describe('trap predicates', () => {
  it('decides the six register trap forms with the right signedness', () => {
    for (const row of registerTrapMatrix) {
      for (const handler of registerTrapHandlers) {
        const label = `${handler} rs=${hex(row.rs)} rt=${hex(row.rt)}`;
        expect(trapCondition(handler, row.rs, row.rt), label).toBe(row[handler]);
      }
    }
  });

  it('decides the six immediate trap forms on the sign-extended operand', () => {
    for (const row of immediateTrapMatrix) {
      for (const handler of immediateTrapHandlers) {
        const label = `${handler} rs=${hex(row.rs)}`
          + ` imm=0x${row.immediate.toString(16).padStart(4, '0')}`;
        expect(immediateTrapCondition(handler, row.rs, row.immediate), label).toBe(row[handler]);
      }
    }
  });

  it('keeps the register and immediate trap tables disjoint', () => {
    // transition.ts picks the table by handler id, so neither may answer for the
    // other's mnemonics.
    for (const handler of immediateTrapHandlers) {
      expect(trapCondition(handler, 1, 1), handler).toBeUndefined();
    }
    for (const handler of registerTrapHandlers) {
      expect(immediateTrapCondition(handler, 1, 1), handler).toBeUndefined();
    }
    for (const handler of ['add', 'beq', 'syscall', 'nop', '']) {
      expect(trapCondition(handler, 1, 1), handler).toBeUndefined();
      expect(immediateTrapCondition(handler, 1, 1), handler).toBeUndefined();
    }
  });
});

describe('end-to-end ALU commit values on P6', () => {
  it('commits the register arithmetic, logic and compare family', () => {
    //  $1 = 0x7fffffff, $2 = 0xffffffff, then one instruction per handler.
    const words = [
      op('lui', { rt: 1, immediate: 0x7fff }),
      op('ori', { rs: 1, rt: 1, immediate: 0xffff }),
      op('addi', { rs: 0, rt: 2, immediate: -1 }),
      op('add', { rd: 3, rs: 1, rt: 2 }),
      op('sub', { rd: 4, rs: 1, rt: 2 }),
      op('and', { rd: 5, rs: 1, rt: 2 }),
      op('or', { rd: 6, rs: 1, rt: 2 }),
      op('xor', { rd: 7, rs: 1, rt: 2 }),
      op('nor', { rd: 8, rs: 1, rt: 2 }),
      op('slt', { rd: 9, rs: 1, rt: 2 }),
      op('sltu', { rd: 10, rs: 1, rt: 2 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words, { layers: allLayers }));
    expect(gprWrites(trace)).toEqual([
      [1, 0x7fff_0000],
      [1, 0x7fff_ffff],
      [2, 0xffff_ffff],
      [3, 0x7fff_fffe],   // 0x7fffffff + (-1)
      [4, 0x8000_0000],   // 0x7fffffff - (-1) wraps; P6-1 说明不产生溢出异常
      [5, 0x7fff_ffff],
      [6, 0xffff_ffff],
      [7, 0x8000_0000],
      [8, 0x0000_0000],   // ~(0x7fffffff | 0xffffffff)
      [9, 0x0000_0000],   // signed: 0x7fffffff < -1 is false
      [10, 0x0000_0001]   // unsigned: 0x7fffffff < 0xffffffff is true
    ]);
    expect(trace.last.status).toBe('halted');
  });

  it('commits the shift family with the rs-masked variable amount', () => {
    //  $1 = 0x80000000, $2 = 36; 36 & 31 = 4, so the variable shifts move 4 bits.
    const words = [
      op('lui', { rt: 1, immediate: 0x8000 }),
      op('ori', { rs: 0, rt: 2, immediate: 36 }),
      op('sll', { rd: 3, rt: 1, shamt: 1 }),
      op('srl', { rd: 4, rt: 1, shamt: 4 }),
      op('sra', { rd: 5, rt: 1, shamt: 4 }),
      op('sllv', { rd: 6, rt: 1, rs: 2 }),
      op('srlv', { rd: 7, rt: 1, rs: 2 }),
      op('srav', { rd: 8, rt: 1, rs: 2 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words, { layers: allLayers }));
    expect(gprWrites(trace)).toEqual([
      [1, 0x8000_0000],
      [2, 36],
      [3, 0x0000_0000],
      [4, 0x0800_0000],   // logical: the sign bit becomes zero
      [5, 0xf800_0000],   // arithmetic: the sign bit is replicated
      [6, 0x0000_0000],
      [7, 0x0800_0000],
      [8, 0xf800_0000]
    ]);
    expect(trace.last.status).toBe('halted');
  });

  it('commits the immediate family including the slti/sltiu split', () => {
    const words = [
      op('addi', { rs: 0, rt: 1, immediate: -1 }),
      op('addiu', { rs: 1, rt: 2, immediate: 1 }),
      op('slti', { rs: 0, rt: 3, immediate: -1 }),
      op('sltiu', { rs: 0, rt: 4, immediate: -1 }),
      op('andi', { rs: 1, rt: 5, immediate: 0xffff }),
      op('ori', { rs: 0, rt: 6, immediate: 0xffff }),
      op('xori', { rs: 1, rt: 7, immediate: 0xffff }),
      op('lui', { rt: 8, immediate: 0x8000 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words, { layers: allLayers }));
    expect(gprWrites(trace)).toEqual([
      [1, 0xffff_ffff],
      [2, 0x0000_0000],   // 0xffffffff + 1 wraps on addiu
      [3, 0x0000_0000],   // slti: 0 < -1 is false
      [4, 0x0000_0001],   // sltiu: 0 < 0xffffffff is true, same immediate
      [5, 0x0000_ffff],   // andi zero-extends
      [6, 0x0000_ffff],   // ori zero-extends
      [7, 0xffff_0000],   // xori zero-extends
      [8, 0x8000_0000]
    ]);
    expect(trace.last.status).toBe('halted');
  });

  it('commits the count-leading family on both polarities', () => {
    const words = [
      op('lui', { rt: 1, immediate: 0x7fff }),
      op('ori', { rs: 1, rt: 1, immediate: 0xffff }),
      op('clz', { rd: 2, rs: 1 }),
      op('clo', { rd: 3, rs: 1 }),
      op('nor', { rd: 4, rs: 1, rt: 1 }),
      op('clz', { rd: 5, rs: 4 }),
      op('clo', { rd: 6, rs: 4 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words, { layers: allLayers }));
    expect(gprWrites(trace)).toEqual([
      [1, 0x7fff_0000],
      [1, 0x7fff_ffff],
      [2, 1],             // 0x7fffffff has one leading zero
      [3, 0],
      [4, 0x8000_0000],   // ~0x7fffffff
      [5, 0],
      [6, 1]              // 0x80000000 has one leading one
    ]);
    expect(trace.last.status).toBe('halted');
  });

  it('commits the branch family by the signed reading of the register', () => {
    //  0x3000 lui  $1, 0x8000   -> 0x80000000, negative
    //  0x3004 bgtz $1, +3       -> not taken; falls through to 0x300c
    //  0x3008 ori  $2, $0, 1    -> delay slot, runs either way
    //  0x300c blez $1, +3       -> taken; target 0x3010 + 3*4 = 0x301c
    //  0x3010 ori  $3, $0, 2    -> delay slot, runs
    //  0x3014 ori  $4, $0, 3    -> skipped
    //  0x3018 ori  $5, $0, 4    -> skipped
    //  0x301c halt sequence
    const words = [
      op('lui', { rt: 1, immediate: 0x8000 }),
      op('bgtz', { rs: 1, immediate: 3 }),
      op('ori', { rs: 0, rt: 2, immediate: 1 }),
      op('blez', { rs: 1, immediate: 3 }),
      op('ori', { rs: 0, rt: 3, immediate: 2 }),
      op('ori', { rs: 0, rt: 4, immediate: 3 }),
      op('ori', { rs: 0, rt: 5, immediate: 4 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words, { layers: allLayers }));
    // An unsigned reading of 0x80000000 would take bgtz and skip blez, so the
    // write list alone pins the signed comparison.
    expect(gprWrites(trace)).toEqual([[1, 0x8000_0000], [2, 1], [3, 2]]);
    const events = committedEvents(trace);
    expect(events.find((event) => event.mnemonic === 'bgtz')!.branchTaken).toBe(false);
    expect(events.find((event) => event.mnemonic === 'blez')!.branchTaken).toBe(true);
    expect(trace.last.status).toBe('halted');
  });
});

describe('overflow flag delivery through the executor', () => {
  it('turns the add/addi/sub flag into an Ov trap on P7', () => {
    // COURSE-P7-EXC-015 / P7-2-3 异常表: add, addi, sub raise Ov = ExcCode 12,
    // and the victim contributes no architectural write at all.
    const addiProgram = [
      op('lui', { rt: 1, immediate: 0x7fff }),
      op('ori', { rs: 1, rt: 1, immediate: 0xffff }),
      op('addi', { rs: 1, rt: 2, immediate: 1 })
    ];
    const addiTrace = runToCompletion(makeSession('P7', addiProgram), 3);
    const addiEvent = addiTrace.last.event!;
    expect(addiEvent.kind).toBe('exception');
    expect(addiEvent.trap!.name).toBe('ov');
    expect(addiEvent.trap!.code).toBe(12);
    expect(addiEvent.trap!.stage).toBe('execute');
    expect(addiEvent.trap!.victimPc).toBe(0x0000_3008);
    expect(addiEvent.trap!.branchDelay).toBe(false);
    expect(addiEvent.trap!.epc).toBe(0x0000_3008);
    expect(addiEvent.trap!.handlerPc).toBe(0x0000_4180);
    expect(addiEvent.gprWrites).toEqual([]);

    //  0 - 0x80000000 = +2^31, one above the representable maximum.
    const subProgram = [
      op('lui', { rt: 1, immediate: 0x8000 }),
      op('sub', { rd: 3, rs: 0, rt: 1 })
    ];
    const subTrace = runToCompletion(makeSession('P7', subProgram), 2);
    expect(subTrace.last.event!.trap!.name).toBe('ov');
    expect(subTrace.last.event!.trap!.epc).toBe(0x0000_3004);
    expect(subTrace.last.event!.gprWrites).toEqual([]);
  });

  it('commits the wrapped result for addiu on P7 and for add on P6', () => {
    const addiuProgram = [
      op('lui', { rt: 1, immediate: 0x7fff }),
      op('ori', { rs: 1, rt: 1, immediate: 0xffff }),
      op('addiu', { rs: 1, rt: 2, immediate: 1 })
    ];
    const addiuTrace = runToCompletion(makeSession('P7', addiuProgram), 3);
    expect(addiuTrace.last.event!.kind).toBe('instruction');
    expect(addiuTrace.last.event!.gprWrites).toEqual([{ register: 2, value: 0x8000_0000 }]);

    // COURSE-P6-ARITH-001: the same signed overflow simply wraps on P6.
    const p6Program = [
      op('lui', { rt: 1, immediate: 0x7fff }),
      op('ori', { rs: 1, rt: 1, immediate: 0xffff }),
      op('addi', { rs: 1, rt: 2, immediate: 1 }),
      ...haltSequence
    ];
    const p6Trace = runToCompletion(makeSession('P6', p6Program));
    expect(gprWrites(p6Trace).at(-1)).toEqual([2, 0x8000_0000]);
    expect(p6Trace.last.status).toBe('halted');
  });
});

describe('the zero register as ALU source and destination', () => {
  it('reads $0 as zero and drops every write that targets it', () => {
    const words = [
      op('ori', { rs: 0, rt: 1, immediate: 0xffff }),   // $0 reads 0 -> $1 = 0xffff
      op('ori', { rs: 1, rt: 0, immediate: 0xffff }),   // write to $0 is dropped
      op('add', { rd: 2, rs: 0, rt: 1 }),               // $0 still reads 0
      op('sub', { rd: 0, rs: 1, rt: 1 }),               // write to $0 is dropped
      op('sltu', { rd: 3, rs: 0, rt: 1 }),              // 0 < 0xffff unsigned
      op('nor', { rd: 4, rs: 0, rt: 0 }),               // ~(0 | 0)
      ...haltSequence
    ];
    const session = makeSession('P6', words, { layers: allLayers });
    const trace = runToCompletion(session);
    expect(gprWrites(trace)).toEqual([
      [1, 0x0000_ffff],
      [2, 0x0000_ffff],
      [3, 0x0000_0001],
      [4, 0xffff_ffff]
    ]);
    expect(session.snapshot().gpr[0]).toBe(0);
    expect(trace.last.status).toBe('halted');
  });

  it('records no write for a $0 destination even when the ALU produced a value', () => {
    // The GRF module never logs a `$0` write (TraceProjectionPolicy
    // .suppressZeroRegisterWrites), so the event must carry an empty list rather
    // than a suppressed-but-present entry.
    const words = [
      op('ori', { rs: 0, rt: 1, immediate: 0x1234 }),
      op('add', { rd: 0, rs: 1, rt: 1 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words, { layers: allLayers }));
    const added = committedEvents(trace).find((event) => event.mnemonic === 'add')!;
    expect(added.gprWrites).toEqual([]);
  });
});
