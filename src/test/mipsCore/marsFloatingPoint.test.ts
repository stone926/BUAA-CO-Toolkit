import { describe, expect, it } from 'vitest';
import { MarsIoRequest } from '../../mips/core/mars/api';
import { FloatingPointState } from '../../mips/core/mars/floatingPointState';
import { formatFloatingPoint, parseFloatingPoint } from '../../mips/core/mars/floatingPointText';
import { MarsSession } from '../../mips/core/mars/session';
import { op, textImage } from './programFixtures';

function machine(words: readonly number[], dataWords: readonly number[] = []): MarsSession {
  return new MarsSession({ image: textImage(words, { base: 0x00400000, dataBase: 0x10010000, dataWords }) });
}

function fp(word: number, source: number): MarsSession {
  const run = machine([word]);
  run.fpu.commit(run.fpu.singleWrites(0, source));
  return run;
}

describe('ordinary COP1 on the shared architectural commit point', () => {
  it('executes independently encoded mtc1, add.s and mfc1 words', () => {
    const run = machine([
      op('lui', { rt: 8, immediate: 0x3fc0 }), // 1.5f bits
      op('lui', { rt: 9, immediate: 0x4010 }), // 2.25f bits
      0x44880000, // mtc1 $t0,$f0
      0x44891000, // mtc1 $t1,$f2
      0x46020100, // add.s $f4,$f0,$f2
      0x44102000 // mfc1 $s0,$f4
    ]);
    expect(run.runSlice(30).status).toBe('exited');
    expect(run.machine.state.gpr.read(16)).toBe(0x40700000);
    expect(run.fpu.single(4)).toBe(3.75);
    expect(run.instructionsExecuted).toBe(6);
  });

  it('loads, computes and stores little-endian paired double words', () => {
    const run = machine([
      op('lui', { rt: 8, immediate: 0x1001 }),
      0xd5000000, // ldc1 $f0,0($t0)
      0xd5020008, // ldc1 $f2,8($t0)
      0x46220100, // add.d $f4,$f0,$f2
      0xf5040010 // sdc1 $f4,16($t0)
    ], [0, 0x3ff80000, 0, 0x40020000, 0, 0]);
    expect(run.runSlice(30).status).toBe('exited');
    expect(run.fpu.double(4)).toBe(3.75);
    expect(run.machine.memory.readDataWord(0x10010010)).toBe(0);
    expect(run.machine.memory.readDataWord(0x10010014)).toBe(0x400e0000);
  });

  it('implements IEEE nearest-even and Java cvt.w truncation independently', () => {
    const rounded = fp(0x4600008c, 2.5); // round.w.s $f2,$f0
    rounded.runSlice(8);
    expect(rounded.fpu.raw(2)).toBe(2);
    const roundedNegative = fp(0x4600008c, -3.5);
    roundedNegative.runSlice(8);
    expect(roundedNegative.fpu.raw(2)).toBe((-4) >>> 0);
    const converted = fp(0x460000a4, 2.9); // cvt.w.s $f2,$f0
    converted.runSlice(8);
    expect(converted.fpu.raw(2)).toBe(2);
    const nan = fp(0x460000a4, NaN);
    nan.runSlice(8);
    expect(nan.fpu.raw(2)).toBe(0);
  });

  it('handles infinities, negative square roots, signed zero and raw moves', () => {
    const sqrt = fp(0x46000084, -1); // sqrt.s $f2,$f0
    sqrt.runSlice(8);
    expect(sqrt.fpu.raw(2)).toBe(0x7fc00000);
    const division = machine([0x460200c3]); // div.s $f3,$f0,$f2
    division.fpu.commit(division.fpu.singleWrites(0, 1));
    division.runSlice(8);
    expect(division.fpu.single(3)).toBe(Infinity);
    const move = machine([0x46000086]); // mov.s $f2,$f0
    move.fpu.commit([{ register: 0, value: 0x80000000 }]);
    move.runSlice(8);
    expect(move.fpu.raw(2)).toBe(0x80000000);
  });

  it('sets the selected compare flag and uses ordinary branch delay policy', () => {
    const words = [
      0x4602033c, // c.lt.s 3,$f0,$f2
      0x450d0001, // bc1t 3,+1
      op('addiu', { rt: 8, rs: 0, immediate: 1 }),
      op('addiu', { rt: 9, rs: 0, immediate: 2 })
    ];
    for (const delayedBranching of [false, true]) {
      const run = new MarsSession({ image: textImage(words, { base: 0x400000 }), delayedBranching });
      run.fpu.commit(run.fpu.singleWrites(0, 1));
      run.fpu.commit(run.fpu.singleWrites(2, 2));
      run.runSlice(20);
      expect(run.fpu.conditionFlags).toBe(8);
      expect(run.machine.state.gpr.read(8)).toBe(delayedBranching ? 1 : 0);
      expect(run.machine.state.gpr.read(9)).toBe(2);
    }
  });

  it('rejects odd double registers and misaligned double transfers without partial writes', () => {
    const odd = machine([0x46220040]); // add.d $f1,$f0,$f2
    expect(odd.runSlice(4)).toMatchObject({ status: 'fault', diagnostic: { message: expect.stringContaining('even-numbered') } });
    const misaligned = machine([op('lui', { rt: 8, immediate: 0x1001 }), 0xf5000004]);
    misaligned.fpu.commit(misaligned.fpu.doubleWrites(0, 1.5));
    expect(misaligned.runSlice(8)).toMatchObject({ status: 'fault', diagnostic: { message: expect.stringContaining('eight-byte aligned') } });
    expect(misaligned.machine.memory.readDataWord(0x10010004)).toBe(0);
  });

  it('includes COP1 state and flags in the ordinary snapshot digest', () => {
    const run = machine([op('nop')]);
    const first = run.snapshot();
    run.fpu.commit([{ register: 0, value: 42 }]);
    const second = run.snapshot();
    expect(second.digest).not.toBe(first.digest);
    expect(second.fpr[0]).toBe(42);
    expect(second.profile).toBe('MARS-Default');
  });

  it('resumes floating-point input and emits Java-style float/double output', () => {
    const run = machine([
      op('addiu', { rt: 2, rs: 0, immediate: 6 }), op('syscall'),
      0x46000306, // mov.s $f12,$f0
      op('addiu', { rt: 2, rs: 0, immediate: 2 }), op('syscall'),
      op('addiu', { rt: 2, rs: 0, immediate: 7 }), op('syscall'),
      0x46200306, // mov.d $f12,$f0
      op('addiu', { rt: 2, rs: 0, immediate: 3 }), op('syscall')
    ]);
    const requests: MarsIoRequest[] = [];
    while (!run.done) {
      const result = run.runSlice(40);
      if (result.status === 'waiting') {
        requests.push(result.request);
        const text = result.request.kind === 'read-float' ? '0.1' : '1.25e10';
        run.resume({ id: result.request.id, text });
      }
    }
    expect(requests).toMatchObject([
      { kind: 'read-float' }, { kind: 'write', text: '0.1' },
      { kind: 'read-double' }, { kind: 'write', text: '1.25E10' }
    ]);
  });

  it('matches seeded Java float and double random values', () => {
    const run = machine([
      op('addiu', { rt: 2, rs: 0, immediate: 40 }), op('syscall'),
      op('addiu', { rt: 2, rs: 0, immediate: 43 }), op('syscall'),
      0x46000106, // mov.s $f4,$f0
      op('addiu', { rt: 2, rs: 0, immediate: 44 }), op('syscall')
    ]);
    run.runSlice(30);
    expect(run.fpu.single(4)).toBe(0.7309677600860596);
    expect(run.fpu.double(0)).toBe(0.8314409887870612);
  });
});

