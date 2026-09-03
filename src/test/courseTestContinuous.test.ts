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
  recordAsmCaseTestOutcome: vi.fn(async () => undefined),
  markContinuousAsmCaseCancelled: vi.fn(async () => true),
  discardContinuousGeneratedAsmCase: vi.fn(async () => true),
  discardContinuousPassingAsmCase: vi.fn(async () => true)
}));

vi.mock('../asmCaseStore', () => outcomeMocks);
vi.mock('../courseTesting/continuousCaseRetention', () => ({
  markContinuousAsmCaseCancelled: outcomeMocks.markContinuousAsmCaseCancelled,
  discardContinuousGeneratedAsmCase: outcomeMocks.discardContinuousGeneratedAsmCase,
  discardContinuousPassingAsmCase: outcomeMocks.discardContinuousPassingAsmCase
}));

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
import {
  discardContinuousGeneratedAsmCase,
  discardContinuousPassingAsmCase,
  markContinuousAsmCaseCancelled
} from '../courseTesting/continuousCaseRetention';
import { recordAsmCaseTestOutcome } from '../asmCaseStore';
import { tryAcquireCourseTestSession } from '../courseTesting/courseTestSession';

interface TestSetup {
  resource: URI;
  folder: { uri: URI; name: string; index: number };
}

interface TestCase {
  asm: URI;
  stdin?: URI;
  asmCase?: TestAsmCase;
}

interface TestAsmCase {
  id: string;
  manifestUri: URI;
  asm: URI;
}

interface TestRunOptions {
  token?: string;
}

type TestDependencies = ContinuousGeneratedTraceDependencies<TestSetup, TestCase, TestAsmCase, TestRunOptions>;

