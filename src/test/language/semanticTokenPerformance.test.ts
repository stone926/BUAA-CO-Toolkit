import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../language/common/settings';
import { clearMipsParseCache, clearMipsSemanticTokenCache, getMipsSemanticTokens } from '../../language/mips/service';
import { MipsServerState } from '../../language/mips/state';
import { clearCachedVerilogParse } from '../../language/verilog/parseCache';
import { clearVerilogSemanticTokenCache, getVerilogSemanticTokens } from '../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../language/verilog/workspaceIndex';

describe('semantic token performance', () => {
  afterEach(() => {
    clearCachedVerilogParse();
    clearVerilogSemanticTokenCache();
    clearMipsParseCache();
    clearMipsSemanticTokenCache();
  });

  it('keeps first Verilog semantic token requests responsive on large files', () => {
    const document = TextDocument.create('test://semantic-performance/large.v', 'verilog', 1, largeVerilogDesign(180));
    const index = new VerilogWorkspaceIndex();

    const start = performance.now();
    const first = getVerilogSemanticTokens(document, mergeCoSettings({}), index);
    const elapsedMs = performance.now() - start;

    expect(first.data.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(performanceBudgetMs());
    expect(getVerilogSemanticTokens(document, mergeCoSettings({}), index)).toBe(first);
  });

  it('keeps first MIPS semantic token requests responsive on large files', () => {
    const document = TextDocument.create('test://semantic-performance/large.asm', 'mipsasm', 1, largeMipsProgram(2500));
    const state = mipsState();
    const settings = mergeCoSettings({
      mips: {
        instructionTokenMode: 'byType'
      }
    });

    const start = performance.now();
    const first = getMipsSemanticTokens(document, settings, state);
    const elapsedMs = performance.now() - start;

    expect(first.data.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(performanceBudgetMs());
    expect(getMipsSemanticTokens(document, settings, state)).toBe(first);
  });
});

function performanceBudgetMs(): number {
  const value = Number(process.env.CO_SEMANTIC_TOKEN_PERF_BUDGET_MS);
  return Number.isFinite(value) && value > 0 ? value : 4000;
}

function largeVerilogDesign(count: number): string {
  const lines = [
    '`default_nettype none',
    'module alu(input wire [31:0] a, input wire [31:0] b, output wire [31:0] y);',
    '    assign y = a + b;',
    'endmodule',
    '',
    'module top(input wire clk, input wire rst, input wire [31:0] in, output wire [31:0] out);',
    '    wire [31:0] base;',
    '    assign base = in;'
  ];
  for (let index = 0; index < count; index++) {
    lines.push(
      `    wire [31:0] a${index};`,
      `    wire [31:0] b${index};`,
      `    wire [31:0] y${index};`,
      `    assign a${index} = base + 32'd${index};`,
      `    assign b${index} = a${index} ^ 32'h${index.toString(16).padStart(8, '0')};`,
      `    alu u_alu_${index}(.a(a${index}), .b(b${index}), .y(y${index}));`
    );
  }
  lines.push('    assign out = y0;', 'endmodule');
  return lines.join('\n');
}

function largeMipsProgram(count: number): string {
  const lines = ['.text', 'main:'];
  for (let index = 0; index < count; index++) {
    const target = `label_${index}`;
    lines.push(
      `    ori $t0, $zero, ${index & 0xffff}`,
      `    addu $t1, $t1, $t0`,
      `    beq $t0, $zero, ${target}`,
      `${target}:`,
      '    nop'
    );
  }
  lines.push('    syscall');
  return lines.join('\n');
}

function mipsState(): MipsServerState {
  return {
    ignoredPseudoInstructionFiles: new Set(),
    ignoredPseudoInstructionMnemonics: new Set()
  };
}
