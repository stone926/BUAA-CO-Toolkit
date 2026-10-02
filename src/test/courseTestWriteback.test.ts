import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { CaseInspection } from '../courseTesting/caseInspection';
import { buildWritebackComparison } from '../courseTesting/writebackComparison';
import { renderWritebackComparison } from '../courseTestWritebackReport';

const mocks = vi.hoisted(() => {
  const panels: Array<{
    webview: { html: string; onDidReceiveMessage(listener: (message: unknown) => Promise<void>): { dispose(): void } };
    reveal: ReturnType<typeof vi.fn>;
    viewColumn: number;
    onDidDispose(listener: () => void): { dispose(): void };
    dispose(): void;
    listener?: (message: unknown) => Promise<void>;
    disposeListener?: () => void;
  }> = [];
  const createPanel = vi.fn((_type: string, _title: string, column: number) => {
    const panel = {
      webview: {
        html: '',
        onDidReceiveMessage(listener: (message: unknown) => Promise<void>) {
          panel.listener = listener;
          return { dispose: vi.fn() };
        }
      },
      reveal: vi.fn(), viewColumn: column,
      onDidDispose(listener: () => void) {
        panel.disposeListener = listener;
        return { dispose: vi.fn() };
      },
      dispose() { panel.disposeListener?.(); },
      listener: undefined as ((message: unknown) => Promise<void>) | undefined,
      disposeListener: undefined as (() => void) | undefined
    };
    panels.push(panel);
    return panel;
  });
  return {
    panels, createPanel,
    loadTexts: vi.fn<(...args: unknown[]) => Promise<{ oracle: string; dut: string }>>(),
    findSourceAtPc: vi.fn<(...args: unknown[]) => unknown>(),
    openTextDocument: vi.fn(async (..._args: unknown[]) => ({ lineCount: 256 })),
    showTextDocument: vi.fn(async (..._args: unknown[]) => undefined),
    clearPanels() { panels.length = 0; }
  };
});

vi.mock('vscode', async () => {
  const { URI: VscodeUri } = await import('vscode-uri');
  return {
    Uri: VscodeUri,
    ViewColumn: { Active: 1, Beside: 2 },
    Range: class Range {
      readonly start: { line: number; character: number };
      readonly end: { line: number; character: number };
      constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    window: {
      createWebviewPanel: mocks.createPanel,
      showTextDocument: mocks.showTextDocument
    },
    workspace: { openTextDocument: mocks.openTextDocument }
  };
});

vi.mock('../courseTesting/caseInspection', () => ({
  loadCaseWritebackTexts: mocks.loadTexts,
  findSourceAtPc: mocks.findSourceAtPc
}));

import { openCourseWritebackComparison } from '../courseTestWriteback';

const oracleText = Array.from({ length: 70 }, (_, index) => {
  const value = (index === 12 ? 0x101 : index === 55 ? 0x202 : index + 1).toString(16).padStart(8, '0');
  return `@${(0x3000 + index * 4).toString(16)}: $1 <= ${value}`;
}).join('\n');
const dutText = ['WARNING: simulator emitted a harmless banner', ...Array.from({ length: 70 }, (_, index) => {
  const value = (index === 12 ? 0x100 : index === 55 ? 0x200 : index + 1).toString(16).padStart(8, '0');
  return `${38 + index}@${(0x3000 + index * 4).toString(16)}: $ 1 <= ${value}`;
})].join('\n');

function inspection(id = 'writeback-case'): CaseInspection {
  const dir = URI.file(`E:/work/.co/cases/${id}`);
  return {
    asmCase: {
      id, dir,
      manifestUri: URI.file(`${dir.fsPath}/case.json`),
      asm: URI.file(`${dir.fsPath}/program.asm`),
      sourceAsm: URI.file(`${dir.fsPath}/source/materialized/root.asm`),
      manifest: { version: 2, caseId: id, metadata: {} }
    },
    oracle: { uri: URI.file(`${dir.fsPath}/oracle/trace.out`) },
    dut: { uri: URI.file(`${dir.fsPath}/verilog/sim.out`) },
    sourceAvailable: true, warnings: []
  } as unknown as CaseInspection;
}

function selectedIndex(html: string): number | undefined {
  const match = /<tr class="[^"]* selected"[^>]*>[\s\S]*?<button[^>]*class="event-index"[^>]*>(\d+)<\/button>/.exec(html);
  return match ? Number(match[1]) - 1 : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clearPanels();
  mocks.loadTexts.mockResolvedValue({ oracle: oracleText, dut: dutText });
  mocks.findSourceAtPc.mockImplementation((candidate, pc) => ({
    pc: pc as number,
    uri: (candidate as CaseInspection).asmCase.sourceAsm,
    line: pc === 0x3030 ? 7 : 9,
    text: `instruction at ${pc}`
  }));
  mocks.openTextDocument.mockResolvedValue({ lineCount: 256 });
});

afterEach(() => { for (const panel of mocks.panels) panel.dispose(); });

