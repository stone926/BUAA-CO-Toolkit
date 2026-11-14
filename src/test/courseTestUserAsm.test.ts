import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { AppServices } from '../types';
import type { CourseTraceCaseInput } from '../courseTestCases';
import type { CourseTraceRunOptions } from '../courseTesting/traceRunner';

const mocks = vi.hoisted(() => ({
  active: undefined as URI | undefined,
  save: vi.fn(async () => true),
  discover: vi.fn(async (input: string) => [input]),
  run: vi.fn(async (_services: AppServices, item: CourseTraceCaseInput, _options: CourseTraceRunOptions) => ({
    asm: item.asm.fsPath, status: 'passed' as const, stage: 'compare' as const, message: '通过'
  })),
  execute: vi.fn(async (..._args: unknown[]) => undefined),
  error: vi.fn(), warning: vi.fn(),
  write: vi.fn(async (_uri: unknown, _text: string) => undefined),
  profile: vi.fn(async (_uri: unknown) => 'P5'),
  pick: vi.fn(async (): Promise<{ reference?: 'auto' | 'mars'; directory?: boolean } | undefined> => ({ reference: 'auto' })),
  open: vi.fn(async (): Promise<URI[] | undefined> => undefined),
  rendered: vi.fn(() => '<html></html>'),
  cancelled: undefined as (() => void) | undefined
}));
vi.mock('vscode', () => ({
  Uri: URI, ViewColumn: { Active: 1 }, ProgressLocation: { Notification: 15 },
  commands: { executeCommand: mocks.execute },
  workspace: { saveAll: mocks.save },
  window: {
    visibleTextEditors: [], showErrorMessage: mocks.error, showWarningMessage: mocks.warning,
    showQuickPick: mocks.pick,
    withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) => task({}, {
      onCancellationRequested: (callback: () => void) => { mocks.cancelled = callback; return { dispose: vi.fn() }; }
    }),
    createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage: () => ({ dispose: vi.fn() }) }, onDidDispose: vi.fn() }),
    showOpenDialog: mocks.open
  }
}));
vi.mock('../configurationResource', () => ({ activeProjectResource: () => mocks.active }));
vi.mock('../config', () => ({ ensureConcreteProfile: mocks.profile }));
vi.mock('../asmCaseStore', () => ({
  asmCaseIndexDirectory: () => 'E:/cpu/.co/cases', recordAsmCaseTestOutcome: vi.fn(async () => undefined)
}));
vi.mock('../fsUtil', () => ({
  workspaceFolderFor: () => ({ uri: URI.file('E:/cpu'), name: 'cpu', index: 0 }),
  ensureDirectory: vi.fn(async () => undefined), writeTextFile: mocks.write
}));
vi.mock('../courseTestStdin', () => ({ findStdinCandidatesForAsm: vi.fn(async () => []) }));
vi.mock('../courseTestLogisim', () => ({ resolveP3LogisimTraceSetup: vi.fn() }));
vi.mock('../courseTesting/userAsmInputs', () => ({ discoverUserAsmInputs: mocks.discover }));
vi.mock('../courseTesting/userAsmBatchReport', () => ({ renderUserAsmBatchReport: mocks.rendered }));
vi.mock('../courseTesting/traceRunner', () => ({ runCourseTraceCase: mocks.run }));
vi.mock('../courseTesting/continuousCaseRetention', () => ({ markContinuousAsmCaseCancelled: vi.fn() }));
vi.mock('../courseTesting/workspaceCaseRetention', () => ({ WorkspaceCaseRetention: class {
  initialize = vi.fn(async () => undefined);
  observe = vi.fn(async () => undefined);
  prune = vi.fn(async () => ({ removed: [], refused: 0 }));
} }));

import { requestUserAsmTestsStop, runUserAsmTests } from '../courseTestUserAsm';
import { tryAcquireCourseTestSession } from '../courseTesting/courseTestSession';

const services = { output: { appendLine: vi.fn() } } as unknown as AppServices;
const asm = URI.file('D:/external ASM/用户.asm');
const cpu = URI.file('E:/cpu/design/mips.v');
beforeEach(() => {
  vi.clearAllMocks();
  mocks.active = cpu;
  mocks.save.mockResolvedValue(true);
  mocks.pick.mockResolvedValue({ reference: 'auto' });
  mocks.open.mockResolvedValue(undefined);
  mocks.discover.mockImplementation(async input => [input]);
  mocks.run.mockImplementation(async (_services, item) => ({ asm: item.asm.fsPath, status: 'passed', stage: 'compare', message: '通过' }));
});

