import { describe, expect, it } from 'vitest';
import { mergeCoSettings } from '../../../language/common/settings';
import {
  getMipsCompletions,
  getMipsDiagnostics
} from '../../../language/mips/service';
import { instructions } from '../../../language/mips/resources';
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
  it('exposes every catalog instruction through mnemonic completion', () => {
    const completions = getMipsCompletions(mipsDoc('    '), { line: 0, character: 4 }, mergeCoSettings({}), state());
    const labels = new Set(completions.map((item) => item.label));

    for (const mnemonic of Object.keys(instructions)) {
      expect(labels.has(mnemonic)).toBe(true);
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
});
