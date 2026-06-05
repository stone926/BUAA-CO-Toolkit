import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import {
  getMipsCompletions,
  getMipsSemanticTokens,
  getMipsSignatureHelp
} from '../../../language/mips/service';
import { MipsServerState } from '../../../language/mips/state';
import { mipsSemanticTokenTypes } from '../../../language/mips/resources';

function doc(text: string): TextDocument {
  return TextDocument.create('test://features.s', 'mipsasm', 1, text);
}

function state(): MipsServerState {
  return {
    ignoredPseudoInstructionFiles: new Set(),
    ignoredPseudoInstructionMnemonics: new Set()
  };
}

describe('MIPS instruction-backed language features', () => {
  it('exposes P7 trap instructions through completion, signature help, and semantic coloring', () => {
    const settings = mergeCoSettings({
      mips: {
        instructionColorMode: 'byType'
      }
    });
    const document = doc('    teq $t0, $t1\n    teqi $t0, 1');

    const completions = getMipsCompletions(document, { line: 0, character: 4 }, settings, state());
    expect(completions.some((item) => item.label === 'teq' && item.detail?.includes('R 型指令'))).toBe(true);

    const signature = getMipsSignatureHelp(document, { line: 1, character: 14 }, settings, state());
    expect(signature?.signatures.map((item) => item.label)).toContain('teqi $rs, simm16');

    const semantic = getMipsSemanticTokens(doc('teq\nteqi'), settings, state());
    const rTypeIndex = mipsSemanticTokenTypes.indexOf('mipsRInstruction');
    const iTypeIndex = mipsSemanticTokenTypes.indexOf('mipsIInstruction');
    expect(semantic.data.slice(0, 5)).toEqual([0, 0, 3, rTypeIndex, 0]);
    expect(semantic.data.slice(5, 10)).toEqual([1, 0, 4, iTypeIndex, 0]);
  });
});
