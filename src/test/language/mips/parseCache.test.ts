import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { clearCachedMipsParse, getCachedMipsParse } from '../../../language/mips/parseCache';
import { MipsServerState } from '../../../language/mips/state';

describe('MIPS parse cache', () => {
  afterEach(() => {
    clearCachedMipsParse();
  });

  it('keeps recent parse results for multiple open documents', () => {
    const state = mipsState();
    const firstDoc = doc('test://mips-cache/first.asm', 'main:\n  nop\n');
    const secondDoc = doc('test://mips-cache/second.asm', 'other:\n  nop\n');

    const first = getCachedMipsParse(firstDoc, defaultCoSettings, state);
    getCachedMipsParse(secondDoc, defaultCoSettings, state);

    expect(getCachedMipsParse(firstDoc, defaultCoSettings, state)).toBe(first);
  });
});

function doc(uri: string, text: string): TextDocument {
  return TextDocument.create(uri, 'mipsasm', 1, text);
}

function mipsState(): MipsServerState {
  return {
    ignoredPseudoInstructionFiles: new Set(),
    ignoredPseudoInstructionMnemonics: new Set()
  };
}
