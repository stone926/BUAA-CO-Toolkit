import { describe, expect, it } from 'vitest';
import { mergeCoSettings } from '../../../language/common/settings';
import {
  getMipsDefinition,
  getMipsReferences,
  getMipsRenameEdits
} from '../../../language/mips/service';
import type { MipsServerState } from '../../../language/mips/state';
import { mipsDoc, positionOf } from '../../helpers/textDocument';

function state(): MipsServerState {
  return {
    ignoredPseudoInstructionFiles: new Set(),
    ignoredPseudoInstructionMnemonics: new Set()
  };
}

describe('MIPS navigation and rename', () => {
  it('resolves and renames forward branches, backward jumps, and data labels', () => {
    const document = mipsDoc(`
.data
value: .word 1
.text
main:
  la $t0, value
  beq $t0, $zero, done
  j main
done:
  nop
`.trim());
    const settings = mergeCoSettings({});
    const serverState = state();

    const doneDefinition = getMipsDefinition(document, positionOf(document, 'done'), settings, serverState);
    const valueDefinition = getMipsDefinition(document, positionOf(document, 'value', 1), settings, serverState);
    expect(document.getText(doneDefinition!.range)).toBe('done');
    expect(document.getText(valueDefinition!.range)).toBe('value');

    const mainRefs = getMipsReferences(document, {
      textDocument: { uri: document.uri },
      position: positionOf(document, 'main:'),
      context: { includeDeclaration: true }
    }, settings, serverState);
    expect(mainRefs.map((location) => document.getText(location.range))).toEqual(['main', 'main']);

    const edit = getMipsRenameEdits(document, positionOf(document, 'main:'), 'entry', settings, serverState);
    expect(edit?.changes?.[document.uri]?.map((item) => document.getText(item.range))).toEqual(['main', 'main']);
  });

  it('keeps eqv symbols and macro parameters separate from labels with similar names', () => {
    const document = mipsDoc(`
.eqv COUNT 4
.macro jump_to(%target)
  j %target
.end_macro
.text
COUNT_label:
  li $t0, COUNT
  jump_to(COUNT_label)
`.trim());
    const settings = mergeCoSettings({});
    const serverState = state();

    const eqvDefinition = getMipsDefinition(document, positionOf(document, 'COUNT', 1), settings, serverState);
    expect(document.getText(eqvDefinition!.range)).toBe('COUNT');

    const macroParamEdit = getMipsRenameEdits(document, positionOf(document, '%target'), '%dest', settings, serverState);
    const macroParamTexts = macroParamEdit?.changes?.[document.uri]?.map((item) => document.getText(item.range)) ?? [];
    expect(macroParamTexts).toEqual(['%target', '%target']);
    expect(macroParamTexts).not.toContain('COUNT_label');

    const labelRefs = getMipsReferences(document, {
      textDocument: { uri: document.uri },
      position: positionOf(document, 'COUNT_label:'),
      context: { includeDeclaration: true }
    }, settings, serverState);
    expect(labelRefs.map((location) => document.getText(location.range))).toEqual(['COUNT_label', 'COUNT_label']);
  });
});
