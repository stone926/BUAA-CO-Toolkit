import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { AppServices } from '../types';
import type { ContinuousGeneratedTraceDependencies } from '../courseTestContinuous';
import type { CourseTraceCaseResult } from '../courseTestReport';

const vscodeMocks = vi.hoisted(() => ({
  disposeListeners: [] as Array<() => void>,
  saveAll: vi.fn(async () => true),
  showInformationMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  createWebviewPanel: vi.fn(() => ({
    webview: { html: '' },
    onDidDispose: vi.fn((listener: () => void) => {
      vscodeMocks.disposeListeners.push(listener);
      return { dispose: () => undefined };
    })
  }))
}));

const configMocks = vi.hoisted(() => ({
  ensureConcreteProfile: vi.fn(async () => 'P5'),
  getMemoryConfiguration: vi.fn(() => 'FixedCompactLargeText'),
  getMipsEngine: vi.fn(() => 'auto')
}));

const policyMocks = vi.hoisted(() => ({
  intervalMs: vi.fn(() => 1),
  maxIterations: vi.fn(() => 1),
  reportRetainedIterations: vi.fn(() => 20),
  retainedPassingCases: vi.fn(() => 5),
  stopOnFailure: vi.fn(() => true)
}));

const fileMocks = vi.hoisted(() => ({
  ensureDirectory: vi.fn(async () => undefined),
  writeTextFile: vi.fn(async (_uri: unknown, _text: string) => undefined)
}));

vi.mock('vscode', async () => ({
  Uri: URI,
  ViewColumn: { Beside: 2 },
  workspace: {
    saveAll: vscodeMocks.saveAll
  },
  window: {
    showInformationMessage: vscodeMocks.showInformationMessage,
    showWarningMessage: vscodeMocks.showWarningMessage,
    showErrorMessage: vscodeMocks.showErrorMessage,
    createWebviewPanel: vscodeMocks.createWebviewPanel
  }
}));

vi.mock('../config', () => configMocks);

vi.mock('../fsUtil', () => fileMocks);

vi.mock('../process', () => ({
  revealOutputChannel: vi.fn()
}));

vi.mock('../toolchain', () => ({
  checkToolchain: vi.fn(async () => [])
}));

vi.mock('../courseTestToolchain', () => ({
  courseTraceMemoryConfigurationErrorForEngine: vi.fn(() => undefined),
  formatAutomaticToolchainFailure: vi.fn(() => 'automatic failure'),
  formatToolchainFailure: vi.fn(() => 'failure'),
  requiredCourseTraceToolchainChecks: vi.fn(() => new Set()),
  requiredToolchainFailures: vi.fn(() => [])
}));

const outcomeMocks = vi.hoisted(() => ({
  recordAsmCaseTestOutcome: vi.fn(async () => undefined)
}));

vi.mock('../asmCaseStore', () => outcomeMocks);

vi.mock('../courseTestReport', async (importOriginal) => ({
  ...await importOriginal<typeof import('../courseTestReport')>(),
  renderContinuousTraceMonitor: vi.fn(() => '<html></html>')
}));

import {
  startContinuousGeneratedTraceTests,
  stopContinuousTests
} from '../courseTestContinuous';
import { revealOutputChannel } from '../process';
import { checkToolchain } from '../toolchain';
import { recordAsmCaseTestOutcome } from '../asmCaseStore';
import { tryAcquireCourseTestSession } from '../courseTesting/courseTestSession';

interface TestSetup {
  resource: URI;
  folder: { uri: URI; name: string; index: number };
}

interface TestCase {
  asm: URI;
  stdin?: URI;
}

interface TestAsmCase {
  id: string;
}

interface TestRunOptions {
  token?: string;
}

type TestDependencies = ContinuousGeneratedTraceDependencies<TestSetup, TestCase, TestAsmCase, TestRunOptions>;

const resource = URI.file('E:/work/main.asm');
const asm = URI.file('E:/work/generated.asm');
const setup: TestSetup = {
  resource,
  folder: { uri: URI.file('E:/work'), name: 'work', index: 0 }
};

