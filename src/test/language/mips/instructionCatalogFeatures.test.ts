import { describe, expect, it } from 'vitest';
import { mergeCoSettings } from '../../../language/common/settings';
import {
  getMipsCompletions,
  getMipsDiagnostics,
  getMipsHover
} from '../../../language/mips/service';
import { instructions, pseudoExpansions, instructionAvailable } from '../../../language/mips/resources';
import { builtinPseudoMnemonics } from '../../../mips/core/assembler/pseudo';
import type { MipsServerState } from '../../../language/mips/state';
import { mipsDoc } from '../../helpers/textDocument';

function state(overrides: Partial<MipsServerState> = {}): MipsServerState {
  return {
    ignoredPseudoInstructionFiles: new Set(),
    ignoredPseudoInstructionMnemonics: new Set(),
    ...overrides
  };
}

describe('MIPS instruction catalog-backed features', () => {
  it('exposes executable core instructions through mnemonic completion', () => {
    const completions = getMipsCompletions(mipsDoc('    '), { line: 0, character: 4 }, mergeCoSettings({}), state());
    const labels = new Set(completions.map((item) => item.label));

    for (const mnemonic of Object.keys(instructions)) {
      expect(labels.has(mnemonic), mnemonic).toBe(instructionAvailable(instructions[mnemonic], 'auto'));
    }
  });

  it('uses operand AST context for syscall, CP0, and ordinary register completions', () => {
    const settings = mergeCoSettings({});
    const syscallDoc = mipsDoc('li $v0, ');
    const cp0Doc = mipsDoc('mtc0 $t0, ');
    const registerDoc = mipsDoc('addu $');

    expect(getMipsCompletions(syscallDoc, { line: 0, character: syscallDoc.getText().length }, settings, state())
      .some((item) => item.label === '10' && item.detail?.includes('exit'))).toBe(true);
    expect(getMipsCompletions(cp0Doc, { line: 0, character: cp0Doc.getText().length }, settings, state())
      .some((item) => item.label === '$12' && item.detail?.includes('SR'))).toBe(true);
    expect(getMipsCompletions(registerDoc, { line: 0, character: registerDoc.getText().length }, settings, state())
      .some((item) => item.label === '$t0')).toBe(true);
  });

  it('honors pseudo-instruction ignore state while keeping pseudo completions visible', () => {
    const document = mipsDoc('li $t0, 1', 'test://pseudo.asm');
    const settings = mergeCoSettings({ mips: { warnPseudoInstruction: true } });
    const warningState = state();
    const ignoredMnemonicState = state({ ignoredPseudoInstructionMnemonics: new Set(['li']) });
    const ignoredFileState = state({ ignoredPseudoInstructionFiles: new Set([document.uri]) });

    expect(getMipsDiagnostics(document, settings, warningState).map((diagnostic) => diagnostic.code)).toContain('pseudo-instruction:li');
    expect(getMipsDiagnostics(document, settings, ignoredMnemonicState).map((diagnostic) => diagnostic.code)).not.toContain('pseudo-instruction:li');
    expect(getMipsDiagnostics(document, settings, ignoredFileState).map((diagnostic) => diagnostic.code)).not.toContain('pseudo-instruction:li');
    expect(getMipsCompletions(mipsDoc('l'), { line: 0, character: 1 }, settings, ignoredMnemonicState)
      .some((item) => item.label === 'li')).toBe(true);
  });

  it('uses generated ISA availability for P3–P7 without applying it to P0–P2', () => {
    expect(Object.values(instructions).every((instruction) => !Object.prototype.hasOwnProperty.call(instruction, 'projects'))).toBe(true);
    const text = 'mfc0 $t0, $12';
    const codes = (profile: 'P2' | 'P3' | 'P7') => getMipsDiagnostics(
      mipsDoc(text), mergeCoSettings({ project: { profile } }), state()
    ).map((diagnostic) => diagnostic.code);

    expect(instructions.mfc0.isa?.profiles).toEqual(['P7']);
    expect(codes('P3')).toContain('project-instruction');
    expect(codes('P7')).not.toContain('project-instruction');
    expect(codes('P2')).not.toContain('project-instruction');
    expect(getMipsDiagnostics(mipsDoc('lw $t0, 0($t1)'), mergeCoSettings({ project: { profile: 'P3' } }), state())
      .map((diagnostic) => diagnostic.code)).not.toContain('project-instruction');
  });

  it('labels MARS-only pseudo instructions separately from builtin capabilities', () => {
    for (const mnemonic of builtinPseudoMnemonics) {
      expect(instructions[mnemonic]?.pseudo).toBe(true);
      expect(pseudoExpansions[mnemonic]?.forms.length).toBeGreaterThan(0);
    }

    const settings = mergeCoSettings({ project: { profile: 'P6' } });
    const completion = getMipsCompletions(mipsDoc('abs'), { line: 0, character: 3 }, settings, state())
      .find((item) => item.label === 'abs');
    expect(completion).toBeUndefined();
    const document = mipsDoc('abs $t0, $t1');
    const hover = getMipsHover(document, { line: 0, character: 1 }, settings, state());
    expect(JSON.stringify(hover?.contents)).toContain('MARS 展开预览');
    expect(JSON.stringify(hover?.contents)).toContain('内建汇编器暂不支持');
    expect(getMipsCompletions(mipsDoc('li'), { line: 0, character: 2 }, settings, state())
      .find((item) => item.label === 'li')?.detail).not.toContain('内建汇编器暂不支持');
  });
});
