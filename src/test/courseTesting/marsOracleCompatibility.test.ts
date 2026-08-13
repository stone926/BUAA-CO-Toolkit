import { describe, expect, it } from 'vitest';
import {
  courseMarsOracleCompatibilityError,
  machineCodeNeedsMarsOracleCompatibilityTrace,
  stableMarsCourseAddressError,
  stableMarsP7UnobservableResetReadError
} from '../../courseTesting/marsOracleCompatibility';

function iType(opcode: number, rs: number, rt: number, immediate: number): number {
  return ((opcode << 26) | (rs << 21) | (rt << 16) | (immediate & 0xffff)) >>> 0;
}

function coL2Block(pc: number, word: number, registerWrite?: [number, number]): string[] {
  const hexWord = word.toString(16).padStart(8, '0');
  const lines = [`@PC${pc.toString(16).padStart(8, '0')} -> instruction (${hexWord})`];
  if (registerWrite) {
    lines.push(`\t\t$${registerWrite[0]} <= ${registerWrite[1].toString(16).padStart(8, '0')}`);
  }
  return lines;
}

describe('stable MARS course-oracle compatibility', () => {
  it('rejects dynamically executed $gp/$sp reads before an explicit write', () => {
    expect(courseMarsOracleCompatibilityError(
      'P3',
      '13800001\n', // beq $gp,$0,+1
      '@PC00003000 -> beq $gp, $0, 1 (13800001)\n',
      false
    )).toContain('$gp/$28');
    expect(courseMarsOracleCompatibilityError(
      'P6',
      '37bd0000\n', // ori $sp,$sp,0
      '@PC00003000 -> ori $sp, $sp, 0 (37bd0000)\n\t\t$29 <= 00002ffc\n',
      true
    )).toContain('$sp/$29');
  });

  it('accepts an explicit zero-based initialization and ignores unexecuted ordinary reads', () => {
    expect(courseMarsOracleCompatibilityError(
      'P3',
      '341c0000\n03800821\n',
      [
        '@PC00003000 -> ori $gp, $0, 0 (341c0000)',
        '\t\t$28 <= 00000000',
        '@PC00003004 -> addu $1, $gp, $0 (03800821)',
        '\t\t$ 1 <= 00000000'
      ].join('\n'),
      false
    )).toBeUndefined();
    expect(courseMarsOracleCompatibilityError(
      'P3',
      '03800821\n1000ffff\n',
      '@PC00003004 -> beq $0, $0, -1 (1000ffff)\n',
      false
    )).toBeUndefined();
  });

  it('statically covers P7 faulting reads which stable coL2 omits', () => {
    expect(stableMarsP7UnobservableResetReadError('8fa10004\n')).toContain('$sp/$29'); // lw $1,4($sp)
    expect(stableMarsP7UnobservableResetReadError('03820820\n')).toContain('$gp/$28'); // add $1,$gp,$2
  });

  it('accepts P7 fault candidates only after a definite entry-prefix initialization', () => {
    expect(stableMarsP7UnobservableResetReadError('341d0000\n8fa10004\n')).toBeUndefined();
    expect(stableMarsP7UnobservableResetReadError('341c0000\n03820820\n')).toBeUndefined();

    // A write in a branch delay slot is not accepted as a general dominance proof.
    expect(stableMarsP7UnobservableResetReadError(
      '10000001\n341d0000\n8fa10004\n'
    )).toContain('$sp/$29');
  });

  it('uses coL2 GPR writes to reject a dynamically addressed Mars-only segment', () => {
    const oriBase = iType(0x0d, 0, 1, 0x8000); // ori $1,$0,0x8000
    const load = iType(0x23, 1, 2, 0); // lw $2,0($1)
    const trace = [
      ...coL2Block(0x3000, oriBase, [1, 0x8000]),
      ...coL2Block(0x3004, load, [2, 0])
    ].join('\n');

    for (const profile of ['P3', 'P6', 'P7'] as const) {
      const error = courseMarsOracleCompatibilityError(
        profile,
        `${oriBase.toString(16).padStart(8, '0')}\n${load.toString(16).padStart(8, '0')}\n`,
        trace,
        profile !== 'P3'
      );
      expect(error).toContain('0x00008000');
      expect(error).toContain('课程硬件不存在的内存段');
    }
  });

  it('rejects signed effective-address overflow reconstructed from prior writes', () => {
    const lui = iType(0x0f, 0, 1, 0x7fff);
    const ori = iType(0x0d, 1, 1, 0xffff);
    const load = iType(0x23, 1, 2, 1);
    const trace = [
      ...coL2Block(0x3000, lui, [1, 0x7fff0000]),
      ...coL2Block(0x3004, ori, [1, 0x7fffffff]),
      ...coL2Block(0x3008, load)
    ].join('\n');

    expect(stableMarsCourseAddressError('P6', trace)).toContain('32 位有符号溢出');
    expect(stableMarsCourseAddressError('P6', trace)).toContain('$1=0x7fffffff');
  });

  it('uses an actual REGIMM link write before checking a delay-slot address', () => {
    const bltzalTaken = iType(0x01, 1, 0x10, 1);
    const loadFromZeroViaLink = iType(0x23, 31, 2, -0x3008);
    const trace = [
      ...coL2Block(0x3000, bltzalTaken, [31, 0x3008]),
      ...coL2Block(0x3004, loadFromZeroViaLink, [2, 0])
    ].join('\n');

    expect(stableMarsCourseAddressError('P6', trace)).toBeUndefined();
  });

  it('accepts complete byte/half/word and partial-word spans at both DM boundaries', () => {
    const accesses = [
      iType(0x20, 0, 2, 0x2fff), // lb, one byte at the upper boundary
      iType(0x21, 0, 2, 0x2ffe), // lh, through 0x2fff
      iType(0x23, 0, 2, 0x2ffc), // lw, through 0x2fff
      iType(0x22, 0, 2, 0x2fff), // lwl, down through the aligned word base
      iType(0x26, 0, 2, 0x2fff), // lwr, one byte at the upper boundary
      iType(0x28, 0, 2, 0), // sb at the lower boundary
      iType(0x29, 0, 2, 0), // sh at the lower boundary
      iType(0x2b, 0, 2, 0), // sw at the lower boundary
      iType(0x2a, 0, 2, 3), // swl, down through address zero
      iType(0x2e, 0, 2, 0) // swr, up through address three
    ];
    const trace = accesses.flatMap((word, index) => coL2Block(0x3000 + index * 4, word)).join('\n');

    expect(stableMarsCourseAddressError('P6', trace)).toBeUndefined();
  });

  it('computes the directional span for LWL/SWL and LWR/SWR', () => {
    const leftBelowZero = iType(0x22, 0, 2, -1);
    const rightAboveDm = iType(0x2e, 0, 2, 0x3000);

    const leftError = stableMarsCourseAddressError('P4', coL2Block(0x3000, leftBelowZero).join('\n'));
    expect(leftError).toContain('0xfffffffc..0xffffffff');

    const rightError = stableMarsCourseAddressError('P4', coL2Block(0x3000, rightAboveDm).join('\n'));
    expect(rightError).toContain('0x00003000..0x00003003');
  });

  it('allows P7 timer word registers but rejects narrower timer accesses', () => {
    const timerLoad = iType(0x23, 0, 2, 0x7f00);
    const timerStore = iType(0x2b, 0, 2, 0x7f14);
    const validTrace = [
      ...coL2Block(0x3000, timerLoad, [2, 0]),
      ...coL2Block(0x3004, timerStore)
    ].join('\n');
    expect(stableMarsCourseAddressError('P7', validTrace)).toBeUndefined();

    const byteLoad = iType(0x20, 0, 2, 0x7f00);
    expect(stableMarsCourseAddressError('P7', coL2Block(0x3000, byteLoad).join('\n')))
      .toContain('TC0/TC1 的 word 寄存器访问');
  });

  it('selects detailed compatibility tracing for every course memory operation', () => {
    expect(machineCodeNeedsMarsOracleCompatibilityTrace('8c220000\n', false)).toBe(true);
    expect(machineCodeNeedsMarsOracleCompatibilityTrace('00000000\n', false)).toBe(false);
  });
});
