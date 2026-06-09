import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { parseVerilog } from '../../../language/verilog/parser';
import { analyzeSignalWiring } from '../../../language/verilog/signalWiring';

function doc(text: string): TextDocument {
  return TextDocument.create('test://wiring.v', 'verilog', 1, text);
}

const source = [
  'module alu(input [31:0] a, input [31:0] b, output [31:0] result);',
  '    assign result = a + b;',
  'endmodule',
  'module regfile(input [31:0] din, output [31:0] dout);',
  '    assign dout = din;',
  'endmodule',
  'module top(input clk, input [31:0] x, output [31:0] y);',
  '    wire [31:0] sig;',
  '    reg [31:0] r;',
  '    assign sig = x;',
  '    always @(posedge clk) begin',
  '        r <= sig;',
  '    end',
  '    alu u_alu(.a(x), .b(x), .result(sig));',
  '    regfile u_rf(.din(sig), .dout(y));',
  'endmodule'
].join('\n');

describe('analyzeSignalWiring', () => {
  it('classifies declaration, drivers and readers of a signal', () => {
    const document = doc(source);
    const parsed = parseVerilog(document, defaultCoSettings, false);
    const report = analyzeSignalWiring(parsed, document, document.positionAt(source.indexOf('sig;')));

    expect(report).toBeDefined();
    expect(report?.name).toBe('sig');
    expect(report?.moduleName).toBe('top');
    expect(report?.declaration?.detail).toContain('sig');

    // drivers: assign sig = x  +  u_alu output port .result(sig)
    expect(report?.drivers).toHaveLength(2);
    const assignDriver = report?.drivers.find((entry) => entry.kind === 'assign');
    expect(assignDriver?.operator).toBe('=');
    const portDriver = report?.drivers.find((entry) => entry.kind === 'instancePortDriver');
    expect(portDriver?.instanceName).toBe('u_alu');
    expect(portDriver?.portName).toBe('result');

    // readers: r <= sig (RHS use)  +  u_rf input port .din(sig)
    expect(report?.readers).toHaveLength(2);
    expect(report?.readers.some((entry) => entry.kind === 'use')).toBe(true);
    const portReader = report?.readers.find((entry) => entry.kind === 'instancePortReader');
    expect(portReader?.instanceName).toBe('u_rf');
    expect(portReader?.portName).toBe('din');
  });

  it('resolves the same signal from a use occurrence inside a port connection', () => {
    const document = doc(source);
    const parsed = parseVerilog(document, defaultCoSettings, false);
    const offset = source.indexOf('din(sig)') + 'din('.length;
    const report = analyzeSignalWiring(parsed, document, document.positionAt(offset));
    expect(report?.name).toBe('sig');
    expect(report?.moduleName).toBe('top');
  });

  it('returns undefined when the cursor is not on a signal', () => {
    const document = doc(source);
    const parsed = parseVerilog(document, defaultCoSettings, false);
    const report = analyzeSignalWiring(parsed, document, document.positionAt(source.indexOf('always')));
    expect(report).toBeUndefined();
  });
});
