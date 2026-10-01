import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { getVerilogFormattingEdits } from '../../../language/verilog/formatting';
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
});