describe('user ASM command routing', () => {
  it('routes an external source to the active CPU and stores its report in that workspace', async () => {
    await runUserAsmTests(services, asm);
    expect(mocks.profile).toHaveBeenCalledWith(cpu, expect.any(String));
    expect(mocks.run).toHaveBeenCalledWith(services, { asm: expect.objectContaining({ fsPath: asm.fsPath }) }, expect.objectContaining({ cpuResource: cpu, source: { kind: 'selected', asmFiles: [asm.fsPath] } }));
    expect(mocks.write.mock.calls.some(([uri]) => (uri as URI).fsPath === URI.file('E:/cpu/.co/out/user-asm-test-report.json').fsPath)).toBe(true);
    expect(mocks.execute).toHaveBeenLastCalledWith('setContext', 'co.continuousTestRunning', false);
    expect(requestUserAsmTestsStop()).toBe(false);
    const lease = tryAcquireCourseTestSession();
    expect(lease).toBeDefined();
    lease?.release();
  });

  it('honors an explicit CPU argument independently of the active assembly editor', async () => {
    mocks.active = asm;
    await runUserAsmTests(services, asm, cpu);
    expect(mocks.run.mock.calls[0][2].cpuResource).toBe(cpu);
    expect(mocks.run.mock.calls[0][1].asm.fsPath).toBe(asm.fsPath);
  });

  it('selects custom Mars for overriding known instructions independently of the target CPU', async () => {
    mocks.pick.mockResolvedValueOnce({ reference: 'mars' });
    await runUserAsmTests(services, asm, cpu);
    expect(mocks.run.mock.calls[0][2]).toMatchObject({ engineMode: 'mars', cpuResource: cpu });
    const report = JSON.parse(mocks.write.mock.calls.at(-1)![1]) as { referenceMode: string; cpuResource: string };
    expect(report.referenceMode).toBe('mars');
    expect(report.cpuResource).toBe(cpu.fsPath);
  });

  it.each(['auto', 'mars'] as const)('accepts explicit %s reference mode without showing the reference picker', async reference => {
    await runUserAsmTests(services, asm, cpu, reference);
    expect(mocks.pick).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls[0][2].engineMode).toBe(reference);
  });

  it('offers source selection followed by reference selection when invoked without a path', async () => {
    mocks.pick.mockResolvedValueOnce({ directory: false }).mockResolvedValueOnce({ reference: 'auto' });
    mocks.open.mockResolvedValueOnce([asm]);
    await runUserAsmTests(services);
    expect(mocks.pick).toHaveBeenCalledTimes(2);
    expect(mocks.run.mock.calls[0][1].asm.fsPath).toBe(asm.fsPath);
    expect(mocks.run.mock.calls[0][2]).toMatchObject({ cpuResource: cpu, engineMode: 'auto' });
  });

  it('cancels reference selection without starting a test or retaining the shared session', async () => {
    mocks.pick.mockResolvedValueOnce(undefined);
    await runUserAsmTests(services, asm, cpu);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(requestUserAsmTestsStop()).toBe(false);
    const lease = tryAcquireCourseTestSession();
    expect(lease).toBeDefined();
    lease?.release();
  });

  it('reserves the shared lease before asynchronous saves and stops cleanly during setup', async () => {
    let finishSave!: (saved: boolean) => void;
    mocks.save.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    const pending = runUserAsmTests(services, asm, cpu);
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalled());
    expect(tryAcquireCourseTestSession()).toBeUndefined();
    expect(requestUserAsmTestsStop()).toBe(true);
    finishSave(true);
    await pending;
    expect(mocks.run).not.toHaveBeenCalled();
    const lease = tryAcquireCourseTestSession();
    expect(lease).toBeDefined();
    lease?.release();
  });

  it('releases the shared lease and reports input discovery failures', async () => {
    mocks.discover.mockRejectedValueOnce(new Error('没有直属汇编文件'));
    await runUserAsmTests(services, asm, cpu);
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('没有直属汇编文件'));
    expect(mocks.run).not.toHaveBeenCalled();
    expect(requestUserAsmTestsStop()).toBe(false);
    const lease = tryAcquireCourseTestSession();
    expect(lease).toBeDefined();
    lease?.release();
  });
});
