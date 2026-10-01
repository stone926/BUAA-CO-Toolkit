import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FoldingRange } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { getMipsFoldingRanges } from '../../../language/mips/folding';
import { MipsServerState } from '../../../language/mips/state';

function doc(text: string): TextDocument {
  return TextDocument.create('test://folding.s', 'mipsasm', 1, text);
}

function state(): MipsServerState {
  return {
    ignoredPseudoInstructionFiles: new Set(),
    ignoredPseudoInstructionMnemonics: new Set()
  };
}

function lineKeys(ranges: FoldingRange[]): string[] {
  return ranges.map((range) => `${range.startLine}-${range.endLine}`);
}

describe('MIPS folding', () => {
  it('folds nested comment region markers', () => {
    const text = [
      '# region outer',
      'nop',
      '# region inner',
      'add $t0, $t0, $t1',
      '# endregion',
      '# endregion'
    ].join('\n');

    const ranges = getMipsFoldingRanges(doc(text), defaultCoSettings, state());

    expect(lineKeys(ranges)).toContain('2-4');
    expect(lineKeys(ranges)).toContain('0-5');
  });

  it('keeps macro declarations out of language folding markers and folds them through LSP', () => {
    const configuration = JSON.parse(readFileSync(resolve(process.cwd(), 'language-configuration/mipsasm.json'), 'utf8')) as {
      folding: { markers: { start: string; end: string } };
    };
    const startMarker = new RegExp(configuration.folding.markers.start);
    const endMarker = new RegExp(configuration.folding.markers.end);

    expect(startMarker.test('# region helpers')).toBe(true);
    expect(endMarker.test('# endregion helpers')).toBe(true);
    expect(startMarker.test('.macro increment(%x)')).toBe(false);
    expect(endMarker.test('.end_macro')).toBe(false);

    const macroRanges = getMipsFoldingRanges(doc([
      '.macro increment(%x)',
      'add %x, %x, 1',
      '.end_macro'
    ].join('\n')), defaultCoSettings, state());

    expect(lineKeys(macroRanges)).toContain('0-2');
  });

  it('does not reuse cached ranges when text changes with the same uri and version', () => {
    const first = getMipsFoldingRanges(doc('# region\nnop\n# endregion'), defaultCoSettings, state());
    const second = getMipsFoldingRanges(doc('nop'), defaultCoSettings, state());

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