describe('floating-point text and register contracts', () => {
  it('formats signed zero, fixed point, exponent thresholds and nonfinite values', () => {
    expect(formatFloatingPoint(-0, false)).toBe('-0.0');
    expect(formatFloatingPoint(1, false)).toBe('1.0');
    expect(formatFloatingPoint(10_000_000, false)).toBe('1.0E7');
    expect(formatFloatingPoint(Math.fround(1e-45), true)).toBe('1.4E-45');
    expect(formatFloatingPoint(NaN, false)).toBe('NaN');
    expect(formatFloatingPoint(-Infinity, false)).toBe('-Infinity');
    expect(parseFloatingPoint('0x1.8p+2')).toBe(6);
    expect(parseFloatingPoint('1.25f')).toBe(1.25);
    expect(() => parseFloatingPoint('abc')).toThrow('Invalid floating-point input');
  });

  it('matches locally verified Java float/double min-subnormal and special-value text', () => {
    // Verified with JDK 25 Double.toString/Float.toString on the local MARS JVM.
    const doubleValues = [Number.MIN_VALUE, -Number.MIN_VALUE, 0, -0, NaN, Infinity, -Infinity];
    expect(doubleValues.map((value) => formatFloatingPoint(value, false))).toEqual([
      '4.9E-324', '-4.9E-324', '0.0', '-0.0', 'NaN', 'Infinity', '-Infinity'
    ]);
    const singleValues = [Math.fround(1e-45), -Math.fround(1e-45), 0, -0, NaN, Infinity, -Infinity];
    expect(singleValues.map((value) => formatFloatingPoint(value, true))).toEqual([
      '1.4E-45', '-1.4E-45', '0.0', '-0.0', 'NaN', 'Infinity', '-Infinity'
    ]);
  });

  it('represents the low word in the even-numbered register', () => {
    const fpu = new FloatingPointState();
    fpu.commit(fpu.doubleWrites(4, 1.5));
    expect(fpu.raw(4)).toBe(0);
    expect(fpu.raw(5)).toBe(0x3ff80000);
    expect(fpu.double(4)).toBe(1.5);
  });
});
