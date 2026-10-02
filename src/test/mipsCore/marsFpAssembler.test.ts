import { describe, expect, it } from 'vitest';
import { assembleMarsSource } from '../../mips/core/assembler/marsAssembler';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';

function words(text: string, configuration?: 'CompactDataAtZero' | 'CompactTextAtZero'): string[] {
  const result = assembleMarsSource({ id: 'fp.asm', text }, { memoryConfiguration: configuration });
  expect(result.diagnostics).toEqual([]);
  expect(result.ok).toBe(true);
  return result.image!.segments.find(segment => segment.name === 'text')!.words.map(word => word.toString(16).padStart(8, '0'));
}

describe('ordinary MARS floating point assembly', () => {
  it('matches MARS COP1 arithmetic and register transfer machine words', () => {
    expect(words(`
      mfc1 $t1,$f3
      mtc1 $t2,$f5
      add.s $f1,$f3,$f5
      sub.d $f2,$f4,$f6
      mul.s $f7,$f9,$f11
      div.d $f8,$f10,$f12
      sqrt.s $f13,$f15
      abs.d $f14,$f16
      mov.s $f17,$f19
      neg.d $f18,$f20
    `)).toEqual(['44091800', '448a2800', '46051840', '46262081', '460b49c2', '462c5203', '46007b44', '46208385', '46009c46', '4620a487']);
  });

  it('encodes each conversion and integer rounding operation', () => {
    expect(words(`
      cvt.d.s $f2,$f1
      cvt.d.w $f4,$f3
      cvt.s.d $f5,$f6
      cvt.s.w $f7,$f9
      cvt.w.s $f11,$f13
      cvt.w.d $f15,$f16
      round.w.s $f1,$f3
      trunc.w.d $f5,$f6
      ceil.w.s $f7,$f9
      floor.w.d $f11,$f12
    `)).toEqual(['460008a1', '46801921', '46203160', '468049e0', '46006ae4', '462083e4', '4600184c', '4620314d', '460049ce', '462062cf']);
  });

  it('relocates forward and backward FP branches and encodes condition flags', () => {
    expect(words(`
      start: c.eq.s $f1,$f3
      c.lt.d 7,$f2,$f4
      c.le.s 3,$f5,$f7
      bc1t 7,end
      bc1f start
      end: movf.s $f1,$f3,6
      movt.d $f2,$f4,7
      movz.s $f5,$f7,$t1
      movn.d $f6,$f8,$t2
    `)).toEqual(['46030832', '4624173c', '46072b3e', '451d0001', '4500fffb', '46181851', '463d2091', '46093952', '462a4193']);
  });

  it('shares address pseudo expansion for FP memory aliases and forwards data symbols', () => {
    expect(words(`
      .data
      value: .word 0
      .text
      l.s $f1,value
      s.d $f2,8($sp)
      lwc1 $f3,-4($t0)
      ldc1 $f4,($t1)
      swc1 $f5,0($t2)
      l.d $f6,value($t3)
    `)).toEqual(['3c011001', 'c4210000', '3c010000', '003d0821', 'f4220008', 'c503fffc', 'd5240000', 'e5450000', '3c011001', '002b0821', 'd4260000']);
    expect(words('.data\nvalue: .word 0\n.text\nl.s $f1,value\ns.s $f3,value($t0)', 'CompactDataAtZero'))
      .toEqual(['c4010000', 'e5030000']);
  });

  it('expands float literal conveniences into exact low/high FPR bit patterns', () => {
    expect(words('li.s $f1,-0.0\nli.d $f2,1.5')).toEqual([
      '3c018000', '34210000', '44810800',
      '3c010000', '34210000', '44811000', '3c013ff8', '34210000', '44811800'
    ]);
  });

  it.each([
    ['add.s $f32,$f1,$f3', 'asm.operand.invalid-register'],
    ['add.s $t0,$f1,$f3', 'asm.operand.invalid-register'],
    ['add.d $f1,$f2,$f4', 'asm.operand.invalid-register'],
    ['cvt.d.s $f3,$f1', 'asm.operand.invalid-register'],
    ['cvt.w.d $f3,$f1', 'asm.operand.invalid-register'],
    ['ldc1 $f3,0($t0)', 'asm.operand.invalid-register'],
    ['lwc1 $f1,0($f2)', 'asm.operand.invalid-memory-operand'],
    ['c.eq.s 8,$f1,$f3', 'asm.immediate.out-of-range'],
    ['bc1f -1,target\ntarget: nop', 'asm.immediate.out-of-range'],
    ['bc1t missing', 'asm.symbol.undefined'],
    ['bc1t 0x00400001', 'asm.immediate.out-of-range'],
    ['bc1t 0x00480000', 'asm.immediate.out-of-range'],
    ['movn.s $f1,$f3,$f5', 'asm.operand.invalid-register'],
    ['li.s $f1,1.2junk', 'asm.operand.invalid-immediate'],
    ['sqrt.s $f1', 'asm.operand.wrong-count']
  ])('diagnoses invalid or incomplete input %s', (text, code) => {
    const result = assembleMarsSource({ id: 'fp.asm', text });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(diagnostic => diagnostic.code === code)).toBe(true);
    expect(result.diagnostics[0].span?.sourceId).toBe('fp.asm');
  });

  it('enforces per-statement expansion limits', () => {
    const result = assembleMarsSource({ id: 'fp.asm', text: 'li.d $f2,1.5' }, { maximumPseudoInstructionsPerStatement: 5 });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'asm.macro.expansion-limit')).toBe(true);
  });

  it('keeps FP mnemonics outside every course assembler profile', () => {
    for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7'] as const) {
      const result = assembleCourseSource({ id: 'course.asm', text: 'add.s $f1,$f3,$f5' }, { profile });
      expect(result.ok).toBe(false);
    }
  });
});
