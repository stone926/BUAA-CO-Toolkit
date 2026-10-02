import { describe, expect, it } from 'vitest';
import { mergeCoSettings } from '../../../language/common/settings';
import { getMipsCompletions, getMipsDiagnostics, getMipsHover, getMipsSemanticTokens } from '../../../language/mips/service';
import { instructions } from '../../../language/mips/resources';
import { marsInstructionFacts } from '../../../mips/core/assembler/marsInstructionFacts';
import { mipsDoc } from '../../helpers/textDocument';

const state = () => ({ ignoredPseudoInstructionFiles: new Set<string>(), ignoredPseudoInstructionMnemonics: new Set<string>() });
const ordinarySettings = mergeCoSettings({ project: { profile: 'P2' }, mips: { warnPseudoInstruction: false } });
const diagnostics = (text: string) => getMipsDiagnostics(mipsDoc(text), ordinarySettings, state());

describe('ordinary MARS FP language features', () => {
  it('uses the assembler instruction facts for completions and instruction help', () => {
    const completions = getMipsCompletions(mipsDoc('    '), { line: 0, character: 4 }, ordinarySettings, state());
    for (const fact of marsInstructionFacts) {
      expect(instructions[fact.mnemonic].formats).toEqual(fact.formats);
      expect(completions.some(item => item.label === fact.mnemonic)).toBe(true);
    }
    expect(getMipsHover(mipsDoc('add.s $f1,$f3,$f5'), { line: 0, character: 2 }, ordinarySettings, state())).toBeDefined();
  });

  it('offers and highlights every FPR while retaining GPR register classes', () => {
    const completions = getMipsCompletions(mipsDoc('add.s $f'), { line: 0, character: 8 }, ordinarySettings, state());
    for (let index = 0; index < 32; index++) expect(completions.some(item => item.label === `$f${index}`)).toBe(true);
    const document = mipsDoc('add.s $f1,$f3,$f5');
    expect(getMipsSemanticTokens(document, ordinarySettings, state()).data.length).toBeGreaterThan(5);
    expect(getMipsHover(document, { line: 0, character: 8 }, ordinarySettings, state())).toBeDefined();
    expect(diagnostics('addu $f1,$t0,$t1').some(diagnostic => diagnostic.code === 'operand-type')).toBe(true);
  });

  it('accepts real FP instructions, CC forms, integer conversions and address pseudos', () => {
    expect(diagnostics(`.data
value: .double 1.5
.text
add.s $f1,$f3,$f5
add.d $f2,$f4,$f6
cvt.d.s $f8,$f1
round.w.d $f1,$f2
mfc1 $t0,$f1
mtc1 $t1,$f3
c.eq.s 7,$f1,$f3
bc1t 7,end
movf.d $f2,$f4,6
movn.s $f1,$f3,$t0
l.d $f2,value($t0)
s.s $f1,70000($t1)
li.s $f1,-1.5
end: nop`).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
  });

  it.each(['add.d $f1,$f2,$f4', 'add.s $t0,$f1,$f3', 'mfc1 $f1,$t0', 'lwc1 $f1,0($f2)', 'ldc1 $f3,0($t0)', 'c.eq.s 8,$f1,$f3', 'bc1t -1,end\nend: nop', 'movn.s $f1,$f3,$f5'])('rejects wrong operand classes and ranges: %s', text => {
    expect(diagnostics(text).some(diagnostic => diagnostic.code === 'operand-type')).toBe(true);
  });

  it('warns for FP instructions in P3–P7 while retaining their syntax information', () => {
    for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7'] as const) {
      const codes = getMipsDiagnostics(mipsDoc('add.s $f1,$f3,$f5'), mergeCoSettings({ project: { profile } }), state()).map(diagnostic => diagnostic.code);
      expect(codes).toContain('project-instruction');
      expect(codes).not.toContain('unknown-instruction');
    }
    expect(diagnostics('add.s $f1,$f3,$f5').some(diagnostic => diagnostic.code === 'project-instruction')).toBe(false);
  });
});
