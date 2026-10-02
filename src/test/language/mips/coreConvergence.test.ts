import { describe, expect, it } from 'vitest';
import { parseMipsSourceLine, parseIntegerLiteral, parseCharLiteral } from '../../../language/mips/syntax';
import { parseIntegerLiteralValue, parseIntegerLiteral as signedInteger, parseCharacterLiteral } from '../../../mips/core/assembler/literals';
import { tokenizeCode } from '../../../mips/core/assembler/syntax';
import { assembleMarsSource } from '../../../mips/core/assembler/marsAssembler';
import { getMipsDiagnostics, getMipsCompletions } from '../../../language/mips/service';
import { marsIntegerExtensionMnemonics } from '../../../mips/core/assembler/marsIntegerInstructionFacts';
import { mergeCoSettings } from '../../../language/common/settings';
import { mipsDoc } from '../../helpers/textDocument';

describe('editor and internal MARS source convergence', () => {
  it('offers all ordinary integer extensions and validates new forms against core facts', () => {
    const settings = mergeCoSettings({ project: { profile: 'P2' }, mips: { warnPseudoInstruction: false } });
    const state = { ignoredPseudoInstructionFiles: new Set<string>(), ignoredPseudoInstructionMnemonics: new Set<string>() };
    const items = getMipsCompletions(mipsDoc(''), { line: 0, character: 0 }, settings, state);
    for (const mnemonic of marsIntegerExtensionMnemonics) expect(items.some(item => item.label === mnemonic), mnemonic).toBe(true);
    for (const text of ['mulu $t0,$t1,$t2', 'mulo $t0,$t1,100000', 'mulou $t0,$t1,$t2', 'rol $t0,$t1,31', 'ror $t0,$t1,$t2', 'break 1048575', 'mfc0 $t0,$8', 'mtc0 $t0,$badvaddr']) {
      expect(assembleMarsSource({ id: 'source', text }).ok, text).toBe(true);
      expect(getMipsDiagnostics(mipsDoc(text), settings, state).filter(diagnostic => diagnostic.severity === 1), text).toEqual([]);
    }
    for (const text of ['rol $t0,$t1,32', 'ror $t0,$t1,-1', 'break 1048576', 'mfc0 $t0,$9']) {
      expect(assembleMarsSource({ id: 'source', text }).ok, text).toBe(false);
      expect(getMipsDiagnostics(mipsDoc(text), settings, state).some(diagnostic => diagnostic.severity === 1), text).toBe(true);
    }
  });

  it('uses one literal parser while preserving written unsigned values for editor range checks', () => {
    expect(parseIntegerLiteral).toBe(parseIntegerLiteralValue);
    expect(parseCharLiteral).toBe(parseCharacterLiteral);
    for (const literal of ['0xffffffff', '4294967295', '-2147483648', '0377', '0b1111', '+17']) {
      const value = parseIntegerLiteral(literal)!;
      expect(signedInteger(literal)).toBe(value | 0);
    }
    for (const literal of ['09', '018', '0b12', '0xg', '4294967296', '-2147483649']) {
      expect(parseIntegerLiteral(literal)).toBeUndefined();
      expect(signedInteger(literal)).toBeUndefined();
      expect(assembleMarsSource({ id: 'invalid', text: `li $t0, ${literal}` }).ok).toBe(false);
    }
  });

  it('adapts the assembler lexer without losing source spans or incomplete character diagnostics', () => {
    for (const text of ['add.s $f0, $f12, $f2', '.double -1.5e-2, .5', 'addiu $2, $31, 09', '.eqv x, (1 << 3) % 2', ".word 'a', '\\n', 'bad", '.asciiz "unfinished']) {
      const editor = parseMipsSourceLine(text);
      const core = tokenizeCode(text, '', 0);
      expect(editor.tokens.map(token => [token.value, token.start, token.end])).toEqual(core.map(token => [token.text, token.startOffset, token.endOffset]));
    }
    const tokens = parseMipsSourceLine(".word 'bad").tokens;
    expect(tokens[tokens.length - 1]?.kind).toBe('unknown');
  });
});
