import { describe, expect, it } from 'vitest';
import { renderCourseTestFailure, type CourseFailureView } from '../courseTestFailureReport';

const view: CourseFailureView = {
  caseId: 'saved-case', profile: 'P5', status: 'failed', diagnostic: '写回值不一致',
  evidence: { version: 1, index: 0, oracle: { pc: '00003000', kind: 'grf', target: '8', value: '00000001', raw: '', lineNumber: 1 } },
  targets: [{ label: '差异指令', pc: 0x3000, line: 14, text: 'ori $8, $0, 1' }],
  sourceAvailable: true, compareAvailable: true, dutAvailable: true, logs: [],
  canRerun: true, canWaveform: true, canHazard: true, warnings: []
};

describe('failure diagnosis report', () => {
  it('offers direct source, trace, rerun and waveform actions with source and trace lines kept separate', () => {
    const page = renderCourseTestFailure(view);
    expect(page).toContain('第 14 行');
    expect(page).toContain('data-failure-action="source" data-index="0"');
    expect(page).toContain('data-failure-action="compare"');
    expect(page).toContain('data-failure-action="waveform"');
    expect(page).toContain('data-failure-action="rerun"');
    expect(page).toContain('无对应事件');
    expect(page).toContain('首个差异 · 第 1 项检查');
    expect(page).not.toContain('command:');
  });

  it('degrades partial/P3 history and explains missing evidence without inventing values', () => {
    const page = renderCourseTestFailure({ ...view, profile: 'P3', evidence: undefined, targets: [], canWaveform: false, canRerun: false, compareAvailable: false, warnings: ['产物已删除'] });
    expect(page).not.toContain('data-failure-action="waveform"');
    expect(page).toContain('data-failure-action="rerun" disabled');
    expect(page).toContain('data-failure-action="compare" disabled');
    expect(page).toContain('产物已删除');
    expect(page).not.toContain('00003000');
  });

  it('shows cancellation/error separately, retains scope notices, and escapes archived/source text', () => {
    const page = renderCourseTestFailure({ ...view, status: 'error', diagnostic: '[AUTO-COVERAGE] 未覆盖', scopeNotice: '单凭此场景失败，不能判定课程 CPU 不合格', targets: [{ ...view.targets[0], text: '</pre><script>bad()</script>' }], busy: true, actionMessage: '<failed>' });
    expect(page).toContain('未覆盖');
    expect(page).toContain('单凭此场景失败');
    expect(page).toContain('data-failure-action="rerun" disabled');
    expect(page).toContain('<details open>');
    expect(page).not.toContain('<script>bad()');
    expect(page).toContain('&lt;failed&gt;');
  });
});
