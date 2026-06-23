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

import {
  batchSummary,
  continuousTraceMonitorMaxRows,
  renderBatchTraceReport,
  renderContinuousTraceMonitor
} from '../courseTestReport';
import type { ContinuousTraceReport, CourseTraceCaseResult } from '../courseTestReport';

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

  it('limits continuous monitor rows while keeping the full iteration count visible', () => {
    const report: ContinuousTraceReport = {
      generatedAt: '2026-06-23T00:00:00.000Z',
      running: true,
      stopRequested: false,
      generator: 'gen',
      commandLine: 'python gen.py',
      cwd: 'E:/cases',
      options: {
        intervalMs: 1000,
        maxIterations: 0,
        stopOnFailure: false
      },
      iterations: Array.from({ length: continuousTraceMonitorMaxRows + 2 }, (_, index) => ({
        index: continuousTraceMonitorMaxRows + 2 - index,
        status: 'passed',
        startedAt: `2026-06-23T00:${String(index).padStart(2, '0')}:00.000Z`,
        summary: {
          total: 1,
          passed: 1,
          failed: 0,
          errors: 0
        },
        results: [
          {
            asm: `case-${index}.asm`,
            status: 'passed',
            stage: 'compare',
            message: 'ok'
          }
        ]
      }))
    };
    const reportFile = { fsPath: 'E:/out/continuous-trace-report.json' } as unknown as import('vscode').Uri;

    const html = renderContinuousTraceMonitor(report, reportFile);

    expect(html).toContain(`<strong>${continuousTraceMonitorMaxRows + 2}</strong>`);
    expect(html).toContain(`最近 ${continuousTraceMonitorMaxRows} / ${continuousTraceMonitorMaxRows + 2} 轮`);
    expect(html).toContain(`<td>${continuousTraceMonitorMaxRows + 2}</td>`);
    expect(html).toContain('2026-06-23T00:99:00.000Z');
    expect(html).not.toContain('2026-06-23T00:101:00.000Z');
  });
});
