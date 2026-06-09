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

const portText = [
  'module sub(input a, output b, inout c, input clk);',
  'endmodule',
  'module top(input clk, output y);',
  '    wire w;',
  '    sub u(.a(w), .b(w), .c(y), .clk(clk));',
  'endmodule'
].join('\n');

describe('analyzeSignalWiring instance port connections', () => {
  function reportAt(anchor: string, skip: string): ReturnType<typeof analyzeSignalWiring> {
    const document = doc(portText);
    const parsed = parseVerilog(document, defaultCoSettings, false);
    return analyzeSignalWiring(parsed, document, document.positionAt(portText.indexOf(anchor) + skip.length));
  }

  it('does not treat a same-named instance port (.clk) as a use of the signal', () => {
    const report = reportAt('input clk, output y', 'input ');
    expect(report?.name).toBe('clk');
    // Only the `.clk(clk)` expression counts: an input port → reader. The `.clk` port name is excluded.
    expect(report?.readers).toHaveLength(1);
    expect(report?.readers[0].kind).toBe('instancePortReader');
    expect(report?.readers[0].portName).toBe('clk');
    expect(report?.drivers.concat(report?.readers ?? []).some((entry) => entry.kind === 'use')).toBe(false);
  });

  it('classifies input ports as readers and output ports as drivers', () => {
    const report = reportAt('wire w', 'wire ');
    expect(report?.name).toBe('w');
    expect(report?.drivers.some((entry) => entry.kind === 'instancePortDriver' && entry.portName === 'b')).toBe(true);
    expect(report?.readers.some((entry) => entry.kind === 'instancePortReader' && entry.portName === 'a')).toBe(true);
    expect(report?.drivers.concat(report?.readers ?? []).some((entry) => entry.kind === 'use')).toBe(false);
  });

  it('counts an inout port connection as both a driver and a reader', () => {
    const report = reportAt('output y', 'output ');
    expect(report?.name).toBe('y');
    expect(report?.drivers.some((entry) => entry.kind === 'instancePortDriver' && entry.portName === 'c')).toBe(true);
    expect(report?.readers.some((entry) => entry.kind === 'instancePortReader' && entry.portName === 'c')).toBe(true);
  });
});
