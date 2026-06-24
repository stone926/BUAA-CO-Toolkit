import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { parseVerilog } from '../../../language/verilog/parser';
import { analyzeSignalWiring } from '../../../language/verilog/signalWiring';
import { VerilogModule } from '../../../language/verilog/model';

function doc(text: string): TextDocument {
  return TextDocument.create('test://wiring.v', 'verilog', 1, text);
}

/** Helper: 将模块数组包装为 getExternalModule 回调 */
function externalModulesFromArray(modules: VerilogModule[]): (name: string) => VerilogModule | undefined {
  return (name: string) => modules.find((m) => m.name === name);
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
    expect(report?.unresolved).toHaveLength(0);

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

  it('classifies blocking assignments inside always blocks as always drivers', () => {
    const text = [
      'module top(input a, output reg y);',
      '    always @(*) y = a;',
      'endmodule'
    ].join('\n');
    const document = doc(text);
    const parsed = parseVerilog(document, defaultCoSettings, false);
    const report = analyzeSignalWiring(parsed, document, document.positionAt(text.indexOf('output reg y') + 'output reg '.length));

    expect(report?.drivers).toHaveLength(1);
    expect(report?.drivers[0].kind).toBe('always');
    expect(report?.drivers[0].operator).toBe('=');
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

const systemTaskModuleSource = [
  'module display(input [3:0] val, output [6:0] seg);',
  '    assign seg = val < 10 ? val + 48 : val + 55;',
  'endmodule',
  'module top(input [3:0] value, output [6:0] seg);',
  '    display u(.val(value), .seg(seg));',
  'endmodule'
].join('\n');

describe('analyzeSignalWiring with module named after system task', () => {
  it('recognizes a module instance when the module name matches a system task name', () => {
    const document = doc(systemTaskModuleSource);
    const parsed = parseVerilog(document, defaultCoSettings, false);
    // Verify the instance IS parsed
    const top = parsed.modules.find((m) => m.name === 'top');
    expect(top?.instances).toHaveLength(1);
    expect(top?.instances[0].moduleName).toBe('display');
    expect(top?.instances[0].instanceName).toBe('u');

    // value connects to display.val (input) → should be a reader
    const valueOffset = systemTaskModuleSource.indexOf('(value)') + 1;
    const report = analyzeSignalWiring(parsed, document, document.positionAt(valueOffset));
    expect(report?.name).toBe('value');
    expect(report?.readers.some((entry) => entry.kind === 'instancePortReader' && entry.portName === 'val')).toBe(true);
    expect(report?.drivers).toHaveLength(0);
    expect(report?.unresolved).toHaveLength(0);

    // seg connects to display.seg (output) → should be a driver
    const segOffset = systemTaskModuleSource.indexOf('(seg)') + 1;
    const segReport = analyzeSignalWiring(parsed, document, document.positionAt(segOffset));
    expect(segReport?.name).toBe('seg');
    expect(segReport?.drivers.some((entry) => entry.kind === 'instancePortDriver' && entry.portName === 'seg')).toBe(true);
  });
});

const crossFileBeSource = [
  'module BE(',
  '    input [31:0] addr,',
  '    output [3:0] MemByteWrite,',
  '    output [31:0] fixed_data',
  ');',
  'endmodule'
].join('\n');

const crossFileTopSource = [
  'module mips();',
  '    wire [31:0] M_addr;',
  '    wire [3:0] M_MemByteWrite;',
  '    wire [31:0] M_fixed_WD_Mem;',
  '    BE BE (.addr(M_addr), .MemByteWrite(M_MemByteWrite), .fixed_data(M_fixed_WD_Mem));',
  'endmodule'
].join('\n');

describe('analyzeSignalWiring cross-file', () => {
  it('classifies cross-file output port as driver and input port as reader', () => {
    const beDoc = doc(crossFileBeSource);
    const topDoc = doc(crossFileTopSource);
    const beParsed = parseVerilog(beDoc, defaultCoSettings, false);
    const topParsed = parseVerilog(topDoc, defaultCoSettings, false);
    const getExternal = externalModulesFromArray(beParsed.modules);

    // M_MemByteWrite → BE.MemByteWrite (output) → driver
    const driverReport = analyzeSignalWiring(topParsed, topDoc, topDoc.positionAt(crossFileTopSource.indexOf('M_MemByteWrite;')), getExternal);
    expect(driverReport?.name).toBe('M_MemByteWrite');
    expect(driverReport?.drivers.some((entry) => entry.kind === 'instancePortDriver' && entry.portName === 'MemByteWrite')).toBe(true);
    expect(driverReport?.readers).toHaveLength(0);
    expect(driverReport?.unresolved).toHaveLength(0);

    // M_addr → BE.addr (input) → reader
    const readerReport = analyzeSignalWiring(topParsed, topDoc, topDoc.positionAt(crossFileTopSource.indexOf('M_addr;')), getExternal);
    expect(readerReport?.name).toBe('M_addr');
    expect(readerReport?.readers.some((entry) => entry.kind === 'instancePortReader' && entry.portName === 'addr')).toBe(true);
    expect(readerReport?.drivers).toHaveLength(0);
  });

  it('marks port connections as unresolved when the target module is not found', () => {
    const topDoc = doc(crossFileTopSource);
    const topParsed = parseVerilog(topDoc, defaultCoSettings, false);
    // 不提供外部模块 — BE 模块不在当前文件中，应标记为 unresolved
    const report = analyzeSignalWiring(topParsed, topDoc, topDoc.positionAt(crossFileTopSource.indexOf('M_MemByteWrite;')));
    expect(report?.name).toBe('M_MemByteWrite');
    expect(report?.drivers).toHaveLength(0);
    expect(report?.readers).toHaveLength(0);
    expect(report?.unresolved).toHaveLength(1);
    expect(report?.unresolved[0].kind).toBe('instancePortUnresolved');
    expect(report?.unresolved[0].portName).toBe('MemByteWrite');
    expect(report?.unresolved[0].instanceName).toBe('BE');
  });

  it('returns empty unresolved when getExternalModule returns undefined', () => {
    const topDoc = doc(crossFileTopSource);
    const topParsed = parseVerilog(topDoc, defaultCoSettings, false);
    // getExternalModule always returns undefined → still unresolved
    const report = analyzeSignalWiring(topParsed, topDoc, topDoc.positionAt(crossFileTopSource.indexOf('M_MemByteWrite;')), () => undefined);
    expect(report?.unresolved).toHaveLength(1);
    expect(report?.unresolved[0].kind).toBe('instancePortUnresolved');
  });
});
