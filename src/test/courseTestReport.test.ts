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
  createCourseTraceBatchReport,
  neutralCourseTraceCaseResult,
  neutralCourseTraceStage,
  renderBatchTraceReport,
  renderContinuousTraceMonitor
} from '../courseTestReport';
import type { ContinuousTraceReport, CourseTraceCaseResult } from '../courseTestReport';

describe('course test reports', () => {
  it('writes role-neutral v2 results while preserving v1 input compatibility', () => {
    const legacy: CourseTraceCaseResult = {
      asm: 'legacy.asm',
      status: 'failed',
      stage: 'mars',
      message: 'legacy mismatch',
      marsOut: 'legacy.mars.out',
      simOut: 'legacy.sim.out',
      logisimOut: 'legacy.logisim.raw.out',
      marsEvents: 2,
      simEvents: 3,
      firstDiff: {
        index: 0,
        status: 'diff',
        mars: { pc: '00003000', kind: 'grf', target: '1', value: '00000001', raw: '', lineNumber: 1 },
        sim: { pc: '00003000', kind: 'grf', target: '1', value: '00000002', raw: '', lineNumber: 1 }
      }
    };

    const normalized = neutralCourseTraceCaseResult(legacy);
    expect(normalized).toMatchObject({
      stage: 'oracle',
      oracleOut: 'legacy.mars.out',
      dutOut: 'legacy.sim.out',
      dutRawOut: 'legacy.logisim.raw.out',
      oracleEvents: 2,
      dutEvents: 3,
      firstDiff: {
        oracle: { value: '00000001' },
        dut: { value: '00000002' }
      }
    });
    expect(normalized).not.toHaveProperty('marsOut');
    expect(normalized).not.toHaveProperty('simOut');
    expect(normalized).not.toHaveProperty('logisimOut');
    expect(normalized).not.toHaveProperty('marsEvents');
    expect(normalized).not.toHaveProperty('simEvents');
    expect(normalized.firstDiff).not.toHaveProperty('mars');
    expect(normalized.firstDiff).not.toHaveProperty('sim');

    const report = createCourseTraceBatchReport([legacy], undefined, '2026-08-26T00:00:00.000Z');
    expect(report.schemaVersion).toBe(2);
    expect(report.results[0]).toEqual(normalized);
    expect(neutralCourseTraceStage('dump')).toBe('assemble');
    expect(neutralCourseTraceStage('isim')).toBe('dut');
    expect(neutralCourseTraceStage('logisim')).toBe('dut');

    const oldReportHtml = renderBatchTraceReport(
      [legacy],
      { fsPath: 'E:/out/legacy-report.json' } as unknown as import('vscode').Uri
    );
    expect(oldReportHtml).toContain('<td>oracle</td>');
    expect(oldReportHtml).toContain('Oracle 2, DUT 3');
  });

  it('keeps a legacy raw-only Logisim output out of the canonical DUT slot', () => {
    const normalized = neutralCourseTraceCaseResult({
      asm: 'legacy-logisim.asm',
      status: 'error',
      stage: 'logisim',
      message: 'trace parsing failed',
      logisimOut: 'legacy.logisim.raw.out'
    });

    expect(normalized.dutOut).toBeUndefined();
    expect(normalized.dutRawOut).toBe('legacy.logisim.raw.out');
  });

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
    expect(html).toContain('Oracle');
    expect(html).toContain('DUT');
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