beforeEach(() => {
  vi.clearAllMocks();
  vscodeMocks.disposeListeners.splice(0);
  policyMocks.intervalMs.mockReturnValue(1);
  policyMocks.maxIterations.mockReturnValue(1);
  policyMocks.reportRetainedIterations.mockReturnValue(20);
  policyMocks.retainedPassingCases.mockReturnValue(5);
  policyMocks.stopOnFailure.mockReturnValue(true);
  fileMocks.writeTextFile.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('continuous generated trace orchestration', () => {
  it('reserves the session before asynchronous startup initialization completes', async () => {
    const pendingSetup = deferred<TestSetup | undefined>();
    const deps = createDependencies({
      resolveGeneratorRunSetup: vi.fn(() => pendingSetup.promise)
    });
    const first = startContinuousGeneratedTraceTests(createServices(), deps);
    const second = startContinuousGeneratedTraceTests(createServices(), deps);

    await second;
    expect(vscodeMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('已有一个自动测试'));
    expect(deps.resolveGeneratorRunSetup).toHaveBeenCalledTimes(1);

    pendingSetup.resolve(undefined);
    await first;
  });

  it('refuses to start while a batch owns the shared artifact session', async () => {
    const lease = tryAcquireCourseTestSession('batch');
    expect(lease).toBeDefined();
    const deps = createDependencies();
    try {
      await startContinuousGeneratedTraceTests(createServices(), deps);
    } finally {
      lease?.release();
    }

    expect(deps.resolveGeneratorRunSetup).not.toHaveBeenCalled();
    expect(deps.runGeneratorAndCollectAsms).not.toHaveBeenCalled();
  });

  it('can cancel a session while asynchronous startup is still resolving', async () => {
    const pendingSetup = deferred<TestSetup | undefined>();
    const deps = createDependencies({
      resolveGeneratorRunSetup: vi.fn(() => pendingSetup.promise)
    });
    const run = startContinuousGeneratedTraceTests(createServices(), deps);

    stopContinuousTests();
    pendingSetup.resolve(setup);
    await run;

    expect(vscodeMocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('取消正在启动'));
    expect(vscodeMocks.createWebviewPanel).not.toHaveBeenCalled();
    expect(deps.runGeneratorAndCollectAsms).not.toHaveBeenCalled();
  });

  it('continues after case errors when stop-on-failure is disabled', async () => {
    policyMocks.maxIterations.mockReturnValue(2);
    policyMocks.stopOnFailure.mockReturnValue(false);
    const deps = createDependencies({
      runCourseTraceCase: vi.fn(async (_services, item) => ({
        asm: item.asm.fsPath,
        status: 'error' as const,
        stage: 'mars' as const,
        message: 'invalid generated case'
      }))
    });

    await startContinuousGeneratedTraceTests(createServices(), deps);

    expect(deps.runGeneratorAndCollectAsms).toHaveBeenCalledTimes(2);
    expect(deps.runCourseTraceCase).toHaveBeenCalledTimes(2);
  });

  it('writes continuous results with the role-neutral v2 schema', async () => {
    const deps = createDependencies({
      runCourseTraceCase: vi.fn(async (_services, item) => ({
        asm: item.asm.fsPath,
        caseId: 'case-1',
        caseManifest: 'E:/work/.co/cases/case-1/case.json',
        status: 'failed' as const,
        stage: 'mars' as const,
        message: 'mismatch',
        marsOut: 'E:/work/oracle.out',
        simOut: 'E:/work/dut.out',
        marsEvents: 1,
        simEvents: 2
      }))
    });

    await startContinuousGeneratedTraceTests(createServices(), deps);

    const reports = fileMocks.writeTextFile.mock.calls.map(([, text]) => JSON.parse(String(text)));
    const report = reports.at(-1) as {
      schemaVersion: number;
      iterations: Array<{ source?: Record<string, unknown>; results: Array<Record<string, unknown>> }>;
      generator?: string;
      commandLine?: string;
      cwd?: string;
      options?: unknown;
      retention?: unknown;
    };
    expect(report.schemaVersion).toBe(2);
    expect(report.iterations[0].results[0]).toMatchObject({
      stage: 'oracle',
      asm: '测试点 1',
      status: 'failed',
      message: '[AUTO-MISMATCH] CPU 输出与参考结果不一致'
    });
    expect(JSON.stringify(report)).not.toContain('E:/work');
    expect(report.iterations[0].results[0]).not.toHaveProperty('oracleOut');
    expect(report.iterations[0].results[0]).not.toHaveProperty('dutOut');
    expect(report.iterations[0].results[0]).not.toHaveProperty('marsOut');
    expect(report.iterations[0].results[0]).not.toHaveProperty('simOut');
    expect(report.iterations[0].source).toEqual({ kind: 'generator' });
    expect(recordAsmCaseTestOutcome).toHaveBeenCalledWith(
      'E:/work/.co/cases/case-1/case.json',
      {
        status: 'failed',
        stage: 'oracle',
        diagnostic: '[AUTO-MISMATCH] CPU 输出与参考结果不一致'
      }
    );
    expect(report).not.toHaveProperty('generator');
    expect(report).not.toHaveProperty('commandLine');
    expect(report).not.toHaveProperty('cwd');
    expect(report).not.toHaveProperty('options');
    expect(report).not.toHaveProperty('retention');
    expect(deps.resolveCourseTraceRunOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ source: { kind: 'generator' } })
    );
    expect(checkToolchain).toHaveBeenCalledWith(
      expect.anything(),
      resource,
      { nonInteractive: true, engineMode: 'builtin' }
    );
    expect(revealOutputChannel).not.toHaveBeenCalled();
  });

  it('still stops on generator and iteration-level errors when stop-on-failure is disabled', async () => {
    policyMocks.maxIterations.mockReturnValue(3);
    policyMocks.stopOnFailure.mockReturnValue(false);
    const generatorErrorDeps = createDependencies({
      runGeneratorAndCollectAsms: vi.fn(async () => undefined)
    });

    await startContinuousGeneratedTraceTests(createServices(), generatorErrorDeps);
    expect(generatorErrorDeps.runGeneratorAndCollectAsms).toHaveBeenCalledTimes(1);

    const iterationErrorDeps = createDependencies({
      expandTraceCases: vi.fn(async () => {
        throw new Error('cannot expand cases');
      })
    });
    await startContinuousGeneratedTraceTests(createServices(), iterationErrorDeps);
    expect(iterationErrorDeps.runGeneratorAndCollectAsms).toHaveBeenCalledTimes(1);
    expect(iterationErrorDeps.expandTraceCases).toHaveBeenCalledTimes(1);
  });

  it('does not schedule an interval wait after the final finite iteration', async () => {
    policyMocks.intervalMs.mockReturnValue(60_000);
    policyMocks.maxIterations.mockReturnValue(1);
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await startContinuousGeneratedTraceTests(createServices(), createDependencies());

    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it('interrupts the interval wait when stop is requested', async () => {
    policyMocks.intervalMs.mockReturnValue(60_000);
    policyMocks.maxIterations.mockReturnValue(0);
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const deps = createDependencies();
    const run = startContinuousGeneratedTraceTests(createServices(), deps);

    await waitFor(() => timeoutSpy.mock.calls.length > 0);
    stopContinuousTests();
    await run;

    expect(deps.runGeneratorAndCollectAsms).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('停止持续测试'));
  });

  it('does not count an in-flight user cancellation as a test error', async () => {
    policyMocks.maxIterations.mockReturnValue(0);
    const pending = deferred<CourseTraceCaseResult>();
    const deps = createDependencies({
      runCourseTraceCase: vi.fn(async () => await pending.promise)
    });
    const run = startContinuousGeneratedTraceTests(createServices(), deps);

    await waitFor(() => vi.mocked(deps.runCourseTraceCase).mock.calls.length === 1);
    stopContinuousTests();
    pending.resolve({
      asm: asm.fsPath,
      status: 'error',
      cancelled: true,
      stage: 'oracle',
      message: 'aborted'
    });
    await run;

    const reports = fileMocks.writeTextFile.mock.calls.map(([, text]) => JSON.parse(String(text)));
    const finalReport = reports.at(-1) as {
      iterations: Array<{
        status: string;
        summary: { total: number; errors: number };
        results: unknown[];
      }>;
    };
    expect(finalReport.iterations[0]).toMatchObject({
      status: 'stopped',
      summary: { total: 0, errors: 0 },
      results: []
    });
  });

  it('releases the active session even when the final report write fails', async () => {
    let failFinalWrite = true;
    fileMocks.writeTextFile.mockImplementation(async (_uri, text) => {
      const report = JSON.parse(String(text)) as { running?: boolean };
      if (failFinalWrite && report.running === false) {
        failFinalWrite = false;
        throw new Error('disk full');
      }
    });
    const firstServices = createServices();

    await startContinuousGeneratedTraceTests(firstServices, createDependencies());
    await startContinuousGeneratedTraceTests(createServices(), createDependencies());

    expect(vscodeMocks.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(vscodeMocks.showWarningMessage).not.toHaveBeenCalled();
    expect(firstServices.output.appendLine).toHaveBeenCalledWith(expect.stringContaining('最终报告写入失败'));
  });
});

function createDependencies(overrides: Partial<TestDependencies> = {}): TestDependencies {
  return {
    automaticPolicy: () => ({
      intervalMs: policyMocks.intervalMs(),
      maxIterations: policyMocks.maxIterations(),
      stopOnFailure: policyMocks.stopOnFailure(),
      retainedPassingCases: policyMocks.retainedPassingCases(),
      reportRetainedIterations: policyMocks.reportRetainedIterations()
    }),
    resolveGeneratorRunSetup: vi.fn(async () => setup),
    generatorResource: vi.fn((value) => value.resource),
    generatorFolder: vi.fn((value) => value.folder as never),
    resolveCourseTraceRunOptions: vi.fn(async () => ({ token: 'run' })),
    runGeneratorAndCollectAsms: vi.fn(async () => ({
      asms: [asm],
      source: { kind: 'generator' as const, generator: 'test-generator' },
      asmCases: []
    })),
    expandTraceCases: vi.fn(async () => [{ asm }]),
    runCourseTraceCase: vi.fn(async (_services, item) => ({
      asm: item.asm.fsPath,
      status: 'passed' as const,
      stage: 'compare' as const,
      message: 'matched'
    })),
    ...overrides
  };
}

function createServices(): AppServices {
  return {
    output: {
      appendLine: vi.fn(),
      append: vi.fn(),
      show: vi.fn(),
      clear: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      name: 'continuous-test'
    } as never,
    statusBar: {
      text: ''
    } as never
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for asynchronous condition.');
}
