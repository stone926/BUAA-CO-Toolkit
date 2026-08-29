import { afterEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';

vi.mock('vscode', () => ({
  Uri: URI,
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn()
  },
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, fallback: T) => fallback,
      inspect: () => ({})
    })
  }
}));

vi.mock('../../courseTesting/traceRunner', () => ({
  runCourseTraceCase: vi.fn()
}));

vi.mock('../../fsUtil', () => ({
  ensureDirectory: vi.fn(async () => undefined),
  workspaceFolderForOrFirst: vi.fn(() => undefined),
  writeTextFile: vi.fn(async () => undefined)
}));

vi.mock('../../process', () => ({
  revealOutputChannel: vi.fn()
}));

vi.mock('../../asmCaseStore', () => ({
  recordAsmCaseTestOutcome: vi.fn(async () => undefined)
}));

vi.mock('../../courseTestReport', () => ({
  batchSummary: vi.fn((results: Array<{ status: string }>) => ({
    total: results.length,
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    errors: results.filter((item) => item.status === 'error').length
  })),
  createCourseTraceBatchReport: vi.fn(() => ({ generatedAt: new Date().toISOString(), summary: { total: 0, passed: 0, failed: 0, errors: 0 }, results: [] })),
  neutralCourseTraceCaseResult: vi.fn((item: unknown) => item),
  publicAutomaticDiagnosticMessage: vi.fn(() => '通过'),
  showBatchTraceReport: vi.fn()
}));

import {
  isCourseTraceBatchRunning,
  runCourseTraceBatch,
  stopCourseTraceBatch
} from '../../courseTesting/batchRunner';
import { runCourseTraceCase } from '../../courseTesting/traceRunner';
import { revealOutputChannel } from '../../process';
import { recordAsmCaseTestOutcome } from '../../asmCaseStore';
import type { AppServices } from '../../types';
import { tryAcquireCourseTestSession } from '../../courseTesting/courseTestSession';

const services = {
  output: { appendLine: vi.fn() },
  statusBar: { text: '' }
} as unknown as AppServices;

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(runCourseTraceCase).mockReset();
});

describe('batch runner cancellation session', () => {
  it('is idle before start and exposes idempotent stop', async () => {
    expect(isCourseTraceBatchRunning()).toBe(false);
    expect(stopCourseTraceBatch()).toBe(false);
    expect(isCourseTraceBatchRunning()).toBe(false);
  });

  it('stops the whole batch when the session is aborted from inside a case', async () => {
    vi.mocked(runCourseTraceCase).mockImplementation(async () => {
      // The user (or test) requests stop while the first case is in flight.
      expect(stopCourseTraceBatch()).toBe(true);
      expect(stopCourseTraceBatch()).toBe(true);
      return {
        asm: 'E:/a.asm',
        status: 'error' as const,
        stage: 'compare' as const,
        message: 'cancelled',
        cancelled: true as const
      };
    });
    await runCourseTraceBatch(
      services,
      [{ asm: URI.file('/tmp/a.asm') }, { asm: URI.file('/tmp/b.asm') }],
      { kind: 'selected', asmFiles: ['/tmp/a.asm'] },
      async (_services, _resource, base) => ({
        ...base,
        revealOutput: false
      })
    );
    expect(runCourseTraceCase).toHaveBeenCalledTimes(1);
    expect(isCourseTraceBatchRunning()).toBe(false);
  });

  it('propagates a caller-provided pre-aborted signal before starting any case', async () => {
    const controller = new AbortController();
    controller.abort();
    await runCourseTraceBatch(
      services,
      [{ asm: URI.file('/tmp/a.asm') }],
      { kind: 'selected', asmFiles: ['/tmp/a.asm'] },
      async (_services, _resource, base) => ({ ...base }),
      { signal: controller.signal }
    );
    expect(runCourseTraceCase).not.toHaveBeenCalled();
    expect(isCourseTraceBatchRunning()).toBe(false);
  });

  it('keeps the automatic facade quiet and uses user-facing automatic-test wording', async () => {
    vi.mocked(runCourseTraceCase).mockResolvedValueOnce({
      asm: 'E:/private/builtin-p7-probe-timer.asm',
      status: 'passed',
      stage: 'compare',
      message: 'matched'
    });

    const resolveRunOptions = vi.fn(async (_services, _resource, base) => ({ ...base }));
    await runCourseTraceBatch(
      services,
      [{ asm: URI.file('E:/private/builtin-p7-probe-timer.asm') }],
      { kind: 'generator', commandLine: 'internal --count 1118', cwd: 'E:/private' },
      resolveRunOptions
    );

    expect(revealOutputChannel).not.toHaveBeenCalled();
    expect(resolveRunOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ revealOutput: false })
    );
    expect(services.output.appendLine).toHaveBeenCalledWith('自动测试: 1 个用例');
    expect(services.output.appendLine).not.toHaveBeenCalledWith(expect.stringContaining('E:/private'));
    expect(services.output.appendLine).not.toHaveBeenCalledWith(expect.stringContaining('Trace'));
    expect(services.output.appendLine).not.toHaveBeenCalledWith(expect.stringContaining('Batch'));
    expect(services.statusBar.text).toBe('');
  });

  it('does not misreport an unclassified framework exception as a trace comparison failure', async () => {
    vi.mocked(runCourseTraceCase).mockRejectedValueOnce(new Error('unexpected host failure'));

    await runCourseTraceBatch(
      services,
      [{ asm: URI.file('/tmp/a.asm') }],
      { kind: 'generator' },
      async (_services, _resource, base) => ({ ...base })
    );

    expect(vi.mocked(runCourseTraceCase)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordAsmCaseTestOutcome)).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ stage: 'internal' })
    );
    expect(services.output.appendLine).not.toHaveBeenCalledWith(expect.stringContaining('compare'));
  });

  it('refuses to start while continuous testing owns the shared artifact session', async () => {
    const lease = tryAcquireCourseTestSession('continuous');
    expect(lease).toBeDefined();
    const resolveRunOptions = vi.fn();
    try {
      await runCourseTraceBatch(
        services,
        [{ asm: URI.file('/tmp/a.asm') }],
        { kind: 'generator' },
        resolveRunOptions
      );
    } finally {
      lease?.release();
    }

    expect(resolveRunOptions).not.toHaveBeenCalled();
    expect(runCourseTraceCase).not.toHaveBeenCalled();
  });
});
