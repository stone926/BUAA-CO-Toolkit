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
        caseId: 'case<&1',
        asmSnapshot: 'E:/cases/snap<shot>.asm',
        machineCode: 'E:/cases/code&latest.txt',
        marsOut: 'E:/cases/mars"out.txt',
        simOut: 'E:/cases/sim<out>.txt',
        status: 'error',
        stage: 'compare',
        message: '<script>alert("x")</script>'
      }
    ];
    const report = { fsPath: 'E:/out/report&latest.json' } as unknown as import('vscode').Uri;

    const html = renderBatchTraceReport(results, report);

    expect(html).toContain('bad&lt;name&gt;.asm');
    expect(html).toContain('in&amp;1.txt');
    expect(html).toContain('case&lt;&amp;1');
    expect(html).toContain('snap&lt;shot&gt;.asm');
    expect(html).toContain('code&amp;latest.txt');
    expect(html).toContain('mars&quot;out.txt');
    expect(html).toContain('sim&lt;out&gt;.txt');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('report&amp;latest.json');
  });

  it('maps continuous monitor statuses into row classes and summary metrics', () => {
    const report: ContinuousTraceReport = {
      generatedAt: '2026-06-23T00:00:00.000Z',
      running: false,
      stopRequested: true,
      generator: 'gen',
      commandLine: 'python gen.py',
      cwd: 'E:/cases',
      options: {
        intervalMs: 1000,
        maxIterations: 0,
        stopOnFailure: true
      },
      iterations: [
        {
          index: 4,
          status: 'stopped',
          startedAt: '2026-06-23T00:04:00.000Z',
          summary: { total: 0, passed: 0, failed: 0, errors: 0 },
          results: []
        },
        {
          index: 3,
          status: 'error',
          startedAt: '2026-06-23T00:03:00.000Z',
          summary: { total: 1, passed: 0, failed: 0, errors: 1 },
          results: [{ asm: 'err.asm', status: 'error', stage: 'mars', message: 'bad' }]
        },
        {
          index: 2,
          status: 'failed',
          startedAt: '2026-06-23T00:02:00.000Z',
          summary: { total: 1, passed: 0, failed: 1, errors: 0 },
          results: [{ asm: 'fail.asm', status: 'failed', stage: 'compare', message: 'wa' }]
        },
        {
          index: 1,
          status: 'passed',
          startedAt: '2026-06-23T00:01:00.000Z',
          summary: { total: 1, passed: 1, failed: 0, errors: 0 },
          results: [{ asm: 'ok.asm', status: 'passed', stage: 'compare', message: 'ok' }]
        }
      ]
    };

    const html = renderContinuousTraceMonitor(report, { fsPath: 'E:/out/continuous.json' } as unknown as import('vscode').Uri);

    expect(html).toContain('<tr class="stopped">');
    expect(html).toContain('<tr class="error">');
    expect(html).toContain('<tr class="failed">');
    expect(html).toContain('<tr class="passed">');
    expect(html).toContain('<span>轮数</span><strong>4</strong>');
    expect(html).toContain('<span>状态</span><strong>已停止</strong>');
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
