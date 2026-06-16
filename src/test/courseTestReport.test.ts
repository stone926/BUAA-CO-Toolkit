import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  ViewColumn: {
    Beside: 2
  },
  window: {
    createWebviewPanel: vi.fn(() => ({
      webview: {
        html: ''
      }
    }))
  }
}));

import { batchSummary, renderBatchTraceReport } from '../courseTestReport';
import type { CourseTraceCaseResult } from '../courseTestReport';

describe('course test reports', () => {
  it('summarizes trace results by status', () => {
    const results: CourseTraceCaseResult[] = [
      { asm: 'case1.asm', status: 'passed', stage: 'compare', message: 'OK' },
      { asm: 'case2.asm', status: 'failed', stage: 'compare', message: 'WA' },
      { asm: 'case3.asm', status: 'error', stage: 'mars', message: 'MARS error' }
    ];

    expect(batchSummary(results)).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      errors: 1
    });
  });

  it('escapes external report content in batch HTML', () => {
    const results: CourseTraceCaseResult[] = [
      {
        asm: 'E:/cases/bad<name>.asm',
        stdin: 'E:/cases/in&1.txt',
        status: 'error',
        stage: 'compare',
        message: '<script>alert("x")</script>'
      }
    ];
    const report = { fsPath: 'E:/out/report&latest.json' } as unknown as import('vscode').Uri;

    const html = renderBatchTraceReport(results, report);

    expect(html).toContain('bad&lt;name&gt;.asm');
    expect(html).toContain('in&amp;1.txt');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('report&amp;latest.json');
  });
});
