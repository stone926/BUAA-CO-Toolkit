import { describe, expect, it } from 'vitest';
import { Diagnostic, Range } from 'vscode-languageserver/node';
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

    expect(actionTitlesAt(document, 'u_child')).toContain('添加空的实例端口列表');
  });

  it('offers an explicit empty connection expansion for shorthand ports', () => {
    const document = verilogDoc(`
module child(input a, output b);
endmodule
module top(input a, output y);
    child u_child(.a, .b(y));
endmodule
`.trim());
    const action = actionAt(document, '.a', '显式添加空端口连接 .a()');

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
    const action = actionAt(document, 'u_ordered', '将位置端口连接转换为命名连接');
    const replacement = action?.edit?.changes?.[document.uri]?.[0].newText ?? '';

    expect(replacement).toContain('\n        .din(a),\n        .dout(y)\n    ');
  });

  it('names ordered parameter overrides after the overridable parameters, skipping localparams', () => {
    const document = verilogDoc(`
module child(din);
    localparam L = 1;
    parameter W = 4;
    input [W-1:0] din;
endmodule
module top(input [7:0] a);
    child #(8) u_ordered(.din(a));
endmodule
`.trim());
    const action = actionAt(document, 'u_ordered', '将位置参数赋值转换为命名赋值');

    expect(action?.edit?.changes?.[document.uri]?.[0].newText).toContain('.W(8)');
  });

  it('does not return unrelated refactors at ordinary declaration positions', () => {
    const document = verilogDoc(`
module top;
    wire x;
endmodule
`.trim());

    expect(actionTitlesAt(document, 'wire')).not.toEqual(expect.arrayContaining([
      '添加空的实例端口列表',
      '补全端口连接',
      '将位置端口连接转换为命名连接'
    ]));
  });
});

describe('Verilog diagnostic code actions', () => {
  it('deduplicates identical wire insertions while preserving fixes at different positions', () => {
    const document = verilogDoc('module top(a, b);\ninput a;\ninput b;\nendmodule');
    const diagnostics: Diagnostic[] = [1, 1, 2].map((line) => ({
      code: 'explicit-port-wire',
      message: 'port needs explicit wire',
      range: Range.create(line, 0, line, 5)
    }));
    const actions = getVerilogCodeActions(document, diagnostics[0].range, diagnostics, defaultCoSettings, new VerilogWorkspaceIndex());
    const edits = actions.flatMap((action) => action.edit?.changes?.[document.uri] ?? []);

    expect(actions.map((action) => action.title)).toEqual([
      '在端口声明中显式添加 wire',
      '在端口声明中显式添加 wire'
    ]);
    expect(edits.map((edit) => edit.range.start)).toEqual([
      { line: 1, character: 5 },
      { line: 2, character: 5 }
    ]);
    expect(edits.every((edit) => edit.newText === ' wire')).toBe(true);
  });
});
