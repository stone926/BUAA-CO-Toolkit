import { performance } from 'node:perf_hooks';
import { describe, expect, it, afterEach } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { clearCachedVerilogParse, getCachedVerilogParse } from '../../../language/verilog/parseCache';
import { getVerilogDiagnostics } from '../../../language/verilog/service';

const settings = mergeCoSettings({
  verilog: {
    implicitNet: {
      diagnostic: 'off'
    },
    lint: {
      courseRules: false,
      synthesizableHints: false,
      disabledRules: []
    }
  }
});

describe('Verilog diagnostic performance', () => {
  afterEach(() => {
    clearCachedVerilogParse();
  });

  it('keeps local diagnostics responsive for a common 2k-line design', () => {
    const text = largeCourseDesign(142);
    expect(text.split(/\r?\n/).length).toBeGreaterThanOrEqual(2000);

    const document = doc(text, 1);
    const start = performance.now();
    const diagnostics = getVerilogDiagnostics(document, settings);
    const elapsedMs = performance.now() - start;

    expect(diagnostics.filter((diagnostic) => String(diagnostic.code).startsWith('syntax-'))).toHaveLength(0);
    expect(elapsedMs).toBeLessThan(performanceBudgetMs());
  });

  it('reuses cached parse results for repeated diagnostics on the same document version', () => {
    const document = doc(largeCourseDesign(32), 2);
    const first = getCachedVerilogParse(document, settings, true);
    const second = getCachedVerilogParse(document, settings, true);

    expect(second).toBe(first);
  });
});

function doc(text: string, version: number): TextDocument {
  return TextDocument.create(`test://verilog-performance-${version}.v`, 'verilog', version, text);
}

function performanceBudgetMs(): number {
  const value = Number(process.env.CO_VERILOG_PERF_BUDGET_MS);
  return Number.isFinite(value) && value > 0 ? value : 4000;
}

function largeCourseDesign(count: number): string {
  const lines: string[] = [
    '`default_nettype none',
    'module leaf #(parameter WIDTH = 32) (',
    '    input wire clk,',
    '    input wire rst,',
    '    input wire [WIDTH-1:0] a,',
    '    input wire [WIDTH-1:0] b,',
    '    output reg [WIDTH-1:0] y',
    ');',
    '    integer k;',
    '    always @(posedge clk) begin',
    '        if (rst) begin',
    "            y <= 32'h0000_0000;",
    '        end else begin',
    '            y <= a + b;',
    '        end',
    '    end',
    'endmodule',
    '',
    'module top(input wire clk, input wire rst, input wire [31:0] in, output wire [31:0] out);',
    '    genvar g;'
  ];

  for (let index = 0; index < count; index++) {
    lines.push(
      `    wire [31:0] a${index};`,
      `    wire [31:0] b${index};`,
      `    wire [31:0] y${index};`,
      `    assign a${index} = in + 32'd${index};`,
      `    assign b${index} = a${index} ^ 32'h0000_${index.toString(16).padStart(4, '0')};`,
      `    leaf #(.WIDTH(32)) u_leaf_${index} (`,
      '        .clk(clk),',
      '        .rst(rst),',
      `        .a(a${index}),`,
      `        .b(b${index}),`,
      `        .y(y${index})`,
      '    );',
      `    assign out = y${index};`,
      ''
    );
  }

  lines.push(
    '    generate',
    '        for (g = 0; g < 4; g = g + 1) begin : gen_probe',
    '            wire probe;',
    '            assign probe = out[g];',
    '        end',
    '    endgenerate',
    'endmodule'
  );

  return lines.join('\n');
}
