import { describe, expect, it } from 'vitest';
import {
  formatArchitecturalWrite,
  projectCommitEvent,
  projectCommitEvents
} from '../../mips/core/events/traceProjection';
import { multiplyDivide } from '../../mips/core/machine/semantics';
import { resolveCourseProfile } from '../../mips/core/profiles/courseProfiles';
import {
  committedEvents,
  gprWrites,
  haltSequence,
  makeSession,
  op,
  runToCompletion
} from './programFixtures';

/**
 * MDU architectural results and the HI/LO definedness policy.
 *
 * What this file pins, and where the expectations come from:
 *
 * - The instruction surface is the P6 required set
 *   (`cscore/markdown/P6/P6-1.md`: `mult, multu, div, divu, mfhi, mflo, mthi, mtlo`).
 *   `COURSE-P6-MDU-001` states that the 5/10-cycle MDU latency is a DUT timing
 *   property and *not* part of the ISA result, so only the 64-bit HI:LO value is
 *   an oracle obligation — that is exactly what is asserted here.
 * - Every 64-bit number below is hand-computed from the MIPS32 definitions
 *   (`mult/multu`: (HI,LO) = 64-bit product; `div/divu`: LO = quotient truncated
 *   toward zero, HI = remainder carrying the *dividend's* sign; `madd/msub`:
 *   (HI,LO) ± product) and written out in full in the case labels so the
 *   arithmetic can be re-checked without running anything.
 * - Reset leaves HI/LO architecturally undefined
 *   (`courseProfiles.ts` reset `hiLoDefined: false`, pinned by `courseProfiles.test.ts`).
 *   Reading them before a defining write, and `div/divu` by zero, are course
 *   undefined behaviour: `cscore/markdown/P5/testcases/P5-4-5.md` 未定义行为 table
 *   lists `0 DivZero`, and `MARS-DIV-UNDEFINED-001` records that MARS' own values
 *   for these inputs must never become golden. Hence `COURSE-P56-DOMAIN-001`:
 *   a strict lane fails closed instead of blessing an implementation's reset value.
 * - `mul` is the `marsCompatibility` layer instruction that MARS implements by
 *   *also* writing HI/LO ("Register 33 is HIGH and 34 is LOW. Not required by
 *   MIPS; SPIM does it." — `Mars-with-BUAA-CO-extension/mars/mips/instructions/
 *   InstructionSet.java`, the `mul $t1,$t2,$t3` simulate body). MIPS32 leaves them
 *   UNPREDICTABLE, so the course-side checker classifies `mul` as
 *   `invalidate-both` (`src/language/mips/traceParser.ts`); the execution core
 *   must agree.
 * - HI/LO are internal to the MDU and are never logged by the course GRF module
 *   (P7-2-6 "写入时无需 display"), so a multiply contributes no line to the
 *   architectural write trace.
 */

/** `mult/multu/div/divu` and `madd/maddu/msub/msubu` operate on the P6 required MDU. */
const marsLayers = ['required', 'commonExtensions', 'marsCompatibility'] as const;

interface MduCase {
  readonly label: string;
  readonly handler: string;
  readonly rs: number;
  readonly rt: number;
  /** Incoming HI:LO; only the accumulate handlers read it. */
  readonly seedHi: number;
  readonly seedLo: number;
  readonly hi: number;
  readonly lo: number;
}

