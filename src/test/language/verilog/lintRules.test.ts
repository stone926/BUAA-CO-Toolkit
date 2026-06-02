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
});