describe('course test writeback comparison panel', () => {
  it('opens at the first difference, navigates differences and pages real rendered context', async () => {
    const current = inspection('writeback-navigation');
    const model = await buildWritebackComparison(oracleText, dutText);
    expect(model.differences).toEqual([12, 55]);
    const panel = await (async () => {
      await openCourseWritebackComparison(current, 2);
      return mocks.panels[0]!;
    })();

    expect(panel.viewColumn).toBe(2);
    expect(panel.webview.html).toContain('写回记录对照');
    expect(panel.webview.html).toContain('2 项写回差异');
    expect(panel.webview.html).toContain('第 8–48 项 / 70');
    expect(selectedIndex(panel.webview.html)).toBe(12);
    expect(panel.webview.html).toContain('定位第 13 项参考指令');

    await panel.listener?.({ action: 'next' });
    expect(selectedIndex(panel.webview.html)).toBe(55);
    expect(panel.webview.html).toContain('第 51–70 项 / 70');
    await panel.listener?.({ action: 'previous' });
    expect(selectedIndex(panel.webview.html)).toBe(12);
    await panel.listener?.({ action: 'first' });
    expect(selectedIndex(panel.webview.html)).toBe(12);

    await panel.listener?.({ action: 'pageNext' });
    expect(selectedIndex(panel.webview.html)).toBe(48);
    expect(panel.webview.html).toContain('第 49–70 项 / 70');
    await panel.listener?.({ action: 'pagePrevious' });
    expect(selectedIndex(panel.webview.html)).toBe(7);
    expect(panel.webview.html).toContain('第 8–48 项 / 70');
  });

  it('jumps to saved ASM lines and the exact raw DUT trace line after WARNING output', async () => {
    const current = inspection('writeback-source');
    await openCourseWritebackComparison(current, 2);
    const panel = mocks.panels[0]!;
    await panel.listener?.({ action: 'source', row: 12, side: 'oracle' });
    expect(mocks.findSourceAtPc).toHaveBeenCalledWith(current, 0x3030);
    expect(mocks.openTextDocument).toHaveBeenCalledWith(current.asmCase.sourceAsm);
    const sourceOptions = mocks.showTextDocument.mock.calls[0]![1] as { selection: { start: { line: number } } };
    expect(sourceOptions.selection.start.line).toBe(6); // saved ASM line 7 is one-based

    await panel.listener?.({ action: 'rawDut' });
    expect(mocks.openTextDocument).toHaveBeenLastCalledWith(current.dut!.uri);
    const rawOptions = mocks.showTextDocument.mock.calls[1]![1] as { selection: { start: { line: number } } };
    expect(rawOptions.selection.start.line).toBe(13); // WARNING line shifts event 12 to raw line 14
  });

  it('jumps to the raw document end when the focused event is missing from that side', async () => {
    mocks.loadTexts.mockResolvedValueOnce({
      oracle: '@3000: $1 <= 1\n@3004: $2 <= 2',
      dut: '38@3000: $1 <= 1'
    });
    const current = inspection('writeback-missing-dut');
    await openCourseWritebackComparison(current, 2);
    const panel = mocks.panels[0]!;
    expect(selectedIndex(panel.webview.html)).toBe(1);
    await panel.listener?.({ action: 'rawDut' });
    expect(mocks.openTextDocument).toHaveBeenLastCalledWith(current.dut!.uri);
    const rawOptions = mocks.showTextDocument.mock.calls[0]![1] as { selection: { start: { line: number } } };
    expect(rawOptions.selection.start.line).toBe(255); // missing DUT event maps to EOF, not the first line
  });

  it('reuses an open panel without rereading traces', async () => {
    const current = inspection('writeback-reuse');
    await openCourseWritebackComparison(current, 2);
    const panel = mocks.panels[0]!;
    await openCourseWritebackComparison(current, 3);
    expect(mocks.panels).toHaveLength(1);
    expect(mocks.loadTexts).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalledWith();
  });

  it('ignores unknown actions and invalid row or side values', async () => {
    const current = inspection('writeback-invalid-navigation');
    await openCourseWritebackComparison(current, 2);
    const panel = mocks.panels[0]!;
    const before = panel.webview.html;
    await panel.listener?.({ action: 'unknown' });
    await panel.listener?.({ action: 'source', row: 12, side: 'invalid' });
    await panel.listener?.({ action: 'source', row: 2, side: 'oracle' });
    await panel.listener?.({ action: 'select', row: 9999 });
    expect(panel.webview.html).toBe(before);
    expect(mocks.openTextDocument).not.toHaveBeenCalled();
    expect(mocks.showTextDocument).not.toHaveBeenCalled();
  });

  it('does not render a completed load after the panel is disposed', async () => {
    let resolveLoad!: (value: { oracle: string; dut: string }) => void;
    mocks.loadTexts.mockReturnValueOnce(new Promise(resolve => { resolveLoad = resolve; }));
    const pending = openCourseWritebackComparison(inspection('writeback-disposed'), 2);
    const panel = mocks.panels[0]!;
    const loading = panel.webview.html;
    expect(loading).toContain('正在对齐写回事件');
    panel.dispose();
    resolveLoad({ oracle: oracleText, dut: dutText });
    await pending;
    expect(panel.webview.html).toBe(loading);
    expect(panel.listener).toBeUndefined();
  });
});
