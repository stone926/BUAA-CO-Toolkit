import { describe, expect, it } from 'vitest';
import { Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { getVerilogCodeActions } from '../../../language/verilog/codeActions';
import { getVerilogHover } from '../../../language/verilog/hover';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

function actions(source: string, marker: string) {
  const document = TextDocument.create('file:///constant-actions.v', 'verilog', 1, source);
  const position = document.positionAt(source.indexOf(marker));
  const index = new VerilogWorkspaceIndex();
  const result = getVerilogCodeActions(document, Range.create(position, position), [], defaultCoSettings, index);
  return { document, position, index, result };
}

describe('constant refactor context', () => {
  it('preserves assignment-context sizing in folding, extraction and hover', () => {
    const { document, position, index, result } = actions("module m; wire [7:0] y;\nassign y=4'hf + 4'h1; endmodule", '+');
    const folded = result.find((action) => action.title === 'Fold constant expression to 16');
    expect(folded?.edit?.changes?.[document.uri]?.[0].newText).toBe("8'h10");
    const extracted = result.find((action) => action.title.includes('localparam EXPR_CONST'));
    expect(extracted?.edit?.changes?.[document.uri]?.[0].newText).toContain("localparam EXPR_CONST = 8'h10;");
    expect(JSON.stringify(getVerilogHover(document, position, defaultCoSettings, index))).toContain('16');
  });

  it('preserves parent comparison sizing when folding a nested operand', () => {
    const { document, result } = actions("module m; wire y; assign y=(4'hf + 4'h1)==8'h10; endmodule", '+');
    const folded = result.find((action) => action.title === 'Fold constant expression to 16');
    expect(folded?.edit?.changes?.[document.uri]?.[0].newText).toBe("8'h10");
  });

  it('preserves signedness and width of a nested arithmetic shift', () => {
    const { document, result } = actions("module m; wire [7:0] y; assign y=(8'sh80 >>> 1) + 8'h0; endmodule", '>>>');
    expect(result.find((action) => action.title === 'Fold constant expression to 64')?.edit?.changes?.[document.uri]?.[0].newText).toBe("8'h40");
  });

  it('withholds rewrites when the enclosing expression cannot be evaluated safely', () => {
    const { result } = actions("module m(input [7:0] a, output [7:0] y); assign y=a+(4'hf + 4'h1); endmodule", ' + ');
    expect(result.some((action) => action.title.startsWith('Fold constant') || action.title.includes('localparam EXPR_CONST'))).toBe(false);
  });
});
