import { describe, expect, it } from 'vitest';
import { assembleMarsSource } from '../../mips/core/assembler/marsAssembler';
import { MarsSession } from '../../mips/core/mars/session';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';

const source = [
  '.text', 'abs $t0,$t1', 'subi $t0,$t1,-5', 'subiu $t0,$t1,5', 'mul $t0,$t1,5',
  'mulu $t0,$t1,$t2', 'mulo $t0,$t1,$t2', 'mulou $t0,$t1,$t2', 'div $t0,$t1,$t2',
  'divu $t0,$t1,$t2', 'rem $t0,$t1,$t2', 'remu $t0,$t1,$t2', 'rol $t0,$t1,0',
  'ror $t0,$t1,$t2', 'blt $t0,100000,target', 'seq $s0,$t0,100000', 'target: nop'
].join('\n');

// Captured using the installed official MARS 4.5 `a dump .text HexText`.
const officialMarsWords = [
  '00090fc3', '00294026', '01014023', '2001fffb', '01214022', '3c010000', '34210005', '01214023',
  '20010005', '71214002', '012a0019', '00004012', '012a0018', '00000810', '00004012', '000847c3',
  '10280001', '0000000d', '00004012', '012a0019', '00000810', '10200001', '0000000d', '00004012',
  '15400001', '0000000d', '012a001a', '00004012', '15400001', '0000000d', '012a001b', '00004012',
  '15400001', '0000000d', '012a001a', '00004010', '15400001', '0000000d', '012a001b', '00004010',
  '00090802', '00094000', '01014025', '000a0823', '00290804', '01494006', '01014025', '3c010001',
  '342186a0', '0101082a', '14200005', '3c010001', '342186a0', '01018023', '34010001', '0201802b', '00000000'
];

describe('ordinary MARS integer pseudo goldens', () => {
  it('matches official MARS integer expansions without delay slots', () => {
    const result = assembleMarsSource({ id: 'root', text: source });
    expect(result.diagnostics).toEqual([]);
    expect(result.image!.segments[0].words.map(word => word.toString(16).padStart(8, '0'))).toEqual(officialMarsWords);
  });

  it('inserts guard delay nops and adjusts internal branch offsets', () => {
    const result = assembleMarsSource({ id: 'root', text: source }, { delayedBranching: true });
    const expected = officialMarsWords.flatMap(word => ['10280001', '10200001', '15400001'].includes(word)
      ? [(parseInt(word, 16) + 1).toString(16).padStart(8, '0'), '00000000'] : [word]);
    expect(result.diagnostics).toEqual([]);
    expect(result.image!.segments[0].words.map(word => word.toString(16).padStart(8, '0'))).toEqual(expected);
  });

  it('rejects malformed and unbounded integer pseudos with diagnostics', () => {
    for (const text of ['rol $t0,$t1,32', 'abs $t0,5', 'div $t0,$t1,not_a_constant', 'break -1']) {
      const result = assembleMarsSource({ id: 'root', text });
      expect(result.ok).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
    expect(assembleMarsSource({ id: 'root', text: 'mulo $t0,$t1,$t2' }, { maximumPseudoInstructionsPerStatement: 3 }).ok).toBe(false);
  });

  it('accepts the ordinary MARS CP0 VAddr and writable Cause registers', () => {
    const result = assembleMarsSource({ id: 'root', text: 'mfc0 $t0,$8\nmtc0 $t1,$13\nmfc0 $t2,$status' });
    expect(result.diagnostics).toEqual([]);
    expect(result.image!.segments[0].words).toEqual([0x4008_4000, 0x4089_6800, 0x400a_6000]);
    expect(assembleMarsSource({ id: 'root', text: 'mfc0 $t0,$7' }).ok).toBe(false);
  });

  it('matches official MARS wide numeric base offsets and preserves signed boundaries', () => {
    const result = assembleMarsSource({ id: 'root', text: [
      'lw $t0,32768($t1)', 'lw $t0,65535($t1)', 'sw $t0,-32769($t1)',
      'lw $t0,0x80000000($t1)', 'lw $t0,0xffff0000($t1)', 'lw $t0,-32768($t1)', 'lw $t0,32767($t1)',
      'lwc1 $f2,32768($t1)', 'l.s $f2,65535($t1)', 'swc1 $f2,-32769($t1)', 'l.d $f2,0x80000000($t1)'
    ].join('\n') });
    expect(result.diagnostics).toEqual([]);
    // Captured from official MARS 4.5; COP1 selects adjusted LUI, unlike GPR ORI.
    expect(result.image!.segments[0].words.map(word => word.toString(16).padStart(8, '0'))).toEqual([
      '34018000', '00290821', '8c280000', '3401ffff', '00290821', '8c280000',
      '3c01ffff', '00290821', 'ac287fff', '3c018000', '00290821', '8c280000',
      '3c01ffff', '00290821', '8c280000', '8d288000', '8d287fff',
      '3c010001', '00290821', 'c4228000', '3c010001', '00290821', 'c422ffff',
      '3c01ffff', '00290821', 'e4227fff', '3c018000', '00290821', 'd4220000'
    ]);
    expect(assembleCourseSource({ id: 'root', text: 'lw $t0,32768($t1)' }, { profile: 'P7' }).ok).toBe(false);
  });

  it.each([
    [32768, '0x10008000'], [65535, '0x10000001'], [-32769, '0x10018001'],
    ['0x80000000', '0x90010000'], ['0xffff0000', '0x10020000'], [-32768, '0x10018000'], [32767, '0x10008001']
  ])('computes offset %s against base %s with 32-bit wrapping', (offset, base) => {
    const assembled = assembleMarsSource({ id: 'root', text: [
      '.data', '.word 42', '.text', `li $t1,${base}`, `lw $t0,${offset}($t1)`, 'li $v0,10', 'syscall'
    ].join('\n') });
    expect(assembled.diagnostics).toEqual([]);
    const machine = new MarsSession({ image: assembled.image! });
    expect(machine.runSlice(128)).toMatchObject({ status: 'exited' });
    expect(machine.machine.state.gpr.read(8)).toBe(42);
  });

  it('expands wide numeric offsets in compact configurations too', () => {
    for (const memoryConfiguration of ['CompactDataAtZero', 'CompactTextAtZero'] as const) {
      const result = assembleMarsSource({ id: 'root', text: 'lw $t0,32768($t1)\nlw $t0,-32769($t1)' }, { memoryConfiguration });
      expect(result.diagnostics).toEqual([]);
      expect(result.image!.segments[0].words).toHaveLength(6);
    }
  });
});
