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
  continuousTraceMonitorMaxRows,
  neutralCourseTraceCaseResult,
  neutralCourseTraceStage,
  publicAutomaticDiagnosticMessage,
  publicAutomaticCourseTraceCaseResult,
  renderAsmCaseIndex,
  renderContinuousTraceMonitor
} from '../courseTestReport';
import type { ContinuousTraceReport, CourseTraceCaseResult } from '../courseTestReport';

const historyEngineEvidence = {
  program: { assembler: { id: 'builtin-ts', semanticsRevision: 1, capabilitiesRevision: 1 } },
  oracle: { engine: { id: 'builtin-ts', semanticsRevision: 1, capabilitiesRevision: 1 }, configurationHash: '0'.repeat(64), stopReason: 'unknown' as const }
};

describe('course test reports', () => {
  it('offers stop only while running and explains empty monitor/history states', () => {
    const report: ContinuousTraceReport = { generatedAt: '', running: true, stopRequested: false, iterations: [] };
    const render = () => renderContinuousTraceMonitor(report, {} as never);
    expect(render()).toContain('data-report-action="stop"');
    expect(render()).toContain('正在准备第一轮测试');
    report.stopRequested = true;
    expect(render()).not.toContain('data-report-action="stop"');
    report.running = false;
    expect(render()).not.toContain('data-report-action="stop"');
    expect(render()).toContain('data-report-action="openHistory"');
    expect(renderAsmCaseIndex([])).toContain('还没有测试记录');
    expect(renderAsmCaseIndex([])).not.toContain('data-report-filters');
  });

  it('labels unclassified framework failures as internal instead of compare', () => {
    expect(publicAutomaticDiagnosticMessage({
      asm: 'hidden.asm',
      status: 'error',
      stage: 'internal',
      message: 'private framework detail'
    })).toBe('[AUTO-INTERNAL] 自动测试内部流程未完成；请使用复现编号定位');
  });

  it('keeps a special probe error and its course-scope notice visible in JSON and monitor', () => {
    const result: CourseTraceCaseResult = {
      asm: 'hidden.asm', status: 'error', stage: 'dut', message: 'tool failed',
      probeScope: 'special-timer-exl'
    };
    const publicResult = publicAutomaticCourseTraceCaseResult(result, 0);
    expect(publicResult.status).toBe('error');
    expect(publicResult.probeScope).toBe('special-timer-exl');
    expect(publicResult.message).toContain('单凭此场景失败，不能判定课程 CPU 不合格');
    const rendered = renderContinuousTraceMonitor({
      generatedAt: '2026-09-29T00:00:00.000Z', running: false, stopRequested: false,
      iterations: [{ index: 1, status: 'error', startedAt: '',
        summary: { total: 1, passed: 0, failed: 0, errors: 1 }, results: [result] }]
    }, { fsPath: 'report.json' } as never);
    expect(rendered).toContain('特殊压力场景');
    expect(rendered).toContain('软件构造 EXL/EPC');
  });

  it.each(['passed', 'failed', 'error'] as const)('shows the actual %s special outcome and diagnostic in history and monitor', (status) => {
    const result: CourseTraceCaseResult = {
      asm: 'hidden.asm', caseId: 'special-result', status, stage: status === 'error' ? 'dut' : 'probe',
      message: 'private raw message', probeScope: 'special-timer-exl',
      ...(status === 'failed' ? { probe: { passed: false, records: [], diagnostics: [], failures: [
        { scenarioId: 3, kind: 'timer1', message: 'EPC 不符：期望 0x30a0，实际 0x4184 <异常>' }
      ] } } : {})
    };
    const diagnostic = publicAutomaticDiagnosticMessage(result);
    const history = renderAsmCaseIndex([{
      manifest: {
        version: 2, caseId: 'special-result', createdAt: '', profile: 'P7', source: { kind: 'builtin' },
        ...historyEngineEvidence,
        originalAsmPath: 'hidden.asm', asmSnapshot: { path: 'program.asm', sha256: '0'.repeat(64), bytes: 1 },
        metadata: { 'source.probeScope': 'special-timer-exl', 'test.status': status, 'test.diagnostic': diagnostic }
      }, uri: {} as never
    }]);
    const monitor = renderContinuousTraceMonitor({
      generatedAt: '', running: false, stopRequested: false, iterations: [{
        index: 1, status, startedAt: '', results: [result],
        summary: { total: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'failed' ? 1 : 0, errors: status === 'error' ? 1 : 0 }
      }]
    }, {} as never);
    for (const page of [history, monitor]) {
      expect(page).toContain(`class="${status}"`);
      expect(page).toContain(status === 'passed' ? '通过' : status === 'failed' ? '失败' : '错误');
      expect(page).toContain('软件构造 EXL/EPC');
      expect(page).not.toContain('private raw message');
      if (status === 'failed') {
        expect(page).toContain('EPC 不符：期望 0x30a0，实际 0x4184 &lt;异常&gt;');
      }
      if (status === 'error') expect(page).toContain('CPU 仿真未完成');
    }
    expect(monitor).toContain('特殊压力测试结果');
  });

  it('shows a special test while running without inventing a pass or failure', () => {
    const monitor = renderContinuousTraceMonitor({
      generatedAt: '', running: true, stopRequested: false, iterations: [{
        index: 1, status: 'running', startedAt: '', results: [],
        activeCase: { index: 12, caseId: 'special-active', probeScope: 'special-timer-exl' },
        summary: { total: 0, passed: 0, failed: 0, errors: 0 }
      }]
    }, {} as never);
    expect(monitor).toContain('测试点 13');
    expect(monitor).toContain('special-active');
    expect(monitor).toContain('正在执行，尚未产生正误判定');
    expect(monitor).toContain('单凭此场景失败，不能判定课程 CPU 不合格');
  });

  it('distinguishes missing, cancelled and recorded special history results', () => {
    const pages = ['generated', 'cancelled', 'failed'].map(state => renderAsmCaseIndex([{
      manifest: {
        version: 2, caseId: 'special-history', createdAt: '', profile: 'P7', source: { kind: 'builtin' },
        ...historyEngineEvidence,
        originalAsmPath: 'hidden.asm', asmSnapshot: { path: 'program.asm', sha256: '0'.repeat(64), bytes: 1 },
        metadata: { 'source.probeScope': 'special-timer-exl', 'continuous.state': state }
      }, uri: {} as never
    }]));
    expect(pages[0]).toContain('无结果');
    expect(pages[0]).toContain('尚未记录判定结果');
    expect(pages[0]).not.toContain('<tr class="passed">');
    expect(pages[1]).toContain('已取消');
    expect(pages[1]).not.toContain('<tr class="error">');
    expect(pages[2]).toContain('<tr class="failed">');
    expect(pages[2]).toContain('未保存具体诊断');
  });

  it('shows an unobserved return window as uncovered rather than a CPU failure', () => {
    const result: CourseTraceCaseResult = {
      asm: 'hidden.asm', status: 'error', stage: 'probe', message: 'private',
      probe: { passed: false, failures: [], diagnostics: [], records: [],
        coverage: [{ covered: false, message: '未观察到 eret 后恢复边界' }] }
    };
    const publicResult = publicAutomaticCourseTraceCaseResult(result, 0);
    expect(publicResult.status).toBe('error');
    expect(publicResult.message).toContain('未覆盖');
    expect(JSON.stringify(publicResult.probe)).toContain('未观察到 eret 后恢复边界');
    const rendered = renderContinuousTraceMonitor({
      generatedAt: '2026-09-29T00:00:00.000Z', running: false, stopRequested: false,
      iterations: [{ index: 1, status: 'error', startedAt: '',
        summary: { total: 1, passed: 0, failed: 0, errors: 1 }, results: [result] }]
    }, { fsPath: 'report.json' } as never);
    expect(rendered).toContain('未覆盖');
    expect(rendered).toContain('未观察到 eret 后恢复边界');
    const failed: CourseTraceCaseResult = {
      ...result, status: 'failed', probe: { ...result.probe!, failures: [
        { scenarioId: 0, kind: 'cp0-reset', message: 'CP0 reset status read-back differs: expected exactly one zero sample at PC 0x300c' }
      ] }
    };
    const withFailure = renderContinuousTraceMonitor({
      generatedAt: '2026-09-29T00:00:00.000Z', running: false, stopRequested: false,
      iterations: [{ index: 1, status: 'failed', startedAt: '',
        summary: { total: 1, passed: 0, failed: 1, errors: 0 }, results: [failed] }]
    }, { fsPath: 'report.json' } as never);
    expect(withFailure).toContain('CP0 复位：CP0 复位后 Status 读回值不符合预期：PC 0x300c 应恰好记录一次零值样本');
    expect(withFailure).not.toContain('CP0 reset');
    expect(withFailure).not.toContain('未覆盖');
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
    const report = publicAutomaticCourseTraceCaseResult(result, 0);
    const rendered = renderContinuousTraceMonitor({
      generatedAt: '2026-09-26T00:00:00.000Z', running: false, stopRequested: false,
      generator: 'builtin:random-asm', commandLine: '', cwd: '',
      options: { intervalMs: 0, maxIterations: 0, stopOnFailure: true },
      iterations: [{ index: 1, status: 'error', startedAt: '',
        summary: { total: 1, passed: 0, failed: 0, errors: 1 }, results: [result] }]
    }, { fsPath: 'E:/SECRET/report.json' } as never);

    expect(message).toBe(
      '[AUTO-DUT] Icarus 编译失败（退出码 26）：CPU.v:449: Unable to bind <module>&signal'
    );
    expect(report).toMatchObject({
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

    expect(neutralCourseTraceStage('dump')).toBe('assemble');
    expect(neutralCourseTraceStage('isim')).toBe('dut');
    expect(neutralCourseTraceStage('logisim')).toBe('dut');

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
    expect(html).toContain('点击“定位失败”查看证据');
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
            reason: 'Write value differs.',
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
    expect(html).toContain('写入值不一致。');
    expect(html).toContain('参考结果');
    expect(html).toContain('待测 CPU');
    expect(html).not.toContain('Write value differs.');
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
