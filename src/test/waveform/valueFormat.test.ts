import { describe, expect, it } from 'vitest';
import { disassembleMipsWord } from '../../waveform/model/mipsDisassembly';
import { eventTriggerText, formatBits, formatEventAt, formatReal } from '../../waveform/model/valueFormat';
import { parseVcd } from '../../waveform/vcd/vcdReader';
import {
  chooseTickStep,
  displayUnitFor,
  formatTicks,
  parseTimeScale,
  ticksFromPhysical
} from '../../waveform/model/timeScale';
import { encodeInstructionWord } from '../../mips/core/isa/encoder';

function bits(value: string, unknown = ''): [Uint32Array, Uint32Array, number] {
  // value/unknown are binary strings (MSB first) of equal length.
  const width = value.length;
  const words = Math.ceil(width / 32);
  const a = new Uint32Array(words);
  const b = new Uint32Array(words);
  for (let bit = 0; bit < width; bit++) {
    const character = value[width - 1 - bit];
    const isUnknown = unknown[width - 1 - bit] === '1';
    if (character === '1') {
      a[bit >>> 5] |= 1 << (bit & 31);
    }
    if (isUnknown) {
      b[bit >>> 5] |= 1 << (bit & 31);
    }
  }
  return [a, b, width];
}

function format(value: string, radix: Parameters<typeof formatBits>[5], unknown?: string): string {
  const [a, b, width] = bits(value, unknown);
  return formatBits(a, 0, b, unknown ? 0 : -1, width, radix);
}

describe('value formatting', () => {
  it('formats two-state vectors in every radix', () => {
    expect(format('11111111111111111111111111111110', 'hex')).toBe('fffffffe');
    expect(format('11111111111111111111111111111110', 'sdec')).toBe('-2');
    expect(format('11111111111111111111111111111110', 'udec')).toBe('4294967294');
    expect(format('0101', 'bin')).toBe('0101');
    expect(format('00101', 'hex')).toBe('05');
    expect(format('0100100001101001', 'ascii')).toBe('Hi');
    expect(format('0000000001101001', 'ascii')).toBe('i');
    expect(format('1', 'hex')).toBe('1');
    expect(format('1000', 'sdec')).toBe('-8');
  });

  it('keeps x and z visible instead of rendering them as zero', () => {
    // bits: a/b = 1/1 → x, 0/1 → z
    expect(format('11110000', 'hex', '11110000')).toBe('x0');
    expect(format('00001111', 'hex', '11111111')).toBe('zx');
    expect(format('00101111', 'hex', '11111111')).toBe('Xx');
    expect(format('00000000', 'hex', '00000001')).toBe('0X');
    expect(format('10', 'bin', '11')).toBe('xz');
    expect(format('1111', 'udec', '1111')).toBe('x');
    expect(format('0000', 'sdec', '1111')).toBe('z');
    expect(format('1000', 'udec', '1111')).toBe('X');
    expect(format('1', 'hex', '1')).toBe('x');
    expect(format('0', 'hex', '1')).toBe('z');
  });

  it('formats wide values with BigInt decimals', () => {
    const value = `1${'0'.repeat(63)}1`;
    expect(format(value, 'udec')).toBe((2n ** 64n + 1n).toString());
    expect(format(value, 'sdec')).toBe((-(2n ** 64n) + 1n).toString());
    expect(format(value, 'hex')).toBe('10000000000000001');
  });

  it('disassembles instruction words for the instr radix', () => {
    const word = encodeInstructionWord('addu', { rd: 9, rs: 10, rt: 11 });
    expect(format(word.toString(2).padStart(32, '0'), 'instr')).toBe('addu $t1, $t2, $t3');
    expect(format('1'.repeat(32), 'instr', '1'.repeat(32))).toBe('xxxxxxxx');
    expect(format('1111', 'instr')).toBe('f');
  });

  it('shows a named event only at its trigger times', () => {
    const data = parseVcd(`$timescale 1ps $end
$scope module tb $end
$var event 1 ! ev $end
$upscope $end
$enddefinitions $end
#10
1!
#20
1!
`);
    const track = data.vars[0].track;
    expect([5, 10, 15, 20, 25].map((time) => formatEventAt(data.tracks, track, time)))
      .toEqual(['—', eventTriggerText, '—', eventTriggerText, '—']);
  });

  it('prints reals compactly', () => {
    expect(formatReal(2)).toBe('2');
    expect(formatReal(1 / 3)).toBe('0.3333333333');
    expect(formatReal(Number.NaN)).toBe('NaN');
  });
});

