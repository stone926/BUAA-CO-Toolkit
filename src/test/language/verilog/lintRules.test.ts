import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogCodeActions, getVerilogDiagnostics } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let documentVersion = 1;

function doc(text: string): TextDocument {
  return TextDocument.create(`test://lint-${documentVersion}.v`, 'verilog', documentVersion++, text);
}

function diagnosticCodes(text: string, disabledRules?: string[]): string[] {
  const settings = mergeCoSettings({
    verilog: {
      lint: {
        disabledRules
      }
    }
  });
  return getVerilogDiagnostics(doc(text), settings)
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

function diagnosticCodesWithSettings(text: string, settingsValue: unknown): string[] {
  return getVerilogDiagnostics(doc(text), mergeCoSettings(settingsValue))
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

describe('Verilog course lint rule configuration', () => {
  const disabledByDefaultSample = `
module demo(input a, output reg y);
    wire BAD_name;
    wire mux;
    wire bare;
    always @(*) begin
        if (a) y = 1;
        y = 42;
    end
endmodule
`.trim();

  it('keeps requested noisy rules disabled by default', () => {
    const codes = diagnosticCodes(disabledByDefaultSample);
    expect(codes.some((code) => code.startsWith('vc-001'))).toBe(false);
    expect(codes.some((code) => code.startsWith('vc-003'))).toBe(false);
    expect(codes.some((code) => code.startsWith('vc-004'))).toBe(false);
    expect(codes.some((code) => code.startsWith('vc-008'))).toBe(false);
    expect(codes.some((code) => code.startsWith('vc-021'))).toBe(false);
  });

  it('emits default-disabled rules when the user enables them', () => {
    const codes = diagnosticCodes(disabledByDefaultSample, []);
    expect(codes.some((code) => code.startsWith('vc-001'))).toBe(true);
    expect(codes.some((code) => code.startsWith('vc-003'))).toBe(true);
    expect(codes.some((code) => code.startsWith('vc-004'))).toBe(true);
    expect(codes.some((code) => code.startsWith('vc-008'))).toBe(true);
    expect(codes.some((code) => code.startsWith('vc-021'))).toBe(true);
  });

  it('reports magic numbers from AST expressions but skips parameters and selects', () => {
    const text = `
module demo(input [7:0] a, output [7:0] y);
    parameter P = 42;
    assign y = a[3:0] + P + 42;
endmodule
`.trim();
    const document = doc(text);
    const diagnostics = getVerilogDiagnostics(document, mergeCoSettings({ verilog: { lint: { disabledRules: [] } } }))
      .filter((diagnostic) => diagnostic.code === 'vc-004-magic-number');
    expect(diagnostics.map((diagnostic) => document.getText(diagnostic.range))).toEqual(['42']);
  });

  it('does not emit removed formatting or abstraction rules', () => {
    const text = `
module huge(input a,output reg y);
assign y=a;
${Array.from({ length: 170 }, (_, index) => `wire sig_${index};`).join('\n')}
endmodule
`.trim();
    const codes = diagnosticCodes(text, []);
    expect(codes.some((code) => code.startsWith('vc-018'))).toBe(false);
    expect(codes.some((code) => code.startsWith('vc-019'))).toBe(false);
    expect(codes.some((code) => code.startsWith('vc-020'))).toBe(false);
    expect(codes.some((code) => code.startsWith('vc-022'))).toBe(false);
  });

  it('offers a quick fix to disable every emitted VC rule', () => {
    const text = `
module demo(input a, output reg y);
    always @(*) begin
        y <= a;
    end
endmodule
`.trim();
    const document = doc(text);
    const settings = mergeCoSettings({});
    const diagnostics = getVerilogDiagnostics(document, settings);
    const vc007 = diagnostics.find((diagnostic) => diagnostic.code === 'vc-007-comb-nonblocking');
    expect(vc007).toBeDefined();

    const actions = getVerilogCodeActions(document, vc007!.range, [vc007!], settings, new VerilogWorkspaceIndex());
    const disableAction = actions.find((action) => action.command?.command === 'co.verilog.disableLintRule');
    expect(disableAction?.command?.arguments).toEqual(['vc-007']);
  });

  it('does not report synth-mul-div for sensitivity wildcards, attributes, or timescale directives', () => {
    const text = `
\`timescale 1ns / 1ps
module demo(input a, output reg y);
    (* keep = "true" *) wire kept;
    always @(*) begin
        y = a | kept;
    end
    always @* begin
        y = y ^ a;
    end
endmodule
`.trim();
    const codes = diagnosticCodes(text);
    expect(codes).not.toContain('synth-mul-div');
  });

  it('still reports actual multiply, divide, and modulo operators', () => {
    const text = `
module demo(input [3:0] a, input [3:0] b, output [3:0] y);
    assign y = (a * b) / 2 % 3;
endmodule
`.trim();
    const codes = diagnosticCodes(text);
    expect(codes.filter((code) => code === 'synth-mul-div')).toHaveLength(3);
  });

  it('reports synthesizable multiply hints on AST operator ranges', () => {
    const text = `
module demo(input [3:0] a, input [3:0] b, output [3:0] y);
    assign y = a * b;
endmodule
`.trim();
    const document = doc(text);
    const diagnostics = getVerilogDiagnostics(document, mergeCoSettings({}))
      .filter((diagnostic) => diagnostic.code === 'synth-mul-div');
    expect(diagnostics).toHaveLength(1);
    expect(document.getText(diagnostics[0].range)).toBe('*');
  });

  it('does not report multiply, divide, or modulo synthesizable hints inside MDU by default', () => {
    const text = `
module MDU(input [31:0] a, input [31:0] b, output [31:0] y);
    assign y = (a * b) / 2 % 3;
endmodule
`.trim();
    const codes = diagnosticCodes(text);
    expect(codes).not.toContain('synth-mul-div');
  });

  it('does not report initial synthesizable hints inside testbench modules by default', () => {
    const text = `
module cpu_tb;
    initial begin
    end
endmodule
`.trim();
    const codes = diagnosticCodes(text);
    expect(codes).not.toContain('synth-initial');
  });

  it('does not report mixed assignment for testbench clock signals by default', () => {
    const text = `
module cpu_tb;
    reg clk;
    initial begin
        clk = 0;
    end
    always @(posedge clk) begin
        clk <= ~clk;
    end
endmodule
`.trim();
    const codes = diagnosticCodes(text);
    expect(codes).not.toContain('mixed-assignment');
  });

  it('reports clock signals used as sequential assignment data from AST RHS expressions', () => {
    const clockData = `
module demo(input clk, input data, output reg y);
    always @(posedge clk) begin
        y <= data ? clk : 1'b0;
    end
endmodule
`.trim();
    const normalData = `
module demo(input clk, input data, output reg y);
    always @(posedge clk) begin
        y <= data;
    end
endmodule
`.trim();
    expect(diagnosticCodes(clockData)).toContain('vc-013-clock-data');
    expect(diagnosticCodes(normalData)).not.toContain('vc-013-clock-data');
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

  it('filters diagnostics disabled through the generic diagnostic suppress setting', () => {
    const text = `
module demo(input [3:0] a, input [3:0] b, output [3:0] y);
    assign y = a * b;
endmodule
`.trim();
    const codes = diagnosticCodesWithSettings(text, {
      diagnostics: {
        disabledCodes: ['verilog:synth-mul-div']
      }
    });
    expect(codes).not.toContain('synth-mul-div');
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

  it('reports port declarations that omit wire under default_nettype none', () => {
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
    expect(explicitWireDiagnostics).toHaveLength(2);
    expect(explicitWireDiagnostics.every((diagnostic) => diagnostic.severity === 1)).toBe(true);
  });

  it('deduplicates inherited ANSI port net type diagnostics by direction', () => {
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
    expect(diagnostics).toHaveLength(2);
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
module mips(
    input clk,
    input wire reset
);
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

  it('reports combinational assignments that are missing on some if paths', () => {
    const text = `
module demo(input a, input b, output reg y);
    always @(*) begin
        if (a) begin
            y = b;
        end
    end
endmodule
`.trim();
    const codes = diagnosticCodes(text, []);
    expect(codes).toContain('vc-008-comb-branch');
    expect(codes).toContain('vc-008-comb-incomplete-assignment');
  });

  it('accepts default assignments before partial if branches', () => {
    const text = `
module demo(input a, input b, output reg y);
    always @(*) begin
        y = 1'b0;
        if (a) begin
            y = b;
        end
    end
endmodule
`.trim();
    const codes = diagnosticCodes(text, []);
    expect(codes).not.toContain('vc-008-comb-branch');
    expect(codes).not.toContain('vc-008-comb-incomplete-assignment');
  });

  it('accepts fully covered small constant case statements without default', () => {
    const text = `
module demo(input [1:0] sel, output reg y);
    always @(*) begin
        case (sel)
            2'b00: y = 1'b0;
            2'b01: y = 1'b0;
            2'b10: y = 1'b1;
            2'b11: y = 1'b1;
        endcase
    end
endmodule
`.trim();
    const codes = diagnosticCodes(text, []);
    expect(codes).not.toContain('vc-008-case-default');
    expect(codes).not.toContain('vc-008-comb-incomplete-assignment');
  });

  it('reports case assignments that lack default or full coverage', () => {
    const text = `
module demo(input sel, output reg y);
    always @(*) begin
        case (sel)
            1'b0: y = 1'b0;
        endcase
    end
endmodule
`.trim();
    const codes = diagnosticCodes(text, []);
    expect(codes).toContain('vc-008-case-default');
    expect(codes).toContain('vc-008-comb-incomplete-assignment');
  });

  it('offers a quick fix to add a default case item', () => {
    const text = `
module demo(input sel, output reg y);
    always @(*) begin
        case (sel)
            1'b0: y = 1'b0;
        endcase
    end
endmodule
`.trim();
    const document = doc(text);
    const settings = mergeCoSettings({ verilog: { lint: { disabledRules: [] } } });
    const diagnostics = getVerilogDiagnostics(document, settings);
    const missingDefault = diagnostics.find((diagnostic) => diagnostic.code === 'vc-008-case-default');
    expect(missingDefault).toBeDefined();

    const actions = getVerilogCodeActions(document, missingDefault!.range, [missingDefault!], settings, new VerilogWorkspaceIndex());
    const action = actions.find((candidate) => candidate.title === 'Add default case item');
    const edit = action?.edit?.changes?.[document.uri]?.[0];
    expect(action?.kind).toBe('quickfix');
    expect(edit?.newText).toBe('            default: ;\n');
    expect(edit?.range.start).toEqual({ line: 4, character: 0 });
  });
});
