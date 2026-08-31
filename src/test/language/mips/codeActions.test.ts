import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Commands } from '../../../constants';
import { getMipsCodeActions } from '../../../language/mips/codeActions';

describe('MIPS code actions', () => {
  it('passes the diagnostic document URI to the workspace warning setting command', () => {
    const document = TextDocument.create('file:///E:/work/main.asm', 'mipsasm', 1, 'move $t0, $t1');
    const actions = getMipsCodeActions(document, [{
      range: Range.create(0, 0, 0, 4),
      message: 'pseudo instruction',
      severity: DiagnosticSeverity.Warning,
      code: 'pseudo-instruction:move'
    }]);

    const disableAction = actions.find((action) => action.command?.command === Commands.Mips.DisablePseudoWarnings);
    expect(disableAction?.command?.arguments).toEqual([document.uri]);
  });
});
