import { describe, expect, it } from 'vitest';
import { Range } from 'vscode-languageserver/node';
import { defaultCoSettings } from '../../../language/common/settings';
import { getVerilogCodeActions } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';
import { positionOf, verilogDoc } from '../../helpers/textDocument';

function actionTitlesAt(document: ReturnType<typeof verilogDoc>, text: string, offset = 0): string[] {
  const position = positionOf(document, text, offset);
  return getVerilogCodeActions(
    document,
    Range.create(position, position),
    [],
    defaultCoSettings,
    new VerilogWorkspaceIndex()
  ).map((action) => action.title);
}

function actionAt(document: ReturnType<typeof verilogDoc>, text: string, title: string) {
  const position = positionOf(document, text);
  return getVerilogCodeActions(
    document,
    Range.create(position, position),
    [],
    defaultCoSettings,
    new VerilogWorkspaceIndex()
  ).find((action) => action.title === title);
}

describe('Verilog instance code actions', () => {
  it('offers an empty port list fix for instances without a port list', () => {
    const document = verilogDoc(`
module child(input a);
endmodule
module top;
    child u_child;
endmodule
`.trim());

    expect(actionTitlesAt(document, 'u_child')).toContain('Add empty instance port list');
  });

  it('offers an explicit empty connection expansion for shorthand ports', () => {
    const document = verilogDoc(`
module child(input a, output b);
endmodule
module top(input a, output y);
    child u_child(.a, .b(y));
endmodule
`.trim());
    const action = actionAt(document, '.a', 'Add explicit empty port connection .a()');

    expect(action?.edit?.changes?.[document.uri]?.[0].newText).toBe('.a()');
  });

  it('converts ordered multiline port connections to named connections without losing indentation', () => {
    const document = verilogDoc(`
module child(input din, output dout);
endmodule
module top(input a, output y);
    child u_ordered(
        a,
        y
    );
endmodule
`.trim());
    const action = actionAt(document, 'u_ordered', 'Convert ordered port connections to named connections');
    const replacement = action?.edit?.changes?.[document.uri]?.[0].newText ?? '';

    expect(replacement).toContain('\n        .din(a),\n        .dout(y)\n    ');
  });

  it('does not return unrelated refactors at ordinary declaration positions', () => {
    const document = verilogDoc(`
module top;
    wire x;
endmodule
`.trim());

    expect(actionTitlesAt(document, 'wire')).not.toEqual(expect.arrayContaining([
      'Add empty instance port list',
      'Fill connections',
      'Convert ordered port connections to named connections'
    ]));
  });
});
