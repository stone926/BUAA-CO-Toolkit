import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { parseVerilog } from '../../../language/verilog/parser';
import { collectInstanceConnectionDiagnostics } from '../../../language/verilog/instanceConnectionDiagnostics';
import { instanceArrayElementCount, instancePortConnectionWidths } from '../../../language/verilog/instanceArray';
import type { Diagnostic } from 'vscode-languageserver-types';

function parsed(text: string, uri = 'test://arrays.v') {
  const document = TextDocument.create(uri, 'verilog', 1, text);
  return { document, result: parseVerilog(document, defaultCoSettings, true) };
}
const target = 'module sub #(parameter W=8)(input [W-1:0] a, output [W-1:0] y); assign y=a; endmodule';

describe('Verilog instance array port semantics', () => {
  it.each([8, 32])('accepts a %i-bit broadcast or partitioned connection to four eight-bit instances', (width) => {
    const { result, document } = parsed(`${target}\nmodule m(input [${width-1}:0] a, output [${width-1}:0] y); sub u[3:0](a,y); endmodule`);
    const module = result.modules[1], instance = module.instances[0];
    expect(result.diagnostics.filter((item) => item.code === 'port-width-mismatch')).toEqual([]);
    expect(document.getText(instance.arrayRange!.range)).toBe('[3:0]');
    expect(instance.arrayRange!.expressions).toHaveLength(2);
    expect(instanceArrayElementCount(instance, module)).toBe(4n);
    expect(instancePortConnectionWidths(instance, 8, module)).toEqual([8, 32]);
  });

  it.each([1, 16, 40])('reports a %i-bit connection that matches neither legal instance-array width', (width) => {
    const { result } = parsed(`${target}\nmodule m(input [${width-1}:0] a, output [${width-1}:0] y); sub u[3:0](a,y); endmodule`);
    const diagnostics = result.diagnostics.filter((item) => item.code === 'port-width-mismatch');
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((item) => item.message.includes('8 or 32'))).toBe(true);
  });

  it('uses parent constants for ascending array ranges and target overrides for effective port widths', () => {
    const { result } = parsed(`${target}\nmodule m(input [7:0] a, output [7:0] y); localparam N=4; sub #(.W(2)) u[0:N-1](a,y); endmodule`);
    expect(result.diagnostics.filter((item) => item.code === 'port-width-mismatch')).toEqual([]);
    expect(instanceArrayElementCount(result.modules[1].instances[0], result.modules[1])).toBe(4n);
  });

  it('reports malformed array ranges rather than treating them as unbounded instance arrays', () => {
    const { result } = parsed(`${target}\nmodule m(input [7:0] a, output [7:0] y); sub u[3](a,y); endmodule`);
    expect(result.diagnostics.map((item) => item.code)).toContain('syntax-malformed-instance');
  });

  it('shares array width validation with modules resolved from another source document', () => {
    const child = parsed(target, 'test://sub.v').result.modules[0];
    const { result, document } = parsed('module m(input [31:0] a, output [31:0] y); sub u[3:0](a,y); endmodule');
    const parent = result.modules[0];
    const diagnostics: Diagnostic[] = [];
    collectInstanceConnectionDiagnostics(document, parent, parent.instances[0], child, diagnostics);
    expect(diagnostics.filter((item) => item.code === 'port-width-mismatch')).toEqual([]);
  });
});
