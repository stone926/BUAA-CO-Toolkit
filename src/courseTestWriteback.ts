// @index course-testing — 写回对照宿主：惰性解析、分页/差异导航与真实源码和日志行跳转
import * as vscode from 'vscode';
import { html, renderReportPage } from './webview/reportLayout';
import { normalizePathKey } from './pathUtils';
import { findSourceAtPc, loadCaseWritebackTexts, type CaseInspection } from './courseTesting/caseInspection';
import { buildWritebackComparison, initialWritebackFocus } from './courseTesting/writebackComparison';
import { evidencePc, parseFailureEvidence } from './courseTesting/failureEvidence';
import { isManifestV2 } from './courseTesting/manifestCodec';
import { renderWritebackComparison, writebackPageSize } from './courseTestWritebackReport';
import { textEditorColumn } from './editorNavigation';

const panels = new Map<string, vscode.WebviewPanel>();

export async function openCourseWritebackComparison(inspection: CaseInspection, column = vscode.ViewColumn.Active): Promise<void> {
  const key = normalizePathKey(inspection.asmCase.manifestUri.fsPath);
  const existing = panels.get(key);
  if (existing) { existing.reveal(); return; }
  const panel = vscode.window.createWebviewPanel('coWritebackComparison', '写回记录对照', column, {
    enableScripts: true, enableFindWidget: true, localResourceRoots: [], retainContextWhenHidden: true
  });
  panels.set(key, panel);
  const controller = new AbortController();
  let disposed = false;
  let listener: vscode.Disposable | undefined;
  panel.onDidDispose(() => {
    disposed = true;
    controller.abort();
    listener?.dispose();
    if (panels.get(key) === panel) panels.delete(key);
  });
  panel.webview.html = renderReportPage({ title: '写回记录对照', body: html.raw('<p role="status">正在对齐写回事件…关闭此页可取消。</p>') });
  try {
    const text = await loadCaseWritebackTexts(inspection);
    if (disposed) return;
    const model = await buildWritebackComparison(text.oracle, text.dut, { signal: controller.signal });
    if (disposed) return;
    const manifest = inspection.asmCase.manifest;
    const metadata = isManifestV2(manifest) ? manifest.metadata : undefined;
    const savedDifference = parseFailureEvidence(metadata?.['test.evidence']);
    let focus = initialWritebackFocus(model, savedDifference);
    let start = Math.max(0, focus - 5);
    let message: string | undefined;
    const render = () => {
      if (disposed) return;
      const sources = new Map<string, { line: number; text: string }>();
      for (const row of model.rows.slice(start, start + writebackPageSize)) {
        for (const side of ['oracle', 'dut'] as const) {
          const pc = evidencePc(row[side]?.pc);
          const location = pc === undefined ? undefined : findSourceAtPc(inspection, pc);
          if (location) sources.set(`${row.index}:${side}`, location);
        }
      }
      panel.webview.html = renderWritebackComparison({
        caseId: inspection.asmCase.id, comparison: model, focus, start, sources, message, savedDifference,
        diagnostic: metadata?.['test.diagnostic']?.slice(0, 4096)
      });
    };
    const navigate = (index: number | undefined) => {
      if (index === undefined) return;
      focus = index;
      start = Math.max(0, focus - 5);
      message = undefined;
      render();
    };
    listener = panel.webview.onDidReceiveMessage(async (input: unknown) => {
      if (disposed || !input || typeof input !== 'object') return;
      const { action, row, side } = input as { action?: unknown; row?: unknown; side?: unknown };
      const selected = typeof row === 'number' && Number.isSafeInteger(row) && row >= start && row < Math.min(start + writebackPageSize, model.rows.length)
        ? model.rows[row] : undefined;
      try {
        switch (action) {
          case 'first': navigate(model.differences[0]); return;
          case 'previous': {
            const nextIndex = model.differences.findIndex(index => index >= focus);
            navigate(nextIndex < 0 ? model.differences[model.differences.length - 1] : model.differences[nextIndex - 1]);
            return;
          }
          case 'next': navigate(model.differences.find(index => index > focus)); return;
          case 'pagePrevious':
          case 'pageNext':
            start = Math.max(0, Math.min(Math.max(0, model.rows.length - 1), start + (action === 'pageNext' ? writebackPageSize : -writebackPageSize)));
            focus = start;
            message = undefined;
            render(); return;
          case 'select':
            if (selected) { focus = selected.index; message = undefined; render(); }
            return;
          case 'source': {
            if (!selected || (side !== 'oracle' && side !== 'dut')) return;
            const pc = evidencePc(selected[side]?.pc);
            const source = pc === undefined ? undefined : findSourceAtPc(inspection, pc);
            if (source) await revealText(source.uri, source.line);
            return;
          }
          case 'rawOracle':
          case 'rawDut': {
            const role = action === 'rawOracle' ? 'oracle' : 'dut';
            const artifact = inspection[role];
            if (artifact) await revealText(artifact.uri, model.rows[focus]?.[role]?.lineNumber ?? Number.MAX_SAFE_INTEGER);
            return;
          }
          case 'rawFirstOracle':
          case 'rawFirstDut': {
            if (!model.truncated || (savedDifference?.index ?? -1) < model.rows.length) return;
            const role = action === 'rawFirstOracle' ? 'oracle' : 'dut';
            const artifact = inspection[role];
            const event = savedDifference?.[role];
            if (artifact && event) await revealText(artifact.uri, event.lineNumber);
            return;
          }
        }
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
        render();
      }
    });
    render();
  } catch (error) {
    if (disposed) return;
    const detail = error instanceof Error ? error.message : String(error);
    panel.webview.html = renderReportPage({ title: '写回记录暂不可用', body: html.raw(`<div class="notice">${html.text(detail)}</div><p>记录可能已删除或更改。可返回用例排查页重跑，或关闭此页后重新打开。</p>`) });
  }
}

async function revealText(uri: vscode.Uri, line: number): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const row = Math.max(0, Math.min(document.lineCount - 1, line - 1));
  await vscode.window.showTextDocument(document, { viewColumn: textEditorColumn(uri), preview: true, selection: new vscode.Range(row, 0, row, 0) });
}
