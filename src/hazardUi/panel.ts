// @index hazard-panel — Webview 生命周期与固定白名单操作；文件 URI 始终由宿主持有
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { textEditorColumn } from '../editorNavigation';
import { renderHazardReport } from './reportView';
import type { SavedHazardReport } from './reportStore';

export function showHazardPanel(saved: SavedHazardReport, reportFile: vscode.Uri, reanalyze: (source: vscode.Uri) => Promise<void>): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('coHazardReport', 'CO · 流水线冲突分析', vscode.ViewColumn.Active, {
    enableScripts: true, localResourceRoots: []
  });
  panel.webview.html = renderHazardReport(saved.report, { inputLabel: saved.sourceLabel, generatedAt: saved.createdAt }, randomBytes(18).toString('base64'));
  const source = vscode.Uri.parse(saved.sourceUri, true);
  let busy = false;
  const listener = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!message || typeof message !== 'object' || busy) return;
    const action = (message as { action?: unknown }).action;
    if (action !== 'reanalyze' && action !== 'openInput' && action !== 'openJson') return;
    busy = true;
    try {
      if (action === 'reanalyze') await reanalyze(source);
      else {
        const uri = action === 'openInput' ? source : reportFile;
        await vscode.window.showTextDocument(uri, { viewColumn: textEditorColumn(uri), preview: false });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`无法打开冲突分析文件：${error instanceof Error ? error.message : String(error)}`);
    } finally { busy = false; }
  });
  panel.onDidDispose(() => listener.dispose());
  return panel;
}
