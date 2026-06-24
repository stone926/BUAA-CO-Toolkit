import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';

let version = 1;

function implicitNetNames(text: string): string[] {
  const document = TextDocument.create(`test://task-${version}.v`, 'verilog', version++, text.trim());
  return getVerilogDiagnostics(document, mergeCoSettings({}))
    .map((diagnostic) => (typeof diagnostic.code === 'string' ? diagnostic.code : ''))
    .filter((code) => code.startsWith('implicit-net:'))
    .map((code) => code.slice('implicit-net:'.length));
}

describe('Verilog task/function declarations', () => {
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
