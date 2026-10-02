import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getMipsHover } from '../../../language/mips/hover';
import { getMipsInlayHints } from '../../../language/mips/inlayHints';
import { getMipsCompletions } from '../../../language/mips/completions';

const state = () => ({ ignoredPseudoInstructionFiles: new Set<string>(), ignoredPseudoInstructionMnemonics: new Set<string>() });
describe('syscall language semantics', () => {
  it('describes the P7 CPU exception without guessing a console service from v0', () => {
    const document = TextDocument.create('test://p7.asm', 'mipsasm', 1, 'li $v0, 1\nsyscall');
    const settings = mergeCoSettings({ project: { profile: 'P7' } });
    const hover = JSON.stringify(getMipsHover(document, { line: 1, character: 2 }, settings, state()));
    expect(hover).toContain('ExcCode=8'); expect(hover).toContain('0x4180'); expect(hover).not.toContain('当前 $v0 服务');
    const hints = getMipsInlayHints(document, { start: { line: 0, character: 0 }, end: { line: 1, character: 7 } }, settings, state());
    expect(hints.map(hint => hint.label)).toEqual([' ExcCode=8 → 0x4180']);
    const input = TextDocument.create('test://p7-completion.asm', 'mipsasm', 1, 'li $v0, ');
    expect(getMipsCompletions(input, { line: 0, character: 8 }, settings, state()).some(item => item.detail?.startsWith('syscall '))).toBe(false);
  });
  it('keeps service hover and hints for P2 console programs', () => {
    const document = TextDocument.create('test://p2.asm', 'mipsasm', 1, 'li $v0, 1\nsyscall');
    const settings = mergeCoSettings({ project: { profile: 'P2' } });
    expect(JSON.stringify(getMipsHover(document, { line: 1, character: 2 }, settings, state()))).toContain('当前 $v0 服务');
    expect(getMipsInlayHints(document, { start: { line: 0, character: 0 }, end: { line: 1, character: 7 } }, settings, state())
      .some(hint => String(hint.label).includes('print integer'))).toBe(true);
  });
});