describe('MIPS disassembly', () => {
  const cases: Array<[string, Parameters<typeof encodeInstructionWord>[1], string]> = [
    ['addu', { rd: 9, rs: 10, rt: 11 }, 'addu $t1, $t2, $t3'],
    ['sllv', { rd: 8, rt: 9, rs: 10 }, 'sllv $t0, $t1, $t2'],
    ['sll', { rd: 8, rt: 9, shamt: 4 }, 'sll $t0, $t1, 4'],
    ['lw', { rt: 8, rs: 29, immediate: -4 }, 'lw $t0, -4($sp)'],
    ['sw', { rt: 31, rs: 29, immediate: 16 }, 'sw $ra, 16($sp)'],
    ['ori', { rt: 8, rs: 0, immediate: 0xffff }, 'ori $t0, $zero, 0xffff'],
    ['addi', { rt: 8, rs: 8, immediate: -1 }, 'addi $t0, $t0, -1'],
    ['lui', { rt: 1, immediate: 0x1001 }, 'lui $at, 0x1001'],
    ['beq', { rs: 8, rt: 0, immediate: -3 }, 'beq $t0, $zero, -3'],
    ['bgez', { rs: 4, immediate: 2 }, 'bgez $a0, +2'],
    ['jal', { index: 0x0c00 }, 'jal 0x00003000'],
    ['jr', { rs: 31 }, 'jr $ra'],
    ['mult', { rs: 4, rt: 5 }, 'mult $a0, $a1'],
    ['mfhi', { rd: 2 }, 'mfhi $v0'],
    ['mfc0', { rt: 26, rd: 14 }, 'mfc0 $k0, $14'],
    ['eret', {}, 'eret'],
    ['syscall', {}, 'syscall']
  ];

  it.each(cases)('%s', (mnemonic, operands, expected) => {
    expect(disassembleMipsWord(encodeInstructionWord(mnemonic, operands))).toBe(expected);
  });

  it('shows nop and unknown words', () => {
    expect(disassembleMipsWord(0)).toBe('nop');
    expect(disassembleMipsWord(0xfc000000)).toBe('.word 0xfc000000');
  });
});

describe('time scale', () => {
  it('parses legal VCD timescales only', () => {
    expect(parseTimeScale('1ps')).toEqual({ magnitude: 1, unit: 'ps', femtoseconds: 1000 });
    expect(parseTimeScale(' 100 NS ')).toEqual({ magnitude: 100, unit: 'ns', femtoseconds: 1e8 });
    expect(parseTimeScale('3ps')).toBeUndefined();
    expect(parseTimeScale('1 min')).toBeUndefined();
  });

  it('formats ticks in adaptive units', () => {
    const ps = parseTimeScale('1ps')!;
    expect(formatTicks(474000, ps)).toBe('474 ns');
    expect(formatTicks(474500, ps)).toBe('474.5 ns');
    expect(formatTicks(200_000_000, ps)).toBe('200 µs');
    expect(formatTicks(0, ps)).toBe('0 ns');
    expect(formatTicks(5, ps)).toBe('5 ps');
    expect(formatTicks(12_345_000, ps)).toBe('12345 ns');
    expect(formatTicks(10_000_000, ps)).toBe('10 µs');
    expect(formatTicks(1_500_000, ps)).toBe('1.5 µs');
    expect(formatTicks(1_234_567, ps)).toBe('1234567 ps');
    expect(formatTicks(1_234_567_800, ps)).toBe('1234567.8 ns');
    expect(formatTicks(1500, ps, { unit: 'ns', maximumFractionDigits: 0 })).toBe('2 ns');
    expect(displayUnitFor(1e9)).toBe('us');
    expect(ticksFromPhysical(1.5, 'us', ps)).toBe(1_500_000);
  });

  it('chooses 1/2/5 ruler steps of whole ticks', () => {
    const ps = parseTimeScale('1ps')!;
    expect(chooseTickStep(1000, 90, ps)).toEqual({ major: 100_000, minorCount: 5, unit: 'ns' });
    expect(chooseTickStep(2500, 90, ps)).toMatchObject({ major: 500_000 });
    expect(chooseTickStep(0.001, 90, ps)).toMatchObject({ major: 1, minorCount: 1, unit: 'ps' });
    const ns = parseTimeScale('1ns')!;
    expect(chooseTickStep(20, 90, ns)).toMatchObject({ major: 2000, minorCount: 4, unit: 'us' });
  });
});
