import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { AppServices } from '../types';
import type { ContinuousGeneratedTraceDependencies } from '../courseTestContinuous';

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
  getContinuousIntervalMs: vi.fn(() => 1),
  getContinuousMaxIterations: vi.fn(() => 1),
  getContinuousReportRetainedIterations: vi.fn(() => 20),
  getContinuousRetainedPassingCases: vi.fn(() => 5),
  getContinuousStopOnFailure: vi.fn(() => true),
  getMemoryConfiguration: vi.fn(() => 'FixedCompactLargeText')
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
  MARS_COURSE_IM_CHECK: 'MARS course IM',
  MARS_P7_CONTRACT_CHECK: 'MARS P7 contract',
  courseTraceMemoryConfigurationError: vi.fn(() => undefined),
  formatToolchainFailure: vi.fn(() => 'failure'),
  requiredToolchainFailures: vi.fn(() => [])
}));

vi.mock('../courseTestReport', () => ({
  renderContinuousTraceMonitor: vi.fn(() => '<html></html>')
}));

import {
  startContinuousGeneratedTraceTests,
  stopContinuousTests
} from '../courseTestContinuous';

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
  configMocks.getContinuousIntervalMs.mockReturnValue(1);
  configMocks.getContinuousMaxIterations.mockReturnValue(1);
  configMocks.getContinuousReportRetainedIterations.mockReturnValue(20);
  configMocks.getContinuousRetainedPassingCases.mockReturnValue(5);
  configMocks.getContinuousStopOnFailure.mockReturnValue(true);
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
    expect(vscodeMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('已有一个持续'));
    expect(deps.resolveGeneratorRunSetup).toHaveBeenCalledTimes(1);

    pendingSetup.resolve(undefined);
    await first;
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
    configMocks.getContinuousMaxIterations.mockReturnValue(2);
    configMocks.getContinuousStopOnFailure.mockReturnValue(false);
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

  it('still stops on generator and iteration-level errors when stop-on-failure is disabled', async () => {
    configMocks.getContinuousMaxIterations.mockReturnValue(3);
    configMocks.getContinuousStopOnFailure.mockReturnValue(false);
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
    configMocks.getContinuousIntervalMs.mockReturnValue(60_000);
    configMocks.getContinuousMaxIterations.mockReturnValue(1);
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await startContinuousGeneratedTraceTests(createServices(), createDependencies());

    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it('interrupts the interval wait when stop is requested', async () => {
    configMocks.getContinuousIntervalMs.mockReturnValue(60_000);
    configMocks.getContinuousMaxIterations.mockReturnValue(0);
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const deps = createDependencies();
    const run = startContinuousGeneratedTraceTests(createServices(), deps);

    await waitFor(() => timeoutSpy.mock.calls.length > 0);
    stopContinuousTests();
    await run;

    expect(deps.runGeneratorAndCollectAsms).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('停止持续测试'));
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
    resolveGeneratorRunSetup: vi.fn(async () => setup),
    generatorResource: vi.fn((value) => value.resource),
    generatorFolder: vi.fn((value) => value.folder as never),
    generatorLabel: vi.fn(() => 'test-generator'),
    generatorCommandLine: vi.fn(() => 'test-generator --run'),
    generatorCwd: vi.fn(() => 'E:/work'),
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
