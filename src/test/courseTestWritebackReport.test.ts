import { describe, expect, it } from 'vitest';
import { buildWritebackComparison } from '../courseTesting/writebackComparison';
import { renderWritebackComparison, writebackPageSize } from '../courseTestWritebackReport';

describe('writeback comparison page', () => {
  it('renders matching context and highlights only unequal digits, with source actions and separate raw logs', async () => {
    const model = await buildWritebackComparison('@3000: $1 <= 101\n@3004: $2 <= 102\n', 'WARNING: ignored\n 38@3000: $ 1 <= 00000101\n 42@3004: $ 2 <= 00000002\n');
    const page = renderWritebackComparison({ caseId: 'example', comparison: model, focus: 1, start: 0,
      sources: new Map([['1:oracle', { line: 47, text: 'add $1, $1, $0' }]]) });
    expect(page).toContain('1 项写回差异');
    expect(page).toContain('class="equal"');
    expect(page).toContain('class="different selected"');
    expect(page).toContain('00000<span class="field-change reference">1</span>02');
    expect(page).toContain('data-writeback-action="source" data-row="1" data-side="oracle"');
    expect(page).toContain('第 47 行');
    expect(page).toContain('data-writeback-action="rawDut"');
    expect(page).not.toContain('WARNING: ignored');
    expect(page).not.toContain('vscode.diff');
  });

  it('shows both PCs/targets for divergent events and labels missing writes', async () => {
    const model = await buildWritebackComparison('@3000: $1 <= 101\n@3004: $2 <= 102\n', '@3008: *4 <= 0\n');
    const page = renderWritebackComparison({ caseId: 'mismatch', comparison: model, focus: 0, start: 0, sources: new Map() });
    for (const label of ['PC 不同', '目标不同', '值不同', '缺少写回', '00003000', '00003008', '*00000004']) expect(page).toContain(label);
  });

  it('bounds the displayed context, escapes diagnostics and never turns partial or empty results into a CPU pass', async () => {
    const lines = Array.from({ length: 100 }, () => '@3000: $1 <= 101').join('\n');
    const model = await buildWritebackComparison(lines, lines);
    const view = { caseId: '<case>', comparison: model, focus: 50, start: 45, diagnostic: '<script>unsafe</script>', sources: new Map() };
    const page = renderWritebackComparison(view);
    expect((page.match(/<tr class=/g) ?? []).length).toBe(writebackPageSize);
    expect(page).toContain('第 46–86 项');
    expect(page).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(page).not.toContain('<script>unsafe');
    expect(page).toContain('原测试还可能检查');
    expect(renderWritebackComparison({ ...view, comparison: { ...model, truncated: true } })).toContain('不代表完整比较结果');
    const outside = renderWritebackComparison({ ...view, comparison: { ...model, truncated: true },
      savedDifference: { version: 1, index: 200010, dut: { pc: '00003000', kind: 'grf', target: '1', value: '00000000', raw: '', lineNumber: 200042 } } });
    expect(outside).toContain('第 200011 项');
    expect(outside).toContain('data-writeback-action="rawFirstDut"');
    const empty = await buildWritebackComparison('WARNING only', '');
    const emptyPage = renderWritebackComparison({ ...view, comparison: empty, focus: 0, start: 0 });
    expect(emptyPage).toContain('没有可解析的写回事件');
    expect(emptyPage).not.toContain('普通写回字段一致');
  });
});
