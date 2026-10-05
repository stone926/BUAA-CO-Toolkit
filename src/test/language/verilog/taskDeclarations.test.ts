import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics, getVerilogHover } from '../../../language/verilog/service';
import { parseModules, widthOfDecl, widthOfExpression } from '../../../language/verilog/parser';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let version = 1;

function implicitNetNames(text: string): string[] {
  const document = TextDocument.create(`test://task-${version}.v`, 'verilog', version++, text.trim());
  return getVerilogDiagnostics(document, mergeCoSettings({}))
    .map((diagnostic) => (typeof diagnostic.code === 'string' ? diagnostic.code : ''))
    .filter((code) => code.startsWith('implicit-net:'))
    .map((code) => code.slice('implicit-net:'.length));
}

describe('Verilog task/function declarations', () => {
  it('preserves parameterized function return widths for assignments, calls and hover', () => {
    const text = `
module hazard #(parameter BITS = 4)(input [3:0] ready, output [3:0] result);
    function automatic [BITS-1:0] remaining;
        input [3:0] when_ready, stage;
        begin remaining = when_ready == 15 ? 4'd15 : when_ready > stage ? when_ready-stage : 4'd0; end
    endfunction
    assign result = remaining(ready, 1);
endmodule
`;
    const document = TextDocument.create('test://function-width.v', 'verilog', 1, text);
    const settings = mergeCoSettings({});
    const module = parseModules(document, text)[0];
    const decl = module.declarations.get('remaining')!;
    expect(decl.width).toBe('[BITS-1:0]');
    expect(widthOfDecl(decl, module).width).toBe(4);
    expect(widthOfExpression('remaining(ready, 1)', module).width).toBe(4);
    expect(getVerilogDiagnostics(document, settings).filter((d) => d.code === 'width-mismatch')).toEqual([]);
    const hover = getVerilogHover(document, document.positionAt(text.indexOf('remaining;')), settings, new VerilogWorkspaceIndex());
    expect(hover?.contents).toMatchObject({ value: expect.stringContaining('返回位宽：`4` 位') });
  });

  it('reports actual truncation both into a function return and from a function call', () => {
    const text = `
module m(input [7:0] data, output [1:0] result);
    function [3:0] narrow(input [7:0] value);
        begin narrow = value; end
    endfunction
    assign result = narrow(data);
endmodule
`;
    const document = TextDocument.create('test://function-truncation.v', 'verilog', 1, text);
    const warnings = getVerilogDiagnostics(document, mergeCoSettings({})).filter((d) => d.code === 'width-mismatch');
    expect(warnings).toHaveLength(2);
    expect(warnings.map((d) => d.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("'narrow' is 4 bit(s), but this expression is 8 bit(s)"),
      expect.stringContaining("'result' is 2 bit(s), but this expression is 4 bit(s)")
    ]));
  });

  it.each([
    ['', 1], ['signed', 1], ['integer', 32], ['time', 64], ['real', undefined], ['realtime', undefined], ['[UNKNOWN-1:0]', undefined]
  ])('handles %s function return types without inventing widths', (returnType, expected) => {
    const text = `module m; function ${returnType} f(input value); begin f = value; end endfunction endmodule`;
    const document = TextDocument.create(`test://function-type-${version++}.v`, 'verilog', 1, text);
    const module = parseModules(document, text)[0];
    expect(widthOfExpression('f(0)', module).width).toBe(expected);
  });

  it('does not report the task name or its locals as implicit nets', () => {
    const names = implicitNetNames(`
module tb;
    reg clk;
    task dump_register_file;
        integer i;
        integer file_handle;
        begin
            file_handle = $fopen("reg_results.txt", "w");
            for (i = 0; i < 32; i = i + 1) begin
                $fdisplay(file_handle, "Reg[%2d] = %h", i, i);
            end
            $fclose(file_handle);
        end
    endtask
endmodule
`);
    expect(names).not.toContain('dump_register_file');
    expect(names).not.toContain('i');
    expect(names).not.toContain('file_handle');
    expect(names).toHaveLength(0);
  });

  it('resolves a task name at its call site', () => {
    const names = implicitNetNames(`
module tb;
    task do_thing;
        reg [7:0] tmp;
        begin
            tmp = 8'h1;
        end
    endtask
    initial begin
        do_thing;
    end
endmodule
`);
    expect(names).not.toContain('do_thing');
    expect(names).not.toContain('tmp');
  });

  it('knows a function name and its arguments', () => {
    const names = implicitNetNames(`
module m(output [7:0] y);
    function [7:0] add_one(input [7:0] value);
        begin
            add_one = value + 8'h1;
        end
    endfunction
    assign y = add_one(8'h10);
endmodule
`);
    expect(names).not.toContain('add_one');
    expect(names).not.toContain('value');
  });

  it('does not report system tasks used without argument parentheses as implicit nets', () => {
    const names = implicitNetNames(`
module tb;
    integer file_handle;
    initial begin
        $finish;
        $stop;
        $fclose(file_handle);
    end
endmodule
`);
    expect(names).not.toContain('$finish');
    expect(names).not.toContain('$stop');
    expect(names).not.toContain('$fclose');
    expect(names).toHaveLength(0);
  });

  it('does not report macro aliases used as expressions or assignment targets as implicit nets', () => {
    const names = implicitNetNames(`
\`define IDLE 2'b00
\`define LOAD 2'b01
\`define ctrl mem[0]
\`define preset mem[1]
\`define count mem[2]
module TC(input clk, output IRQ);
    reg [1:0] state;
    reg [31:0] mem [2:0];
    assign IRQ = \`ctrl[3];
    always @(posedge clk) begin
        case (state)
            \`IDLE: state <= \`LOAD;
            \`LOAD: \`count <= \`preset;
        endcase
    end
endmodule
`);
    expect(names).not.toContain('`ctrl');
    expect(names).not.toContain('`count');
    expect(names).not.toContain('`preset');
    expect(names).not.toContain('`IDLE');
    expect(names).not.toContain('`LOAD');
  });
});
