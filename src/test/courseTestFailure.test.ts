import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { AppServices } from '../types';
import type { CaseInspection } from '../courseTesting/caseInspection';
import type { CourseTraceCaseResult } from '../courseTestReport';

const mocks = vi.hoisted(() => {
  const panels: Array<{
    webview: { html: string; onDidReceiveMessage(listener: (message: unknown) => Promise<void>): { dispose(): void } };
    reveal: ReturnType<typeof vi.fn>;
    onDidDispose(listener: () => void): { dispose(): void };
    dispose(): void;
    listener?: (message: unknown) => Promise<void>;
    disposeListener?: () => void;
  }> = [];
  let activePanel: typeof panels[number] | undefined;
  let cancellation: (() => void) | undefined;
  const createPanel = vi.fn(() => {
    const panel = {
      webview: {
        html: '',
        onDidReceiveMessage(listener: (message: unknown) => Promise<void>) {
          panel.listener = listener;
          return { dispose: vi.fn() };
        }
      },
      reveal: vi.fn(),
      onDidDispose(listener: () => void) {
        panel.disposeListener = listener;
        return { dispose: vi.fn() };
      },
      dispose() { panel.disposeListener?.(); },
      listener: undefined as ((message: unknown) => Promise<void>) | undefined,
      disposeListener: undefined as (() => void) | undefined
    };
    panels.push(panel);
    activePanel = panel;
    return panel;
  });
  const withProgress = vi.fn(async (_options: unknown, callback: (progress: unknown, token: unknown) => Promise<unknown>) => {
    const token = {
      isCancellationRequested: false,
      onCancellationRequested(listener: () => void) {
        cancellation = listener;
        return { dispose: vi.fn() };
      }
    };
    return await callback({ report: vi.fn() }, token);
  });
  return {
    panels,
    get activePanel() { return activePanel; },
    get cancellation() { return cancellation; },
    cancelProgress() { cancellation?.(); },
    clearPanels() { panels.length = 0; activePanel = undefined; cancellation = undefined; },
    createPanel,
    withProgress,
    saveAll: vi.fn(async () => true),
    openTextDocument: vi.fn(async () => ({ lineCount: 64 })),
    showTextDocument: vi.fn(async (..._args: unknown[]) => undefined),
    executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
    loadCaseInspection: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    loadCaseWaveform: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    findSourceAtPc: vi.fn<(...args: unknown[]) => unknown>(),
    rerun: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    recordOutcome: vi.fn(async (..._args: unknown[]) => undefined),
    getProfile: vi.fn(() => 'P5')
  };
});

