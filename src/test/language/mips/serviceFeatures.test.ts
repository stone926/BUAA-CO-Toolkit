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

interface DecodedToken {
  line: number;
  character: number;
  length: number;
  type: number;
}

function doc(text: string): TextDocument {
  return TextDocument.create('test://features.s', 'mipsasm', 1, text);
}

function state(): MipsServerState {
  return {
    ignoredPseudoInstructionFiles: new Set(),
    ignoredPseudoInstructionMnemonics: new Set()
  };
}

function decode(data: number[]): DecodedToken[] {
  const tokens: DecodedToken[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < data.length; index += 5) {
    line += data[index];
    character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
    tokens.push({
      line,
      character,
      length: data[index + 2],
      type: data[index + 3]
    });
  }
  return tokens;
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

  it('keeps ordinary registers and CP0 registers as distinct semantic token types', () => {
    const semantic = decode(getMipsSemanticTokens(doc('mfc0 $t0, $12'), mergeCoSettings({}), state()).data);
    const registerType = mipsSemanticTokenTypes.indexOf('mipsRegister');
    const cp0RegisterType = mipsSemanticTokenTypes.indexOf('mipsCp0Register');

    expect(semantic).toContainEqual({
      line: 0,
      character: 5,
      length: 3,
      type: registerType
    });
    expect(semantic).toContainEqual({
      line: 0,
      character: 10,
      length: 3,
      type: cp0RegisterType
    });
  });
});
