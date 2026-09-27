import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogCodeActions, getVerilogDiagnostics } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let documentVersion = 1;

function doc(text: string): TextDocument {
  return TextDocument.create(`test://lint-${documentVersion}.v`, 'verilog', documentVersion++, text);
}

function diagnosticCodes(text: string): string[] {
  return diagnosticCodesWithSettings(text, {});
}

function diagnosticCodesWithSettings(text: string, settingsValue: unknown): string[] {
  return getVerilogDiagnostics(doc(text), mergeCoSettings(settingsValue))
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

describe('Verilog diagnostic behavior', () => {
  it('removes style diagnostics even when legacy settings explicitly enabled them', () => {
    const text = `module demo(input clk, input rst, input [3:0] a, inout bus, output reg [3:0] y);
  wire [3:0] W_t_rsuse;
  wire mux;
  reg [3:0] state = 4'd3;
  initial state = 4'd2;
  always @(a) begin
    if (a) y <= 4'd3;
    case (a) 0: y = 4'd2; endcase
  end
  always @(negedge clk or posedge rst) begin
    state = a * 4'd3;
  end
endmodule`;
    for (const settings of [{}, { verilog: { lint: { courseRules: true, disabledRules: [], synthesizableHints: true } } }]) {
      const codes = diagnosticCodesWithSettings(text, settings);
      expect(codes.filter((code) => /^(vc-|synth-)|^mixed-assignment$/.test(code))).toEqual([]);
    }
  });

  it('retains undeclared identifier, width and syntax diagnostics', () => {
    expect(diagnosticCodes('module demo(output [3:0] y); assign y = missing; endmodule'))
      .toContain('implicit-net:missing');
    expect(diagnosticCodes('module demo(input [7:0] a, output [3:0] y); assign y = a; endmodule'))
      .toContain('width-mismatch');
    expect(diagnosticCodes('module demo;')).toContain('missing-endmodule');
  });

  it('does not offer obsolete style quick fixes for stale diagnostics', () => {
    const document = doc('module demo(input a, output reg y); always @* case(a) 0: y = 0; endcase endmodule');
    const diagnostic = { range: Range.create(0, 51, 0, 83), message: 'VC-008', code: 'vc-008-case-default' };
    const actions = getVerilogCodeActions(document, diagnostic.range, [diagnostic], mergeCoSettings({}), new VerilogWorkspaceIndex());
    expect(actions.some((action) => action.title === 'Add default case item' || action.command?.command === 'co.verilog.disableLintRule')).toBe(false);
  });

  it('keeps width suppression scope explicit while targeting the diagnostic document root', () => {
    const document = doc('module demo; endmodule');
    const diagnostic = {
      range: Range.create(0, 0, 0, 6),
      message: 'width mismatch',
      severity: DiagnosticSeverity.Warning,
      code: 'width-mismatch'
    };

    const actions = getVerilogCodeActions(
      document,
      diagnostic.range,
      [diagnostic],
      mergeCoSettings({}),
      new VerilogWorkspaceIndex()
    ).filter((action) => action.command?.command === 'co.diagnostics.disableCode');

    expect(actions.map((action) => action.command?.arguments)).toEqual([
      ['verilog', 'width-mismatch', 'file', document.uri],
      ['verilog', 'width-mismatch', 'workspace', document.uri]
    ]);
  });

  it('recognizes common delayed testbench clock generation forms', () => {
    const clockGenerators = [
      'always #2 clk <= ~clk;',
      'always begin #2 clk = ~clk; end',
      'always begin #2; clk = ~clk; end',
      'initial begin forever #5 clk = ~clk; end',
      'initial begin forever begin #5; clk = ~clk; end end'
    ];

    for (const clockGenerator of clockGenerators) {
      const text = `
\`timescale 1ns / 1ps
module cpu_tb;
    reg clk;
    reg reset;
    reg [31:0] inst [0:4095];
    initial begin
        $readmemh("code.txt", inst);
        clk = 1'b0;
        reset = 1'b1;
        #20 reset = 1'b0;
    end
    ${clockGenerator}
endmodule
`.trim();
      const codes = diagnosticCodes(text);
      expect(codes).not.toContain('tb-clock');
    }
  });

  it('still reports testbench modules without time-driven clock generation', () => {
    const text = `
\`timescale 1ns / 1ps
module cpu_tb;
    reg clk;
    reg reset;
    reg [31:0] inst [0:4095];
    initial begin
        $readmemh("code.txt", inst);
        reset = 1'b1;
        #20 reset = 1'b0;
    end
    always @(posedge clk) begin
        reset <= reset;
    end
endmodule
`.trim();
    const codes = diagnosticCodes(text);
    expect(codes).toContain('tb-clock');
  });

  it('does not treat event-controlled delayed toggles as free-running testbench clocks', () => {
    const eventControlledBlocks = [
      `
    always @(posedge reset) begin
        #2 clk <= ~clk;
    end`,
      `
    always begin
        @(posedge reset);
        #2 clk <= ~clk;
    end`,
      `
    always begin
        @(posedge reset) #2 clk <= ~clk;
    end`,
      `
    always begin
        if (reset) begin
            @(posedge reset);
        end
        #2 clk <= ~clk;
    end`
    ];

    for (const eventControlledBlock of eventControlledBlocks) {
      const text = `
\`timescale 1ns / 1ps
module cpu_tb;
    reg clk;
    reg reset;
    reg [31:0] inst [0:4095];
    initial begin
        $readmemh("code.txt", inst);
        reset = 1'b1;
        #20 reset = 1'b0;
    end
    ${eventControlledBlock}
endmodule
`.trim();
      const codes = diagnosticCodes(text);
      expect(codes).toContain('tb-clock');
    }
  });

  it('does not report declarations after procedural blocks as implicit nets', () => {
    const text = `
module test(input clk, input reset, input w_grf_we, input [4:0] w_grf_addr, input [31:0] w_inst_addr, input [31:0] w_grf_wdata);
    always @(posedge clk) begin
        if (~reset) begin
            if (w_grf_we && (w_grf_addr != 0)) begin
                $display("%d@%h: $%d <= %h", $time, w_inst_addr, w_grf_addr, w_grf_wdata);
            end
        end
    end

    wire [31:0] fixed_macroscopic_pc;
endmodule
`.trim();
    const codes = diagnosticCodes(text);
    expect(codes).not.toContain('implicit-net:fixed_macroscopic_pc');
  });

  it('does not report ANSI port declarations that omit wire under default_nettype none', () => {
    const text = `
\`default_nettype none
module mips(
    input clk,
    input wire reset,
    output [31:0] instr,
    output reg done
);
endmodule
`.trim();
    const diagnostics = getVerilogDiagnostics(doc(text), mergeCoSettings({}));
    const explicitWireDiagnostics = diagnostics.filter((diagnostic) => diagnostic.code === 'explicit-port-wire');
    expect(explicitWireDiagnostics).toHaveLength(0);
  });

  it('does not report inherited ANSI port net types under default_nettype none', () => {
    const text = `
\`default_nettype none
module mips(
    input clk, reset,
    input wire enable,
    output [31:0] instr, pc,
    output reg done
);
endmodule
`.trim();
    const diagnostics = getVerilogDiagnostics(doc(text), mergeCoSettings({}))
      .filter((diagnostic) => diagnostic.code === 'explicit-port-wire');
    expect(diagnostics).toHaveLength(0);
  });

  it('reports old-style body port declarations that omit wire under default_nettype none', () => {
    const text = `
\`default_nettype none
module mips(clk, reset);
    input clk;
    input wire reset;
endmodule
`.trim();
    const codes = diagnosticCodes(text);
    expect(codes.filter((code) => code === 'explicit-port-wire')).toHaveLength(1);
  });

  it('offers a quick fix to add explicit wire to a port declaration', () => {
    const text = `
\`default_nettype none
module mips(clk, reset);
    input clk;
    input wire reset;
endmodule
`.trim();
    const document = doc(text);
    const settings = mergeCoSettings({});
    const diagnostics = getVerilogDiagnostics(document, settings);
    const explicitWire = diagnostics.find((diagnostic) => diagnostic.code === 'explicit-port-wire');
    expect(explicitWire).toBeDefined();

    const actions = getVerilogCodeActions(document, explicitWire!.range, [explicitWire!], settings, new VerilogWorkspaceIndex());
    const action = actions.find((candidate) => candidate.title === 'Add explicit wire to port declaration');
    const edit = action?.edit?.changes?.[document.uri]?.[0];
    expect(edit?.newText).toBe(' wire');
    expect(edit?.range.start).toEqual(explicitWire!.range.end);
  });

  it('offers a quick fix that declares undeclared wires on a new module body line', () => {
    const text = `
module demo(output y);
    assign y = missing;
endmodule
`.trim();
    const document = doc(text);
    const settings = mergeCoSettings({});
    const diagnostics = getVerilogDiagnostics(document, settings);
    const implicit = diagnostics.find((diagnostic) => diagnostic.code === 'implicit-net:missing');
    expect(implicit).toBeDefined();

    const actions = getVerilogCodeActions(document, implicit!.range, [implicit!], settings, new VerilogWorkspaceIndex());
    const action = actions.find((candidate) => candidate.title === 'Declare wire missing');
    const edit = action?.edit?.changes?.[document.uri]?.[0];
    expect(edit?.newText).toBe('    wire missing;\n');
    expect(edit?.range.start).toEqual({ line: 1, character: 0 });
  });

});