vi.mock('vscode', async () => {
  const { URI: VscodeUri } = await import('vscode-uri');
  return {
    Uri: VscodeUri,
    ViewColumn: { Beside: 2 },
    ProgressLocation: { Notification: 15 },
    Range: class Range {
      readonly start: { line: number; character: number };
      readonly end: { line: number; character: number };
      constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    commands: { executeCommand: mocks.executeCommand },
    workspace: { saveAll: mocks.saveAll, openTextDocument: mocks.openTextDocument },
    window: {
      createWebviewPanel: mocks.createPanel,
      withProgress: mocks.withProgress,
      showTextDocument: mocks.showTextDocument
    }
  };
});

vi.mock('../asmCaseStore', () => ({ recordAsmCaseTestOutcome: mocks.recordOutcome }));
vi.mock('../config', () => ({ getProfile: mocks.getProfile }));
vi.mock('../courseTesting/caseInspection', () => ({
  loadCaseInspection: mocks.loadCaseInspection,
  loadCaseWaveform: mocks.loadCaseWaveform,
  findSourceAtPc: mocks.findSourceAtPc
}));
vi.mock('../courseTesting/caseRerun', () => ({ rerunCourseTestCase: mocks.rerun }));

import { openCourseTestFailure } from '../courseTestFailure';
import { loadCaseInspection, findSourceAtPc } from '../courseTesting/caseInspection';
import { rerunCourseTestCase } from '../courseTesting/caseRerun';
import { recordAsmCaseTestOutcome } from '../asmCaseStore';
import { tryAcquireCourseTestSession } from '../courseTesting/courseTestSession';

const services = { output: { appendLine: vi.fn() } } as unknown as AppServices;
let caseSequence = 0;

function inspection(caseId: string, metadata?: Record<string, string>): CaseInspection {
  const dir = URI.file(`E:/work/.co/cases/${caseId}`);
  const manifest = {
    version: 2,
    caseId,
    profile: 'P5',
    originalAsmPath: 'E:/private/original.asm',
    metadata,
    program: {},
    oracle: {},
    source: { kind: 'builtin' },
    asmSnapshot: { path: 'program.asm', sha256: 'a'.repeat(64), bytes: 1 }
  } as unknown as CaseInspection['asmCase']['manifest'];
  return {
    asmCase: {
      id: caseId,
      dir,
      manifestUri: URI.file(`${dir.fsPath}/case.json`),
      asm: URI.file(`${dir.fsPath}/program.asm`),
      machineCode: URI.file(`${dir.fsPath}/code.txt`),
      sourceAsm: URI.file(`${dir.fsPath}/source/materialized/root.asm`),
      manifest
    },
    sourceAvailable: true,
    oracle: { uri: URI.file(`${dir.fsPath}/oracle/trace.out`) },
    dut: { uri: URI.file(`${dir.fsPath}/verilog/sim.out`) },
    logs: [{ label: 'Icarus 编译日志', uri: URI.file(`${dir.fsPath}/verilog/compile.log`) }],
    warnings: []
  } as CaseInspection;
}

function failingResult(overrides: Partial<CourseTraceCaseResult> = {}): CourseTraceCaseResult {
  return {
    asm: 'E:/work/.co/cases/new/program.asm',
    caseId: 'new-case',
    caseManifest: 'E:/work/.co/cases/new/case.json',
    status: 'failed',
    stage: 'compare',
    message: 'CPU 输出与参考结果不一致',
    firstDiff: {
      index: 2,
      status: 'diff',
      oracle: { pc: '00003004', kind: 'grf', target: '8', value: '00000002', raw: '', lineNumber: 14 },
      dut: { pc: '00003008', kind: 'grf', target: '8', value: '00000003', raw: '', lineNumber: 29 }
    },
    ...overrides
  };
}

function nextCaseId(): string {
  caseSequence++;
  return `case-${caseSequence}`;
}

async function open(caseId = nextCaseId()): Promise<NonNullable<typeof mocks.activePanel>> {
  const current = inspection(caseId, {
    'test.status': 'failed',
    'test.diagnostic': '首个写回差异',
    'test.evidence': JSON.stringify({
      version: 1, index: 3,
      oracle: { pc: '00003004', kind: 'grf', target: '8', value: '00000001', raw: '', lineNumber: 12 },
      dut: { pc: '00003008', kind: 'grf', target: '8', value: '00000002', raw: '', lineNumber: 27 }
    })
  });
  vi.mocked(loadCaseInspection).mockResolvedValue(current);
  vi.mocked(findSourceAtPc).mockImplementation((_value, pc) => ({
    pc: pc as number,
    uri: URI.file(`E:/work/.co/cases/${caseId}/source/materialized/root.asm`),
    line: pc === 0x3004 ? 7 : 9,
    text: `instruction at ${pc}`
  }));
  await openCourseTestFailure(services, 'E:/work/.co/cases', caseId);
  const panel = mocks.activePanel;
  if (!panel) throw new Error('Expected a failure panel');
  return panel;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clearPanels();
  mocks.saveAll.mockResolvedValue(true);
  mocks.openTextDocument.mockResolvedValue({ lineCount: 64 });
  mocks.withProgress.mockImplementation(async (_options, callback) => {
    const token = {
      isCancellationRequested: false,
      onCancellationRequested(listener: () => void) {
        // The production cancellation registration remains live until the callback settles.
        (mocks as unknown as { cancelProgress?: () => void }).cancelProgress = listener;
        return { dispose: vi.fn() };
      }
    };
    return await callback({ report: vi.fn() }, token);
  });
  vi.mocked(loadCaseInspection).mockReset();
  vi.mocked(findSourceAtPc).mockReset();
  vi.mocked(rerunCourseTestCase).mockReset();
  vi.mocked(recordAsmCaseTestOutcome).mockReset();
  vi.mocked(mocks.getProfile).mockReturnValue('P5');
});

afterEach(() => {
  for (const panel of mocks.panels) panel.dispose();
  const lease = tryAcquireCourseTestSession();
  lease?.release();
});