const resource = URI.file('E:/work/main.asm');
const asm = URI.file('E:/work/generated.asm');
const secondAsm = URI.file('E:/work/generated-2.asm');
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
    expect(vscodeMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('已有一个测试任务'));
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
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    policyMocks.maxIterations.mockReturnValue(2);
    policyMocks.stopOnFailure.mockReturnValue(false);
    const deps = createDependencies({
      expandTraceCases: vi.fn(async () => [{ asm }, { asm: secondAsm }]),
      runCourseTraceCase: vi.fn(async (_services, item) => ({
        asm: item.asm.fsPath,
        status: 'error' as const,
        stage: 'mars' as const,
        message: 'invalid generated case'
      }))
    });

    await startContinuousGeneratedTraceTests(createServices(), deps);

    expect(deps.runGeneratorAndCollectAsms).toHaveBeenCalledTimes(2);
    expect(deps.runCourseTraceCase).toHaveBeenCalledTimes(4);
    expect(fileMocks.writeTextFile).toHaveBeenCalledTimes(2);
  });

  it('does not execute a second case in the same iteration after the first case fails', async () => {
    const deps = createDependencies({
      expandTraceCases: vi.fn(async () => [{ asm }, { asm: secondAsm }]),
      runCourseTraceCase: vi.fn(async (_services, item) => ({
        asm: item.asm.fsPath,
        status: item.asm.fsPath === asm.fsPath ? 'failed' as const : 'passed' as const,
        stage: 'compare' as const,
        message: item.asm.fsPath === asm.fsPath ? 'mismatch' : 'matched'
      }))
    });

    await startContinuousGeneratedTraceTests(createServices(), deps);

    expect(deps.runCourseTraceCase).toHaveBeenCalledTimes(1);
    expect(deps.runCourseTraceCase).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ asm }),
      expect.anything()
    );
  });

  it('preserves the first failed P7 case and discards the generated cases that were never executed', async () => {
    const generatedCases = [
      testAsmCase('case-anchor'),
      testAsmCase('case-core-probe'),
      testAsmCase('case-timer-probe')
    ];
    const deps = createDependencies({
      runGeneratorAndCollectAsms: vi.fn(async () => ({
        asms: generatedCases.map((item) => item.asm),
        source: { kind: 'generator' as const },
        asmCases: generatedCases
      })),
      expandTraceCases: vi.fn<TestDependencies['expandTraceCases']>(async (_asms, asmCases) =>
        (asmCases ?? []).map((asmCase) => ({ asm: asmCase.asm, asmCase }))),
      runCourseTraceCase: vi.fn(async (_services, item) => ({
        asm: item.asm.fsPath,
        caseId: item.asmCase!.id,
        caseManifest: item.asmCase!.manifestUri.fsPath,
        status: 'failed' as const,
        stage: 'compare' as const,
        message: 'mismatch'
      }))
    });

    await startContinuousGeneratedTraceTests(createServices(), deps);

    expect(deps.runCourseTraceCase).toHaveBeenCalledTimes(1);
    const generatorOptions = vi.mocked(deps.runGeneratorAndCollectAsms).mock.calls[0][2];
    expect(generatorOptions.continuous).toMatchObject({
      sessionId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      iteration: 1
    });
    expect(recordAsmCaseTestOutcome).toHaveBeenCalledWith(
      generatedCases[0].manifestUri.fsPath,
      expect.objectContaining({
        status: 'failed',
        continuous: expect.objectContaining({ state: 'failed' })
      })
    );
    expect(discardContinuousGeneratedAsmCase).toHaveBeenCalledTimes(2);
    expect(discardContinuousGeneratedAsmCase).toHaveBeenCalledWith(
      generatedCases[1].manifestUri.fsPath,
      expect.any(String)
    );
    expect(discardContinuousGeneratedAsmCase).toHaveBeenCalledWith(
      generatedCases[2].manifestUri.fsPath,
      expect.any(String)
    );
    expect(discardContinuousGeneratedAsmCase).not.toHaveBeenCalledWith(
      generatedCases[0].manifestUri.fsPath,
      expect.any(String)
    );
  });

  it('does not execute a second case in the same iteration after the first case errors', async () => {
    const deps = createDependencies({
      expandTraceCases: vi.fn(async () => [{ asm }, { asm: secondAsm }]),
      runCourseTraceCase: vi.fn(async (_services, item) => ({
        asm: item.asm.fsPath,
        status: item.asm.fsPath === asm.fsPath ? 'error' as const : 'passed' as const,
        stage: item.asm.fsPath === asm.fsPath ? 'mars' as const : 'compare' as const,
        message: item.asm.fsPath === asm.fsPath ? 'invalid generated case' : 'matched'
      }))
    });

    await startContinuousGeneratedTraceTests(createServices(), deps);

    expect(deps.runCourseTraceCase).toHaveBeenCalledTimes(1);
    expect(deps.runCourseTraceCase).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ asm }),
      expect.anything()
    );
  });

  it('classifies an unhandled case exception as an internal framework error', async () => {
    const deps = createDependencies({
      runCourseTraceCase: vi.fn(async () => {
        throw new Error('unexpected host failure');
      })
    });

    await startContinuousGeneratedTraceTests(createServices(), deps);

    expect(recordAsmCaseTestOutcome).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ stage: 'internal' })
    );
  });

  it('persists a terminal outcome through the generated case when a runner result omits its manifest', async () => {
    const asmCase = testAsmCase('runner-omitted-manifest');
    const deps = createDependencies({
      runGeneratorAndCollectAsms: vi.fn(async () => ({
        asms: [asmCase.asm],
        source: { kind: 'generator' as const },
        asmCases: [asmCase]
      })),
      expandTraceCases: vi.fn(async () => [{ asm: asmCase.asm, asmCase }]),
      runCourseTraceCase: vi.fn(async () => ({
        asm: asmCase.asm.fsPath,
        status: 'error' as const,
        stage: 'internal' as const,
        message: 'runner omitted case identity'
      }))
    });

    await startContinuousGeneratedTraceTests(createServices(), deps);

    expect(recordAsmCaseTestOutcome).toHaveBeenCalledWith(
      asmCase.manifestUri.fsPath,
      expect.objectContaining({
        status: 'error',
        continuous: expect.objectContaining({ state: 'error' })
      })
    );
    expect(discardContinuousGeneratedAsmCase).not.toHaveBeenCalledWith(
      asmCase.manifestUri.fsPath,
      expect.any(String)
    );
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

  it('reports a stop, not an iteration error, when cancellation finishes inside generation', async () => {
    policyMocks.maxIterations.mockReturnValue(0);
    const services = createServices();
    const deps = createDependencies({
      runGeneratorAndCollectAsms: vi.fn(async () => {
        stopContinuousTests();
        return undefined;
      })
    });

    await startContinuousGeneratedTraceTests(services, deps);

    const reports = fileMocks.writeTextFile.mock.calls.map(([, text]) => JSON.parse(String(text)));
    const finalReport = reports.at(-1) as {
      iterations: Array<{
        status: string;
        summary: { total: number; errors: number };
        results: unknown[];
        message?: string;
      }>;
    };
    expect(finalReport.iterations[0]).toMatchObject({
      status: 'stopped',
      summary: { total: 0, errors: 0 },
      results: []
    });
    expect(finalReport.iterations[0]).not.toHaveProperty('message');
    expect(services.output.appendLine).not.toHaveBeenCalledWith('未能准备新的自动测试点');
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
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

  it('marks and discards a cancelled P7 case together with its unexecuted siblings', async () => {
    policyMocks.maxIterations.mockReturnValue(0);
    const generatedCases = [
      testAsmCase('cancel-anchor'),
      testAsmCase('cancel-core-probe'),
      testAsmCase('cancel-timer-probe')
    ];
    const deps = createDependencies({
      runGeneratorAndCollectAsms: vi.fn(async () => ({
        asms: generatedCases.map((item) => item.asm),
        source: { kind: 'generator' as const },
        asmCases: generatedCases
      })),
      expandTraceCases: vi.fn<TestDependencies['expandTraceCases']>(async (_asms, asmCases) =>
        (asmCases ?? []).map((asmCase) => ({ asm: asmCase.asm, asmCase }))),
      runCourseTraceCase: vi.fn(async (_services, item) => {
        stopContinuousTests();
        return {
          asm: item.asm.fsPath,
          caseId: item.asmCase!.id,
          caseManifest: item.asmCase!.manifestUri.fsPath,
          status: 'error' as const,
          cancelled: true as const,
          stage: 'dut' as const,
          message: 'aborted'
        };
      })
    });

    await startContinuousGeneratedTraceTests(createServices(), deps);

    expect(markContinuousAsmCaseCancelled).toHaveBeenCalledWith(
      generatedCases[0].manifestUri.fsPath,
      expect.any(String)
    );
    expect(recordAsmCaseTestOutcome).not.toHaveBeenCalled();
    expect(discardContinuousGeneratedAsmCase).toHaveBeenCalledTimes(3);
    for (const item of generatedCases) {
      expect(discardContinuousGeneratedAsmCase).toHaveBeenCalledWith(
        item.manifestUri.fsPath,
        expect.any(String)
      );
    }
  });

  it('discards every generated case when case expansion fails', async () => {
    const generatedCases = [testAsmCase('expand-1'), testAsmCase('expand-2'), testAsmCase('expand-3')];
    const deps = createDependencies({
      runGeneratorAndCollectAsms: vi.fn(async () => ({
        asms: generatedCases.map((item) => item.asm),
        source: { kind: 'generator' as const },
        asmCases: generatedCases
      })),
      expandTraceCases: vi.fn(async () => {
        throw new Error('cannot expand cases');
      })
    });

    await startContinuousGeneratedTraceTests(createServices(), deps);

    expect(discardContinuousGeneratedAsmCase).toHaveBeenCalledTimes(3);
    expect(deps.runCourseTraceCase).not.toHaveBeenCalled();
  });

  it('rotates a refused passing-retention case without starving a later victim', async () => {
    policyMocks.maxIterations.mockReturnValue(2);
    policyMocks.retainedPassingCases.mockReturnValue(0);
    const generatedCases = [testAsmCase('retention-1'), testAsmCase('retention-2')];
    let generation = 0;
    vi.mocked(discardContinuousPassingAsmCase)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const deps = createDependencies({
      runGeneratorAndCollectAsms: vi.fn(async () => {
        const asmCase = generatedCases[generation++];
        return {
          asms: [asmCase.asm],
          source: { kind: 'generator' as const },
          asmCases: [asmCase]
        };
      }),
      expandTraceCases: vi.fn(async (_asms, asmCases) => [{
        asm: asmCases![0].asm,
        asmCase: asmCases![0]
      }]),
      runCourseTraceCase: vi.fn(async (_services, item) => ({
        asm: item.asm.fsPath,
        caseId: item.asmCase!.id,
        caseManifest: item.asmCase!.manifestUri.fsPath,
        asmSnapshot: item.asmCase!.asm.fsPath,
        status: 'passed' as const,
        stage: 'compare' as const,
        message: 'matched'
      }))
    });

    await startContinuousGeneratedTraceTests(createServices(), deps);

    expect(discardContinuousPassingAsmCase).toHaveBeenCalledTimes(3);
    expect(discardContinuousPassingAsmCase).toHaveBeenNthCalledWith(
      1,
      generatedCases[0].manifestUri.fsPath,
      expect.any(String)
    );
    expect(discardContinuousPassingAsmCase).toHaveBeenNthCalledWith(
      3,
      generatedCases[1].manifestUri.fsPath,
      expect.any(String)
    );
    expect(discardContinuousPassingAsmCase).toHaveBeenNthCalledWith(
      2,
      generatedCases[0].manifestUri.fsPath,
      expect.any(String)
    );
    const reports = fileMocks.writeTextFile.mock.calls.map(([, text]) => JSON.parse(String(text)));
    const finalReport = reports.at(-1) as {
      iterations: Array<{ results: Array<{ artifactsPruned?: boolean }> }>;
    };
    expect(finalReport.iterations.flatMap((iteration) => iteration.results))
      .toEqual([
        expect.objectContaining({ artifactsPruned: true }),
        expect.not.objectContaining({ artifactsPruned: true })
      ]);
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

function testAsmCase(id: string): TestAsmCase {
  const caseDir = `E:/work/.co/cases/${id}`;
  return {
    id,
    manifestUri: URI.file(`${caseDir}/case.json`),
    asm: URI.file(`${caseDir}/program.asm`)
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