describe('multiply and divide unit results', () => {
  const multiplyCases: readonly MduCase[] = [
    {
      // (-100000) * (-100000) = +10_000_000_000 = 0x2_540B_E400.
      label: 'mult of two negatives',
      handler: 'mult', rs: 0xfffe_7960, rt: 0xfffe_7960,
      seedHi: 0, seedLo: 0, hi: 0x0000_0002, lo: 0x540b_e400
    },
    {
      // (-2^31) * (-2^31) = +2^62 = 0x4000_0000_0000_0000.
      label: 'mult of 0x80000000 by 0x80000000',
      handler: 'mult', rs: 0x8000_0000, rt: 0x8000_0000,
      seedHi: 0, seedLo: 0, hi: 0x4000_0000, lo: 0x0000_0000
    },
    {
      // (2^31 - 1)^2 = 2^62 - 2^32 + 1 = 0x3FFF_FFFF_0000_0001.
      label: 'mult of the largest positive by itself',
      handler: 'mult', rs: 0x7fff_ffff, rt: 0x7fff_ffff,
      seedHi: 0, seedLo: 0, hi: 0x3fff_ffff, lo: 0x0000_0001
    },
    {
      // (-1) * 2 = -2, sign-extended across the full 64 bits.
      label: 'mult sign-extends a negative product into HI',
      handler: 'mult', rs: 0xffff_ffff, rt: 0x0000_0002,
      seedHi: 0, seedLo: 0, hi: 0xffff_ffff, lo: 0xffff_fffe
    },
    {
      // 4294967295 * 4294967295 = 2^64 - 2^33 + 1 = 0xFFFF_FFFE_0000_0001.
      label: 'multu of 0xffffffff by 0xffffffff',
      handler: 'multu', rs: 0xffff_ffff, rt: 0xffff_ffff,
      seedHi: 0, seedLo: 0, hi: 0xffff_fffe, lo: 0x0000_0001
    },
    {
      // Same bit patterns as the signed case above: 4294967295 * 2 = 0x1_FFFF_FFFE.
      label: 'multu zero-extends the same operands the signed case sign-extends',
      handler: 'multu', rs: 0xffff_ffff, rt: 0x0000_0002,
      seedHi: 0, seedLo: 0, hi: 0x0000_0001, lo: 0xffff_fffe
    },
    {
      // 2^31 * 2^31 = 2^62; here the signed and unsigned readings coincide.
      label: 'multu of 0x80000000 by 0x80000000',
      handler: 'multu', rs: 0x8000_0000, rt: 0x8000_0000,
      seedHi: 0, seedLo: 0, hi: 0x4000_0000, lo: 0x0000_0000
    }
  ];

  it('computes the 64-bit product for mult and multu', () => {
    for (const item of multiplyCases) {
      expect(multiplyDivide(item.handler, item.rs, item.rt, item.seedHi, item.seedLo), item.label)
        .toEqual({ hi: item.hi, lo: item.lo });
    }
  });

  const divideCases: readonly MduCase[] = [
    {
      // -7 / 2 truncates toward zero to -3; the remainder takes the dividend's sign.
      label: 'div of a negative dividend by a positive divisor',
      handler: 'div', rs: 0xffff_fff9, rt: 0x0000_0002,
      seedHi: 0, seedLo: 0, hi: 0xffff_ffff, lo: 0xffff_fffd
    },
    {
      // 7 / -2 = -3 remainder +1: the remainder follows the dividend, not the divisor.
      label: 'div of a positive dividend by a negative divisor',
      handler: 'div', rs: 0x0000_0007, rt: 0xffff_fffe,
      seedHi: 0, seedLo: 0, hi: 0x0000_0001, lo: 0xffff_fffd
    },
    {
      // -7 / -2 = +3 remainder -1.
      label: 'div of two negatives',
      handler: 'div', rs: 0xffff_fff9, rt: 0xffff_fffe,
      seedHi: 0, seedLo: 0, hi: 0xffff_ffff, lo: 0x0000_0003
    },
    {
      // MIPS32 DIV: "No arithmetic exception occurs under any circumstances."
      // -2^31 / -1 is not representable in 32 bits, so the truncated quotient
      // wraps back to 0x80000000 and the remainder is 0. MARS computes exactly
      // this (Java `int` division, InstructionSet.java `div $t1,$t2`).
      label: 'div of 0x80000000 by -1',
      handler: 'div', rs: 0x8000_0000, rt: 0xffff_ffff,
      seedHi: 0, seedLo: 0, hi: 0x0000_0000, lo: 0x8000_0000
    },
    {
      // -2147483648 / 3 = -715827882 remainder -2 (0xD555_5556, 0xFFFF_FFFE).
      label: 'div of 0x80000000 by 3',
      handler: 'div', rs: 0x8000_0000, rt: 0x0000_0003,
      seedHi: 0, seedLo: 0, hi: 0xffff_fffe, lo: 0xd555_5556
    },
    {
      // 4294967295 / 16 = 268435455 remainder 15.
      label: 'divu of 0xffffffff by 16',
      handler: 'divu', rs: 0xffff_ffff, rt: 0x0000_0010,
      seedHi: 0, seedLo: 0, hi: 0x0000_000f, lo: 0x0fff_ffff
    },
    {
      // 4294967295 / 4294967294 = 1 remainder 1 unsigned...
      label: 'divu of two large unsigned values',
      handler: 'divu', rs: 0xffff_ffff, rt: 0xffff_fffe,
      seedHi: 0, seedLo: 0, hi: 0x0000_0001, lo: 0x0000_0001
    },
    {
      // ...while the same bit patterns read as -1 / -2 = 0 remainder -1.
      label: 'div of the same two large values read as signed',
      handler: 'div', rs: 0xffff_ffff, rt: 0xffff_fffe,
      seedHi: 0, seedLo: 0, hi: 0xffff_ffff, lo: 0x0000_0000
    },
    {
      // 2147483648 / 3 = 715827882 remainder 2 (0x2AAA_AAAA, 2).
      label: 'divu of 0x80000000 by 3',
      handler: 'divu', rs: 0x8000_0000, rt: 0x0000_0003,
      seedHi: 0, seedLo: 0, hi: 0x0000_0002, lo: 0x2aaa_aaaa
    }
  ];

  it('puts the quotient in LO and the dividend-signed remainder in HI', () => {
    for (const item of divideCases) {
      expect(multiplyDivide(item.handler, item.rs, item.rt, item.seedHi, item.seedLo), item.label)
        .toEqual({ hi: item.hi, lo: item.lo });
    }
  });

  const accumulateCases: readonly MduCase[] = [
    {
      // HI:LO = 10, + 3*4 = 22.
      label: 'madd adds the product onto HI:LO',
      handler: 'madd', rs: 3, rt: 4,
      seedHi: 0x0000_0000, seedLo: 0x0000_000a, hi: 0x0000_0000, lo: 0x0000_0016
    },
    {
      // 0x0000_0000_FFFF_FFFF + 1 carries into HI.
      label: 'madd carries out of LO into HI',
      handler: 'madd', rs: 1, rt: 1,
      seedHi: 0x0000_0000, seedLo: 0xffff_ffff, hi: 0x0000_0001, lo: 0x0000_0000
    },
    {
      // 0 + (-1) = -1 over the full 64 bits.
      label: 'madd treats the accumulator as signed',
      handler: 'madd', rs: 0xffff_ffff, rt: 1,
      seedHi: 0x0000_0000, seedLo: 0x0000_0000, hi: 0xffff_ffff, lo: 0xffff_ffff
    },
    {
      // HI:LO = 0xC000_0000_0000_0000 = -2^62; + (-2^31)*(-2^31) = +2^62 = 0.
      label: 'madd of a negative accumulator and a positive product',
      handler: 'madd', rs: 0x8000_0000, rt: 0x8000_0000,
      seedHi: 0xc000_0000, seedLo: 0x0000_0000, hi: 0x0000_0000, lo: 0x0000_0000
    },
    {
      // 0 + 0xFFFF_FFFF: unsigned, so nothing sign-extends into HI.
      label: 'maddu treats the same operands as unsigned',
      handler: 'maddu', rs: 0xffff_ffff, rt: 1,
      seedHi: 0x0000_0000, seedLo: 0x0000_0000, hi: 0x0000_0000, lo: 0xffff_ffff
    },
    {
      // 0xFFFF_FFFF_FFFF_FFFF + 1 wraps the whole 64-bit accumulator to zero.
      label: 'maddu wraps modulo 2^64',
      handler: 'maddu', rs: 1, rt: 1,
      seedHi: 0xffff_ffff, seedLo: 0xffff_ffff, hi: 0x0000_0000, lo: 0x0000_0000
    },
    {
      // 1 + 0xFFFF_FFFE_0000_0001 = 0xFFFF_FFFE_0000_0002.
      label: 'maddu accumulates the full unsigned product',
      handler: 'maddu', rs: 0xffff_ffff, rt: 0xffff_ffff,
      seedHi: 0x0000_0000, seedLo: 0x0000_0001, hi: 0xffff_fffe, lo: 0x0000_0002
    },
    {
      // HI:LO = 30, - 3*4 = 18.
      label: 'msub subtracts the product from HI:LO',
      handler: 'msub', rs: 3, rt: 4,
      seedHi: 0x0000_0000, seedLo: 0x0000_001e, hi: 0x0000_0000, lo: 0x0000_0012
    },
    {
      // 0x0000_0001_0000_0000 - 1 borrows out of HI.
      label: 'msub borrows from HI into LO',
      handler: 'msub', rs: 1, rt: 1,
      seedHi: 0x0000_0001, seedLo: 0x0000_0000, hi: 0x0000_0000, lo: 0xffff_ffff
    },
    {
      // 0 - (-2 * 3) = +6.
      label: 'msub subtracts a negative product',
      handler: 'msub', rs: 0xffff_fffe, rt: 3,
      seedHi: 0x0000_0000, seedLo: 0x0000_0000, hi: 0x0000_0000, lo: 0x0000_0006
    },
    {
      // 0 - (-1) = +1 signed...
      label: 'msub of 0xffffffff by 1 read as signed',
      handler: 'msub', rs: 0xffff_ffff, rt: 1,
      seedHi: 0x0000_0000, seedLo: 0x0000_0000, hi: 0x0000_0000, lo: 0x0000_0001
    },
    {
      // ...while unsigned it is 0 - 0xFFFF_FFFF = 2^64 - 2^32 + 1.
      label: 'msubu of 0xffffffff by 1 read as unsigned',
      handler: 'msubu', rs: 0xffff_ffff, rt: 1,
      seedHi: 0x0000_0000, seedLo: 0x0000_0000, hi: 0xffff_ffff, lo: 0x0000_0001
    },
    {
      // 0 - 1 wraps to the all-ones 64-bit accumulator.
      label: 'msubu wraps modulo 2^64',
      handler: 'msubu', rs: 1, rt: 1,
      seedHi: 0x0000_0000, seedLo: 0x0000_0000, hi: 0xffff_ffff, lo: 0xffff_ffff
    }
  ];

  it('accumulates onto the incoming HI:LO for madd, maddu, msub and msubu', () => {
    for (const item of accumulateCases) {
      expect(multiplyDivide(item.handler, item.rs, item.rt, item.seedHi, item.seedLo), item.label)
        .toEqual({ hi: item.hi, lo: item.lo });
    }
  });

  it('ignores the incoming HI:LO for the non-accumulating handlers', () => {
    for (const handler of ['mult', 'multu', 'div', 'divu']) {
      const seeded = multiplyDivide(handler, 12, 3, 0xdead_beef, 0xcafe_f00d);
      const clean = multiplyDivide(handler, 12, 3, 0, 0);
      expect(seeded, handler).toEqual(clean);
    }
    // 12 * 3 = 36; 12 / 3 = 4 remainder 0.
    expect(multiplyDivide('mult', 12, 3, 0xdead_beef, 0xcafe_f00d))
      .toEqual({ hi: 0x0000_0000, lo: 0x0000_0024 });
    expect(multiplyDivide('div', 12, 3, 0xdead_beef, 0xcafe_f00d))
      .toEqual({ hi: 0x0000_0000, lo: 0x0000_0004 });
  });

  it('returns undefined for handlers that do not belong to the MDU', () => {
    // `mul` writes a GPR and leaves HI/LO UNPREDICTABLE, so it is deliberately
    // not an MDU HI:LO producer; `add` never touches the MDU at all.
    for (const handler of ['mul', 'add', 'mfhi', 'mthi']) {
      expect(multiplyDivide(handler, 3, 4, 0, 0), handler).toBeUndefined();
    }
  });
});

