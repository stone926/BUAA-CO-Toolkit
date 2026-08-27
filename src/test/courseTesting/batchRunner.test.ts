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

vi.mock('../../courseTestReport', () => ({
  batchSummary: vi.fn((results: Array<{ status: string }>) => ({
    total: results.length,
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    errors: results.filter((item) => item.status === 'error').length
  })),
  createCourseTraceBatchReport: vi.fn(() => ({ generatedAt: new Date().toISOString(), summary: { total: 0, passed: 0, failed: 0, errors: 0 }, results: [] })),
  neutralCourseTraceCaseResult: vi.fn((item: unknown) => item),
  showBatchTraceReport: vi.fn()
}));

import {
  isCourseTraceBatchRunning,
  runCourseTraceBatch,
  stopCourseTraceBatch
} from '../../courseTesting/batchRunner';
import { runCourseTraceCase } from '../../courseTesting/traceRunner';
import type { AppServices } from '../../types';

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
});
