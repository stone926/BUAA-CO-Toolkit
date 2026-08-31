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

import * as vscode from 'vscode';

import {
  batchSummary,
  continuousTraceMonitorMaxRows,
  createCourseTraceBatchReport,
  neutralCourseTraceCaseResult,
  neutralCourseTraceStage,
  publicAutomaticDiagnosticMessage,
  renderAsmCaseIndex,
  renderBatchTraceReport,
  renderContinuousTraceMonitor,
  showBatchTraceReport
} from '../courseTestReport';
import type { ContinuousTraceReport, CourseTraceCaseResult } from '../courseTestReport';

describe('course test reports', () => {
  it('labels unclassified framework failures as internal instead of compare', () => {
    expect(publicAutomaticDiagnosticMessage({
      asm: 'hidden.asm',
      status: 'error',
      stage: 'internal',
      message: 'private framework detail'
    })).toBe('[AUTO-INTERNAL] 自动测试内部流程未完成；请使用复现编号定位');
  });

  it('shows a detailed, escaped, and path-safe automatic DUT compile diagnostic', () => {
    const result: CourseTraceCaseResult = {
      asm: 'E:/SECRET/case.asm',
      caseId: 'case-compile',
      status: 'error',
      stage: 'dut',
      message: 'raw E:/SECRET/backend detail',
      dutBackend: 'iverilog',
      dutFailure: {
        phase: 'compile',
        reason: 'exit',
        exitCode: 26,
        diagnostic: {
          file: 'E:/SECRET/private/CPU.v',
          line: 449,
          message: 'Unable to bind <module>&signal'
        }
      }
    };
    const message = publicAutomaticDiagnosticMessage(result);
    const report = createCourseTraceBatchReport([result], { kind: 'generator' });
    const rendered = renderBatchTraceReport(
      [result],
      { fsPath: 'E:/SECRET/report.json' } as never,
      undefined,
      { kind: 'generator' }
    );

    expect(message).toBe(
      '[AUTO-DUT] Icarus 编译失败（退出码 26）：CPU.v:449: Unable to bind <module>&signal'
    );
    expect(report.results[0]).toMatchObject({
      dutFailure: {
        phase: 'compile',
        diagnostic: { file: 'CPU.v', line: 449 }
      },
      message
    });
    expect(JSON.stringify(report)).not.toContain('SECRET');
    expect(rendered).toContain('CPU.v:449');
    expect(rendered).toContain('&lt;module&gt;&amp;signal');
    expect(rendered).not.toContain('SECRET');
  });

  it('renders test history without exposing automatic-case paths or artifact internals', () => {
    const html = renderAsmCaseIndex([{
      manifest: {
        version: 1,
        caseId: 'replay-1234',
        createdAt: '2026-08-29T00:00:00.000Z',
        profile: 'P7',
        originalAsmPath: 'E:/SECRET/source/builtin-p7-probe-timer.asm',
        asmSnapshot: {
          path: 'E:/SECRET/cases/replay-1234/program.asm',
          sha256: 'a'.repeat(64),
          bytes: 100
        },
        source: {
          kind: 'generator',
          commandLine: 'internal --count 1118 --probe-shard timer',
          cwd: 'E:/SECRET'
        },
        artifacts: {
          verilog: { traceOut: 'E:/SECRET/cases/replay-1234/verilog/trace.out' }
        }
      },
      uri: { fsPath: 'E:/SECRET/cases/replay-1234/case.json' } as never
    }]);

    expect(html).toContain('测试历史 / 失败用例');
    expect(html).toContain('复现编号');
    expect(html).toContain('replay-1234');
    expect(html).toContain('自动测试');
    expect(html).not.toContain('SECRET');
    expect(html).not.toContain('probe-timer');
    expect(html).not.toContain('1118');
    expect(html).not.toContain('Artifacts');
    expect(html).not.toContain('Manifest');
  });

  it('shows a sanitized automatic outcome in test history without exposing paths', () => {
    const html = renderAsmCaseIndex([{
      manifest: {
        version: 2,
        caseId: 'replay-failed',
        createdAt: '2026-08-29T00:00:00.000Z',
        profile: 'P6',
        originalAsmPath: 'E:/SECRET/source.asm',
        asmSnapshot: { path: 'program.asm', sha256: 'a'.repeat(64), bytes: 10 },
        source: { kind: 'builtin' },
        program: {
          assembler: { id: 'builtin-ts', semanticsRevision: 1, capabilitiesRevision: 1, build: 'test' }
        },
        oracle: {
          engine: { id: 'builtin-ts', semanticsRevision: 1, capabilitiesRevision: 1, build: 'test' },
          configurationHash: 'a'.repeat(64),
          stopReason: 'error'
        },
        metadata: {
          'test.status': 'error',
          'test.stage': 'dut',
          'test.diagnostic': '[AUTO-DUT] CPU 仿真未完成；请检查工具链和顶层接口'
        }
      },
      uri: { fsPath: 'E:/SECRET/cases/replay-failed/case.json' } as never
    }]);

    expect(html).toContain('replay-failed');
    expect(html).toContain('错误');
    expect(html).toContain('[AUTO-DUT]');
    expect(html).toContain('请检查工具链和顶层接口');
    expect(html).not.toContain('SECRET');
  });

  it('uses an automatic-test title for the public automatic result panel', () => {
    showBatchTraceReport(
      [{ asm: 'hidden.asm', status: 'passed', stage: 'compare', message: 'ok' }],
      { fsPath: 'hidden.json' } as never,
      undefined,
      { kind: 'generator' }
    );

    expect(vi.mocked(vscode.window.createWebviewPanel))
      .toHaveBeenLastCalledWith(
        'coBatchTraceReport',
        '自动测试结果',
        2,
        { enableScripts: false }
      );
  });

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

  it('keeps automatic reports compact without serializing generator controls or shard filenames', () => {
    const results: CourseTraceCaseResult[] = [{
      asm: 'E:/SECRET_CASE_DIR/automatic-failure.asm',
      status: 'failed',
      stage: 'compare',
      message: 'SECRET_BACKEND_MESSAGE E:/SECRET_OUTPUT',
      firstDiff: {
        index: 0,
        status: 'diff',
        reason: 'register value differs',
        oracle: { pc: '00003000', kind: 'grf', target: '1', value: '00000001', raw: '', lineNumber: 1 },
        dut: { pc: '00003000', kind: 'grf', target: '1', value: '00000002', raw: '', lineNumber: 1 }
      }
    }];
    const source = {
      kind: 'generator' as const,
      generator: 'SECRET_GENERATOR',
      commandLine: 'SECRET_COMMAND --count 4094',
      cwd: 'E:/SECRET_CWD',
      asmFiles: ['E:/SECRET_CASE_DIR/automatic-failure.asm']
    };
    const report = createCourseTraceBatchReport(results, source);
    const html = renderBatchTraceReport(
      results,
      { fsPath: 'E:/SECRET_REPORT/report.json' } as unknown as import('vscode').Uri,
      undefined,
      source
    );

    expect(report.source).toEqual({ kind: 'generator' });
    expect(report.results[0]).toMatchObject({
      asm: '测试点 1',
      status: 'failed',
      message: '[AUTO-MISMATCH] CPU 输出与参考结果不一致'
    });
    expect(JSON.stringify(report)).not.toMatch(/SECRET|automatic-failure\.asm|4094/);
    expect(html).toContain('测试点 1');
    expect(html).not.toContain('automatic-failure.asm');
    expect(html).toContain('register value differs');
    expect(html).toContain('测试历史');
    expect(html).not.toContain('SECRET_GENERATOR');
    expect(html).not.toContain('SECRET_COMMAND');
    expect(html).not.toContain('SECRET_CWD');
    expect(html).not.toContain('SECRET_CASE_DIR');
    expect(html).not.toContain('SECRET_BACKEND_MESSAGE');
    expect(html).not.toContain('SECRET_OUTPUT');
    expect(html).not.toContain('SECRET_REPORT');
    expect(html).not.toContain('4094');
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
    expect(html).toContain('测试历史”中查看诊断摘要');
  });

  it('reads legacy continuous provenance but hides internal controls and paths from HTML', () => {
    const report: ContinuousTraceReport = {
      generatedAt: '2026-06-23T00:00:00.000Z',
      running: false,
      stopRequested: false,
      generator: 'SECRET_GENERATOR_LABEL',
      commandLine: 'SECRET_COMMAND --backend internal',
      cwd: 'E:/SECRET_WORK_DIRECTORY',
      options: {
        intervalMs: 7319,
        maxIterations: 4517,
        stopOnFailure: true
      },
      retention: {
        retainedPassingCases: 2713,
        reportRetainedIterations: 1619,
        artifactOutputMode: 'case'
      },
      iterations: [{
        index: 1,
        status: 'failed',
        startedAt: '2026-06-23T00:01:00.000Z',
        finishedAt: '2026-06-23T00:01:01.000Z',
        summary: { total: 1, passed: 0, failed: 1, errors: 0 },
        results: [{
          asm: 'E:/SECRET_CASE_DIRECTORY/failed-case.asm',
          status: 'failed',
          stage: 'compare',
          message: 'SECRET_BACKEND_DIAGNOSTIC E:/SECRET_ARTIFACT_PATH',
          firstDiffIndex: 0,
          firstDiff: {
            index: 0,
            status: 'diff',
            reason: 'register value differs',
            oracle: { pc: '00003000', kind: 'grf', target: '1', value: '00000001', raw: '', lineNumber: 1 },
            dut: { pc: '00003000', kind: 'grf', target: '1', value: '00000002', raw: '', lineNumber: 1 }
          }
        }]
      }]
    };

    const html = renderContinuousTraceMonitor(
      report,
      { fsPath: 'E:/SECRET_REPORT_DIRECTORY/continuous.json' } as unknown as import('vscode').Uri
    );

    // The full data remains available to JSON serialization/replay.
    expect(report).toMatchObject({
      generator: 'SECRET_GENERATOR_LABEL',
      commandLine: 'SECRET_COMMAND --backend internal',
      cwd: 'E:/SECRET_WORK_DIRECTORY',
      options: { intervalMs: 7319, maxIterations: 4517, stopOnFailure: true },
      retention: { retainedPassingCases: 2713, reportRetainedIterations: 1619 }
    });

    expect(html).toContain('测试点 1');
    expect(html).not.toContain('failed-case.asm');
    expect(html).toContain('register value differs');
    expect(html).toContain('完整复现数据已自动保存');
    expect(html).not.toContain('SECRET_GENERATOR_LABEL');
    expect(html).not.toContain('SECRET_COMMAND');
    expect(html).not.toContain('SECRET_WORK_DIRECTORY');
    expect(html).not.toContain('SECRET_CASE_DIRECTORY');
    expect(html).not.toContain('SECRET_BACKEND_DIAGNOSTIC');
    expect(html).not.toContain('SECRET_ARTIFACT_PATH');
    expect(html).not.toContain('SECRET_REPORT_DIRECTORY');
    expect(html).not.toContain('7319');
    expect(html).not.toContain('4517');
    expect(html).not.toContain('2713');
    expect(html).not.toContain('1619');
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
    expect(html).toContain('<tr class="passed"><td>3</td>');
    expect(html).not.toContain('<tr class="passed"><td>2</td>');
  });
});
