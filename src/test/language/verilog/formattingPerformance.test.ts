import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { getVerilogFormattingEdits, getVerilogRangeFormattingEdits } from '../../../language/verilog/formatting';
import { Range } from 'vscode-languageserver/node';
import { applyFormattingEdits, formattingDocument, formattingOptions, formattingSettings } from '../../helpers/verilogFormatting';

const configuredBudget = Number(process.env.CO_FORMAT_PERF_BUDGET_MS);
const budget = Number.isFinite(configuredBudget) && configuredBudget > 0 ? configuredBudget : 30000;
function measure(source: string): void {
  const document = formattingDocument(source);
  const start = performance.now();
  const edits = getVerilogFormattingEdits(document, formattingSettings, formattingOptions);
  const elapsed = performance.now() - start;
  expect(edits.length).toBeGreaterThan(0);
  const result = applyFormattingEdits(document, edits);
  expect(result).not.toBe(source);
  expect(result).toContain(' = ');
  expect(elapsed, `Formatting ${document.lineCount} lines took ${elapsed.toFixed(0)}ms`).toBeLessThan(budget);
  const formatted = formattingDocument(result);
  expect(getVerilogFormattingEdits(formatted, formattingSettings, formattingOptions)).toEqual([]);
}

describe('Verilog formatting bounded performance', () => {
  it.each([2000, 10000, 50000])('formats %i lines without a no-op shortcut', count => {
    measure(`module m;\n${Array.from({ length: count - 2 }, (_, i) => `assign x${i}=a+b;`).join('\n')}\nendmodule`);
  }, Math.max(120000, budget * 4));
  it('handles a long question-mark based literal without suffix rescans', () => {
    measure(`module m;\nassign x=100000'b${'?'.repeat(100000)};\nendmodule`);
  }, Math.max(120000, budget * 4));
  it('handles a large parameter alignment group', () => {
    measure(`module m #(\n${Array.from({ length: 10000 }, (_, i) => `parameter P${i}=${i}${i === 9999 ? '' : ','}`).join('\n')}\n)();\nendmodule`);
  }, Math.max(120000, budget * 4));
  it('handles bounded deep blocks', () => {
    measure(`module m;\ninitial ${'begin\n'.repeat(256)}x=1;\n${'end\n'.repeat(256)}endmodule`);
  }, Math.max(120000, budget * 4));
  it('formats a range without rescanning a long unselected line for each assignment', () => {
    const prefix = 'module m;\n' + Array.from({ length: 10000 }, (_, i) => `assign a${i}=x;`).join(' ') + '\n';
    const source = prefix + 'assign y=x &&\nz;\nendmodule';
    const document = formattingDocument(source);
    const start = performance.now();
    const range = Range.create(2, 0, 4, 0);
    const edits = getVerilogRangeFormattingEdits(document, range, formattingSettings, formattingOptions);
    expect(performance.now() - start).toBeLessThan(budget);
    const output = applyFormattingEdits(document, edits);
    expect(output.startsWith(prefix)).toBe(true);
    expect(output.slice(prefix.length)).toBe('  assign y = x &&\n             z;\nendmodule');
    expect(getVerilogRangeFormattingEdits(formattingDocument(output), range, formattingSettings, formattingOptions)).toEqual([]);
  }, Math.max(120000, budget * 4));
});
