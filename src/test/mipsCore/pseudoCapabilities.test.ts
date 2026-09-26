import { describe, expect, it } from 'vitest';
import { pseudoExpansions } from '../../language/mips/resources';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { builtinPseudoMnemonics, isBuiltinPseudoMnemonic } from '../../mips/core/assembler/pseudo';

const operandExamples: Readonly<Record<string, string>> = {
  '$rd': '$t0',
  '$rs': '$t1',
  '$rt': '$t2',
  label: 'target',
  imm16_signed: '5',
  imm16_unsigned: '5',
  imm32: '5'
};

describe('builtin standalone pseudo capabilities', () => {
  it('assembles one declared MARS form for every registered builtin handler', () => {
    for (const mnemonic of builtinPseudoMnemonics) {
      const form = pseudoExpansions[mnemonic]?.forms[0];
      expect(form, `${mnemonic} is absent from the MARS preview catalog`).toBeDefined();
      const operands = form!.operands.map((operand) => operandExamples[operand]);
      expect(operands.every(Boolean), `${mnemonic} has an unhandled operand example`).toBe(true);
      const source = `.text\nmain:\n    ${mnemonic} ${operands.join(', ')}\ntarget:\n    nop\n`;
      const result = assembleCourseSource({ id: 'root', text: source }, { profile: 'P6' });
      expect(result.ok, `${mnemonic}: ${JSON.stringify(result.diagnostics)}`).toBe(true);
    }
  });

  it('rejects MARS-only standalone pseudos in the builtin assembler', () => {
    expect(isBuiltinPseudoMnemonic('abs')).toBe(false);
    const result = assembleCourseSource({ id: 'root', text: '.text\n    abs $t0, $t1\n' }, { profile: 'P6' });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('asm.pseudo.unsupported');
  });
});
