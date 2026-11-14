import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { setCustomInstructionFacts, clearCustomInstructionFacts } from '../language/mips/customInstructionFacts';
import { getMipsDiagnostics, getMipsCompletions, getMipsHover, getMipsSignatureHelp, getMipsSemanticTokens } from '../language/mips/service';
import { defaultCoSettings } from '../language/common/settings';
import type { CustomInstructionMetadata } from '../mips/core/custom/api';

afterEach(clearCustomInstructionFacts);
const definition: CustomInstructionMetadata = { apiVersion: 1, mnemonic: 'xori_custom', modes: ['P5'],
  encoding: '011111 rs:5 rt:5 immediate:16', operands: [{ kind: 'register', field: 'rt' }, { kind: 'register', field: 'rs' }, { kind: 'immediate', field: 'immediate' }] };
const settings = { ...defaultCoSettings, project: { ...defaultCoSettings.project, profile: 'P5' as const } };
const state = { ignoredPseudoInstructionFiles: new Set<string>(), ignoredPseudoInstructionMnemonics: new Set<string>() };
const root = URI.file('/co/custom-project').toString();
const document = (text: string, directory = '/co/custom-project') => TextDocument.create(URI.file(`${directory}/main.asm`).toString(), 'mipsasm', 1, text);

describe('workspace custom instruction editor facts', () => {
  it('invalidates diagnostics on registry changes and keeps definitions scoped to their workspace', () => {
    const source = document('xori_custom $1,$0,7');
    expect(getMipsDiagnostics(source, settings, state).some(item => item.code === 'unknown-instruction')).toBe(true);
    setCustomInstructionFacts(root, [definition]);
    expect(getMipsDiagnostics(source, settings, state).some(item => item.code === 'unknown-instruction')).toBe(false);
    expect(getMipsDiagnostics(document(source.getText(), '/co/other-project'), settings, state).some(item => item.code === 'unknown-instruction')).toBe(true);
    setCustomInstructionFacts(root, []);
    expect(getMipsDiagnostics(source, settings, state).some(item => item.code === 'unknown-instruction')).toBe(true);
  });
  it('uses shared operand facts for diagnostics, completion, hover and signature help', () => {
    setCustomInstructionFacts(root, [definition]);
    const source = document('xori_custom $1,$0,7');
    expect(getMipsCompletions(document('xor'), { line: 0, character: 3 }, settings, state).some(item => item.label === 'xori_custom')).toBe(true);
    expect(getMipsHover(source, { line: 0, character: 2 }, settings, state)).toBeDefined();
    expect(getMipsSignatureHelp(source, { line: 0, character: 16 }, settings, state)?.signatures[0].label).toContain('xori_custom');
    expect(getMipsSemanticTokens(source, settings, state).data.slice(0, 3)).toEqual([0, 0, 11]);
    expect(getMipsDiagnostics(document('xori_custom 1,$0,7'), settings, state).some(item => String(item.message).includes('GPR'))).toBe(true);
    expect(getMipsDiagnostics(document('xori_custom $1,$0,65536'), settings, state).some(item => String(item.message).includes('65535'))).toBe(true);
  });
});