describe('course test failure panel', () => {
  it('restores a saved rerun waveform and its original-case relationship from history', async () => {
    const saved = inspection(`saved-wave-${++caseSequence}`, { 'rerun.originalCaseId': 'original-failure' });
    if (saved.asmCase.manifest.version !== 2) throw new Error('Expected v2 fixture');
    saved.asmCase.manifest.artifacts = { dut: { 'verilog/waveform': { path: 'verilog/saved.vcd', sha256: 'a'.repeat(64), bytes: 8 } } };
    mocks.loadCaseInspection.mockResolvedValue(saved);
    mocks.loadCaseWaveform.mockResolvedValue(URI.file('E:/work/.co/cases/saved/verilog/saved.vcd'));
    await openCourseTestFailure(services, 'E:/work/.co/cases', saved.asmCase.id);
    const panel = mocks.activePanel!;
    expect(panel.webview.html).toContain('打开本次波形');
    expect(panel.webview.html).toContain('original-failure');
    await panel.listener?.({ action: 'openWaveform' });
    expect(mocks.loadCaseWaveform).toHaveBeenCalledWith(saved);
    expect(mocks.executeCommand).toHaveBeenCalledWith('co.waveform.openFile', expect.anything());
    expect(mocks.rerun).not.toHaveBeenCalled();
  });

  it('ignores unknown actions and invalid source indexes', async () => {
    const panel = await open();
    await panel.listener?.({ action: 'made-up-action' });
    await panel.listener?.({ action: 'source', index: -1 });
    await panel.listener?.({ action: 'source', index: 999 });
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.showTextDocument).not.toHaveBeenCalled();
  });

  it('navigates with one-based source lines and compares oracle against DUT at the DUT trace row', async () => {
    const panel = await open('trace-navigation');
    await panel.listener?.({ action: 'source', index: 0 });
    expect(mocks.showTextDocument).toHaveBeenCalledTimes(1);
    const sourceOptions = mocks.showTextDocument.mock.calls[0][1] as { selection: { start: { line: number } } };
    expect(sourceOptions.selection.start.line).toBe(6); // source line 7, not trace line 12

    await panel.listener?.({ action: 'compare' });
    const expected = inspection('trace-navigation');
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expected.oracle!.uri,
      expected.dut!.uri,
      '参考写回 ↔ 待测 CPU 写回',
      expect.objectContaining({ selection: expect.objectContaining({ start: { line: 26, character: 0 } }) })
    );
  });

  it('saves before rerun, holds the shared session lease, and releases it after cancellation', async () => {
    const panel = await open();
    let signal: AbortSignal | undefined;
    let sessionWasBusy = false;
    vi.mocked(rerunCourseTestCase).mockImplementation(async (_svc, _case, options) => {
      signal = options?.signal;
      const competing = tryAcquireCourseTestSession();
      sessionWasBusy = !competing;
      competing?.release();
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { result: failingResult({ cancelled: true }) };
    });
    const pending = panel.listener?.({ action: 'rerun' });
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(mocks.saveAll).toHaveBeenCalledWith(false);
    expect(sessionWasBusy).toBe(true);
    expect(tryAcquireCourseTestSession()).toBeUndefined();
    mocks.cancelProgress();
    await pending;
    expect(signal?.aborted).toBe(true);
    const released = tryAcquireCourseTestSession();
    expect(released).toBeDefined();
    released?.release();
    expect(recordAsmCaseTestOutcome).not.toHaveBeenCalled();
  });

  it('records the new result evidence and opens its case without changing the original record', async () => {
    const original = inspection('old-case', { 'test.status': 'failed', 'test.diagnostic': 'old failure' });
    const next = inspection('new-case', { 'test.status': 'failed', 'test.diagnostic': 'new failure' });
    vi.mocked(loadCaseInspection).mockResolvedValueOnce(original).mockResolvedValueOnce(original).mockResolvedValueOnce(next);
    vi.mocked(findSourceAtPc).mockReturnValue(undefined);
    const panelPromise = openCourseTestFailure(services, 'E:/work/.co/cases', 'old-case');
    await panelPromise;
    const panel = mocks.activePanel!;
    vi.mocked(rerunCourseTestCase).mockResolvedValue({ result: failingResult() });
    await panel.listener?.({ action: 'rerun' });

    expect(recordAsmCaseTestOutcome).toHaveBeenCalledTimes(1);
    const [manifestPath, outcome] = vi.mocked(recordAsmCaseTestOutcome).mock.calls[0] as unknown as [string, {
      status: string; stage: string; evidence: string
    }];
    expect(manifestPath).toBe('E:/work/.co/cases/new/case.json');
    expect(outcome).toMatchObject({ status: 'failed', stage: 'compare' });
    expect(JSON.parse(outcome.evidence)).toMatchObject({ index: 2, oracle: { lineNumber: 14 }, dut: { lineNumber: 29 } });
    expect((original.asmCase.manifest as { metadata?: Record<string, string> }).metadata)
      .toEqual({ 'test.status': 'failed', 'test.diagnostic': 'old failure' });
    expect(mocks.loadCaseInspection).toHaveBeenLastCalledWith('E:/work/.co/cases', 'new-case');
    expect(panel.webview.html).toContain('用例重跑结果');
    expect(panel.webview.html).toContain('重跑自 <code>old-case</code>');
  });

  it('shows detailed preflight failure without recording history when no new case was created', async () => {
    const panel = await open();
    vi.mocked(rerunCourseTestCase).mockResolvedValue({
      result: failingResult({ caseId: undefined, caseManifest: undefined, message: '当前课程阶段 P4 与原用例 P5 不一致，请恢复原阶段后重跑' })
    });
    await panel.listener?.({ action: 'rerun' });
    expect(panel.webview.html).toContain('当前课程阶段 P4 与原用例 P5 不一致');
    expect(recordAsmCaseTestOutcome).not.toHaveBeenCalled();
  });

  it('aborts the active rerun when the panel is disposed', async () => {
    const panel = await open();
    let signal: AbortSignal | undefined;
    vi.mocked(rerunCourseTestCase).mockImplementation(async (_svc, _case, options) => {
      signal = options?.signal;
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { result: failingResult({ cancelled: true }) };
    });
    const pending = panel.listener?.({ action: 'rerun' });
    await vi.waitFor(() => expect(signal).toBeDefined());
    panel.dispose();
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(recordAsmCaseTestOutcome).not.toHaveBeenCalled();
    const released = tryAcquireCourseTestSession();
    expect(released).toBeDefined();
    released?.release();
  });
});