describe('P6 multiply, divide and HI/LO transfer instructions', () => {
  //  0x3000 lui  $1, 0x1234
  //  0x3004 ori  $1, $1, 0x5678   -> $1 = 0x12345678
  //  0x3008 ori  $2, $0, 0x0010   -> $2 = 0x00000010
  //  0x300c mult $1, $2           -> HI:LO = 0x12345678 * 16 = 0x1_23456780
  //  0x3010 mfhi $3               -> 0x00000001
  //  0x3014 mflo $4               -> 0x23456780
  const multiplyProgram = [
    op('lui', { rt: 1, immediate: 0x1234 }),
    op('ori', { rs: 1, rt: 1, immediate: 0x5678 }),
    op('ori', { rs: 0, rt: 2, immediate: 0x0010 }),
    op('mult', { rs: 1, rt: 2 }),
    op('mfhi', { rd: 3 }),
    op('mflo', { rd: 4 }),
    ...haltSequence
  ];

  it('moves the multiply result out of HI and LO into general registers', () => {
    const session = makeSession('P6', multiplyProgram);
    const trace = runToCompletion(session);
    expect(gprWrites(trace)).toEqual([
      [1, 0x1234_0000],
      [1, 0x1234_5678],
      [2, 0x0000_0010],
      [3, 0x0000_0001],
      [4, 0x2345_6780]
    ]);
    expect(trace.last.status).toBe('halted');
    const snapshot = session.snapshot();
    expect(snapshot.hi).toBe(0x0000_0001);
    expect(snapshot.lo).toBe(0x2345_6780);
    expect(snapshot.hiDefined).toBe(true);
    expect(snapshot.loDefined).toBe(true);
  });

  it('round-trips mthi and mtlo through mfhi and mflo', () => {
    //  0x3000/0x3004 build $1 = 0xdeadbeef, 0x3008/0x300c build $2 = 0xcafef00d.
    const words = [
      op('lui', { rt: 1, immediate: 0xdead }),
      op('ori', { rs: 1, rt: 1, immediate: 0xbeef }),
      op('lui', { rt: 2, immediate: 0xcafe }),
      op('ori', { rs: 2, rt: 2, immediate: 0xf00d }),
      op('mthi', { rs: 1 }),
      op('mtlo', { rs: 2 }),
      op('mfhi', { rd: 3 }),
      op('mflo', { rd: 4 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words));
    expect(gprWrites(trace)).toEqual([
      [1, 0xdead_0000],
      [1, 0xdead_beef],
      [2, 0xcafe_0000],
      [2, 0xcafe_f00d],
      [3, 0xdead_beef],
      [4, 0xcafe_f00d]
    ]);
    const transfers = committedEvents(trace)
      .filter((event) => event.mnemonic === 'mthi' || event.mnemonic === 'mtlo');
    expect(transfers.map((event) => event.hiLoWrites)).toEqual([
      [{ register: 'hi', value: 0xdead_beef }],
      [{ register: 'lo', value: 0xcafe_f00d }]
    ]);
    // mthi/mtlo consume a GPR but produce no GPR write of their own.
    expect(transfers.every((event) => event.gprWrites.length === 0)).toBe(true);
  });

  it('carries both HI and LO on the multiply commit event and logs neither', () => {
    const profile = resolveCourseProfile('P6');
    const trace = runToCompletion(makeSession('P6', multiplyProgram));
    const multiply = committedEvents(trace).find((event) => event.mnemonic === 'mult')!;

    expect(multiply.pcBefore).toBe(0x0000_300c);
    expect(multiply.hiLoWrites).toEqual([
      { register: 'hi', value: 0x0000_0001 },
      { register: 'lo', value: 0x2345_6780 }
    ]);
    expect(multiply.gprWrites).toEqual([]);
    expect(multiply.memoryWrites).toEqual([]);
    // P7-2-6: HI/LO are internal to the MDU and are never displayed by the GRF module.
    expect(projectCommitEvent(multiply, profile)).toEqual([]);

    // The whole run projects to exactly the five GRF writes and nothing else.
    expect(projectCommitEvents(trace.events, profile).map((record) => formatArchitecturalWrite(record)))
      .toEqual([
        '@00003000: $1 <= 12340000',
        '@00003004: $1 <= 12345678',
        '@00003008: $2 <= 00000010',
        '@00003010: $3 <= 00000001',
        '@00003014: $4 <= 23456780'
      ]);
  });
});

describe('undefined HI/LO read policy', () => {
  it('stops the run when mfhi precedes any defining write', () => {
    const trace = runToCompletion(makeSession('P6', [op('mfhi', { rd: 3 }), ...haltSequence]));
    expect(trace.last.status).toBe('out-of-domain');
    expect(trace.last.diagnostic?.reason).toBe('undefined-hi-lo-read');
    expect(trace.last.diagnostic?.code).toBe('mips-core.exec.undefined-hi-lo-read');
    expect(trace.last.diagnostic?.pc).toBe(0x0000_3000);
    expect(trace.last.diagnostic?.contractId).toBe('COURSE-P56-DOMAIN-001');
    // Nothing committed: the victim leaves no partial GPR write behind.
    expect(committedEvents(trace)).toEqual([]);
    expect(gprWrites(trace)).toEqual([]);
  });

  it('stops the run when mflo precedes any defining write', () => {
    const trace = runToCompletion(makeSession('P6', [op('mflo', { rd: 4 }), ...haltSequence]));
    expect(trace.last.status).toBe('out-of-domain');
    expect(trace.last.diagnostic?.reason).toBe('undefined-hi-lo-read');
    expect(trace.last.diagnostic?.pc).toBe(0x0000_3000);
  });

  it('keeps running under the deterministic policy and marks the write undefined', () => {
    const words = [op('mfhi', { rd: 3 }), op('mflo', { rd: 4 }), ...haltSequence];
    const session = makeSession('P6', words, { undefinedBehavior: 'deterministic' });
    const trace = runToCompletion(session);

    expect(trace.last.status).toBe('halted');
    const [move, moveLow] = committedEvents(trace);
    // The reset value is 0, but it is explicitly flagged as not architecturally defined.
    expect(move.gprWrites).toEqual([{ register: 3, value: 0, defined: false }]);
    expect(moveLow.gprWrites).toEqual([{ register: 4, value: 0, defined: false }]);
    // Reading does not define HI/LO, so the snapshot still excludes them.
    expect(session.snapshot().hiDefined).toBe(false);
    expect(session.snapshot().loDefined).toBe(false);
  });

  it('defines only HI on mthi and leaves LO out of the comparable domain', () => {
    //  0x3000 ori $1,$0,42 / 0x3004 mthi $1 / 0x3008 mfhi $3 / 0x300c mflo $4
    const words = [
      op('ori', { rs: 0, rt: 1, immediate: 42 }),
      op('mthi', { rs: 1 }),
      op('mfhi', { rd: 3 }),
      op('mflo', { rd: 4 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words));
    expect(gprWrites(trace)).toEqual([[1, 42], [3, 42]]);
    expect(trace.last.status).toBe('out-of-domain');
    expect(trace.last.diagnostic?.reason).toBe('undefined-hi-lo-read');
    expect(trace.last.diagnostic?.pc).toBe(0x0000_300c);
  });
});

describe('divide by zero domain policy', () => {
  //  0x3000 ori  $1,$0,12 / 0x3004 ori $2,$0,3 / 0x3008 mult $1,$2 -> HI:LO = 36
  //  0x300c div  $1,$0    (the divisor register is $0, so it is always zero)
  //  0x3010 mfhi $3
  const divideByZeroProgram = [
    op('ori', { rs: 0, rt: 1, immediate: 12 }),
    op('ori', { rs: 0, rt: 2, immediate: 3 }),
    op('mult', { rs: 1, rt: 2 }),
    op('div', { rs: 1, rt: 0 }),
    op('mfhi', { rd: 3 }),
    ...haltSequence
  ];

  it('stops the run on a zero divisor even after HI/LO were defined', () => {
    // P5-4-5 未定义行为 0 = DivZero; MARS-DIV-UNDEFINED-001 forbids adopting MARS' result.
    const trace = runToCompletion(makeSession('P6', divideByZeroProgram));
    expect(trace.last.status).toBe('out-of-domain');
    expect(trace.last.diagnostic?.reason).toBe('divide-by-zero');
    expect(trace.last.diagnostic?.code).toBe('mips-core.exec.divide-by-zero');
    expect(trace.last.diagnostic?.pc).toBe(0x0000_300c);
    expect(trace.last.diagnostic?.contractId).toBe('COURSE-P56-DOMAIN-001');
    expect(gprWrites(trace)).toEqual([[1, 12], [2, 3]]);
  });

  it('stops the run on a zero divisor for divu as well', () => {
    const words = [op('divu', { rs: 0, rt: 0 }), ...haltSequence];
    const trace = runToCompletion(makeSession('P6', words));
    expect(trace.last.status).toBe('out-of-domain');
    expect(trace.last.diagnostic?.reason).toBe('divide-by-zero');
  });

  it('poisons HI and LO under the deterministic policy and taints a later mfhi', () => {
    const session = makeSession('P6', divideByZeroProgram, { undefinedBehavior: 'deterministic' });
    const trace = runToCompletion(session);
    expect(trace.last.status).toBe('halted');

    const events = committedEvents(trace);
    const multiply = events.find((event) => event.mnemonic === 'mult')!;
    const divide = events.find((event) => event.mnemonic === 'div')!;
    const move = events.find((event) => event.mnemonic === 'mfhi')!;

    // 12 * 3 = 36 is a well-defined result...
    expect(multiply.hiLoWrites).toEqual([
      { register: 'hi', value: 0x0000_0000 },
      { register: 'lo', value: 0x0000_0024 }
    ]);
    // ...and the zero divisor then takes both halves back out of the domain.
    expect(divide.hiLoWrites).toEqual([
      { register: 'hi', value: 0, defined: false },
      { register: 'lo', value: 0, defined: false }
    ]);
    expect(move.gprWrites).toEqual([{ register: 3, value: 0, defined: false }]);
    expect(session.snapshot().hiDefined).toBe(false);
    expect(session.snapshot().loDefined).toBe(false);
  });
});

describe('mars-layer mul HI/LO invalidation', () => {
  //  0x3000 ori $1,$0,6 / 0x3004 ori $2,$0,7
  //  0x3008 mult $1,$2   -> HI:LO = 0:42, both defined
  //  0x300c mflo $5      -> 42, proving LO was readable before mul
  //  0x3010 mul  $3,$1,$2-> $3 = 42, HI/LO become UNPREDICTABLE
  //  0x3014 mfhi $4      -> must now be rejected
  const mulProgram = [
    op('ori', { rs: 0, rt: 1, immediate: 6 }),
    op('ori', { rs: 0, rt: 2, immediate: 7 }),
    op('mult', { rs: 1, rt: 2 }),
    op('mflo', { rd: 5 }),
    op('mul', { rd: 3, rs: 1, rt: 2 }),
    op('mfhi', { rd: 4 }),
    ...haltSequence
  ];

  it('writes only the GPR destination and never HI or LO', () => {
    const session = makeSession('P6', mulProgram, { layers: marsLayers });
    const trace = runToCompletion(session);
    const multiplyToGpr = committedEvents(trace).find((event) => event.mnemonic === 'mul')!;

    expect(multiplyToGpr.pcBefore).toBe(0x0000_3010);
    // 6 * 7 = 42, low 32 bits only.
    expect(multiplyToGpr.gprWrites).toEqual([{ register: 3, value: 42 }]);
    expect(multiplyToGpr.hiLoWrites).toEqual([]);
  });

  it('invalidates HI and LO so a later mfhi leaves the comparable domain', () => {
    const session = makeSession('P6', mulProgram, { layers: marsLayers });
    const trace = runToCompletion(session);

    expect(gprWrites(trace)).toEqual([[1, 6], [2, 7], [5, 42], [3, 42]]);
    expect(trace.last.status).toBe('out-of-domain');
    expect(trace.last.diagnostic?.reason).toBe('undefined-hi-lo-read');
    expect(trace.last.diagnostic?.pc).toBe(0x0000_3014);
    // MARS would answer 0 here because it mirrors the product into HI/LO;
    // the course checker classifies `mul` as `invalidate-both` instead.
    expect(session.snapshot().hiDefined).toBe(false);
    expect(session.snapshot().loDefined).toBe(false);
  });
});

describe('mars-layer multiply accumulate', () => {
  it('accumulates madd onto HI:LO and msub back off it', () => {
    //  0x3008 mult $1,$2 -> 12, 0x300c madd $1,$2 -> 24, 0x3010 msub $1,$2 -> 12
    const words = [
      op('ori', { rs: 0, rt: 1, immediate: 3 }),
      op('ori', { rs: 0, rt: 2, immediate: 4 }),
      op('mult', { rs: 1, rt: 2 }),
      op('madd', { rs: 1, rt: 2 }),
      op('msub', { rs: 1, rt: 2 }),
      op('mflo', { rd: 3 }),
      op('mfhi', { rd: 4 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words, { layers: marsLayers }));
    expect(gprWrites(trace)).toEqual([[1, 3], [2, 4], [3, 12], [4, 0]]);
    const accumulators = committedEvents(trace)
      .filter((event) => event.mnemonic === 'madd' || event.mnemonic === 'msub');
    expect(accumulators.map((event) => event.hiLoWrites)).toEqual([
      [{ register: 'hi', value: 0 }, { register: 'lo', value: 24 }],
      [{ register: 'hi', value: 0 }, { register: 'lo', value: 12 }]
    ]);
  });

  it('carries the accumulate out of LO into HI', () => {
    //  HI:LO is seeded to 0x00000000_FFFFFFFF through mthi/mtlo, then madd $1,$1
    //  with $1 = 1 must produce 0x00000001_00000000.
    const words = [
      op('ori', { rs: 0, rt: 1, immediate: 1 }),
      op('lui', { rt: 2, immediate: 0xffff }),
      op('ori', { rs: 2, rt: 2, immediate: 0xffff }),
      op('mthi', { rs: 0 }),
      op('mtlo', { rs: 2 }),
      op('madd', { rs: 1, rt: 1 }),
      op('mfhi', { rd: 3 }),
      op('mflo', { rd: 4 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words, { layers: marsLayers }));
    expect(gprWrites(trace)).toEqual([
      [1, 1],
      [2, 0xffff_0000],
      [2, 0xffff_ffff],
      [3, 0x0000_0001],
      [4, 0x0000_0000]
    ]);
  });

  it('rejects madd before HI and LO are both defined', () => {
    const words = [
      op('ori', { rs: 0, rt: 1, immediate: 3 }),
      op('madd', { rs: 1, rt: 1 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words, { layers: marsLayers }));
    expect(trace.last.status).toBe('out-of-domain');
    expect(trace.last.diagnostic?.reason).toBe('undefined-hi-lo-read');
    expect(trace.last.diagnostic?.pc).toBe(0x0000_3004);
    expect(trace.last.diagnostic?.contractId).toBe('COURSE-P56-DOMAIN-001');
  });

  it('rejects msub when only HI has been defined', () => {
    // mthi defines HI alone; the accumulate reads both halves, so it still fails.
    const words = [
      op('mthi', { rs: 0 }),
      op('msub', { rs: 0, rt: 0 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words, { layers: marsLayers }));
    expect(trace.last.status).toBe('out-of-domain');
    expect(trace.last.diagnostic?.reason).toBe('undefined-hi-lo-read');
    expect(trace.last.diagnostic?.pc).toBe(0x0000_3004);
  });

  it('marks the accumulate result undefined under the deterministic policy', () => {
    const words = [
      op('ori', { rs: 0, rt: 1, immediate: 3 }),
      op('madd', { rs: 1, rt: 1 }),
      ...haltSequence
    ];
    const session = makeSession('P6', words, {
      layers: marsLayers,
      undefinedBehavior: 'deterministic'
    });
    const trace = runToCompletion(session);
    expect(trace.last.status).toBe('halted');
    const accumulate = committedEvents(trace).find((event) => event.mnemonic === 'madd')!;
    // The reset accumulator is 0, so 0 + 3*3 = 9 is computed deterministically but
    // never blessed as an architectural value.
    expect(accumulate.hiLoWrites).toEqual([
      { register: 'hi', value: 0, defined: false },
      { register: 'lo', value: 9, defined: false }
    ]);
    expect(session.snapshot().hiDefined).toBe(false);
  });
});
