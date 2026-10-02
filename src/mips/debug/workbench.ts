// @index mips-debug — VS Code panel lifecycle and commands for the internal MARS debugger
import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { textEditorColumn } from '../../editorNavigation';
import type { AppServices } from '../../types';
import { getProfile, getMemoryConfiguration, useDelayedBranching } from '../../config';
import { Commands } from '../../constants';
import { isCourseProfile } from '../core/profiles/profileIds';
import { isMarsMemoryConfiguration } from '../core/profiles/marsMemoryLayout';
import type { DebugMode } from '../core/debug/api';
import { imageSegmentWords, wordsToHexText } from '../core/assembler/artifacts';
import { writeFileAtomicReplace } from '../replay/atomicFile';
import { buildMarsWorkbenchHtml } from './html';
import { parseWorkbenchRequest } from './messages';
import { captureWorkbenchSource, showAssemblyDiagnostics, workbenchSourcesCurrent } from './source';
import { readBoundedRegularFile } from '../replay/boundedFile';
import type { WorkbenchState } from './protocol';

export function registerMarsWorkbench(context: vscode.ExtensionContext, services: AppServices): void {
  const panels = new Map<string, vscode.WebviewPanel>();
  context.subscriptions.push(vscode.commands.registerCommand(Commands.Mips.OpenWorkbench, async (resource?: vscode.Uri) => {
    const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') { void vscode.window.showInformationMessage('先打开并保存一个 ASM 文件，再打开 MARS 工作台。'); return; }
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.languageId !== 'mipsasm') { void vscode.window.showInformationMessage('MARS 工作台需要 MIPS 汇编文件。'); return; }
    const key = uri.toString();
    const existing = panels.get(key);
    if (existing) { existing.reveal(); return; }
    if (!services.mipsRuntime) throw new Error('Internal MARS runtime is unavailable');
    const { MarsWorkbenchController } = await import('./controller');
    const openedWhileLoading = panels.get(key);
    if (openedWhileLoading) { openedWhileLoading.reveal(); return; }
    const assets = vscode.Uri.joinPath(context.extensionUri, 'out', 'media');
    const panel = vscode.window.createWebviewPanel('co.mars.workbench', `MARS · ${path.basename(uri.fsPath)}`,
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assets] });
    panels.set(key, panel);
    const diagnostics = vscode.languages.createDiagnosticCollection('co.mars.assembly');
    const memory = getMemoryConfiguration(uri);
    const ordinaryMode: Extract<DebugMode, { kind: 'mars' }> = { kind: 'mars',
      memoryConfiguration: isMarsMemoryConfiguration(memory) ? memory : 'Default', delayedBranching: useDelayedBranching(uri) };
    const profile = getProfile(uri);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    let nextState: WorkbenchState | undefined;
    const controller = new MarsWorkbenchController({
      sourcePath: uri.fsPath, mode: isCourseProfile(profile) ? { kind: 'course', profile } : ordinaryMode,
      ordinaryMode, runtime: services.mipsRuntime,
      capture: () => captureWorkbenchSource(uri, folder?.uri.fsPath ?? path.dirname(uri.fsPath)),
      sourcesCurrent: workbenchSourcesCurrent,
      changed: state => {
        nextState = state;
        if (!updateTimer) updateTimer = setTimeout(() => {
          updateTimer = undefined;
          if (!disposed && nextState) void panel.webview.postMessage({ type: 'state', state: nextState });
        }, 40);
      },
      diagnostics: (items, sources) => showAssemblyDiagnostics(diagnostics, items, sources)
    });
    let disposed = false;
    let exportBusy = false;
    const resources: vscode.Disposable[] = [diagnostics];
    const affectsSource = (candidate: vscode.Uri) => candidate.toString() === uri.toString()
      || controller.sources.some(source => source.uri && vscode.Uri.parse(source.uri).toString() === candidate.toString());
    const capturedSource = (candidate: vscode.Uri) => controller.sources.find(source => source.uri && vscode.Uri.parse(source.uri).toString() === candidate.toString());
    resources.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length && affectsSource(event.document.uri) && capturedSource(event.document.uri)?.text.replace(/^\uFEFF/, '') !== event.document.getText()) controller.markSourceChanged();
    }));
    // Includes may use arbitrary extensions; filter notifications against the captured closure.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder?.uri ?? vscode.Uri.file(path.dirname(uri.fsPath)), '**/*'));
    resources.push(watcher, watcher.onDidChange(changed => {
      const source = capturedSource(changed);
      if (!source) return;
      void readBoundedRegularFile(changed.fsPath, { maximumBytes: 8 * 1024 * 1024, label: 'MARS source update' }).then(bytes => {
        if (!disposed && capturedSource(changed) === source && bytes.toString('utf8') !== source.text) controller.markSourceChanged();
      }, () => { if (!disposed && capturedSource(changed) === source) controller.markSourceChanged(); });
    }),
      watcher.onDidDelete(changed => { if (affectsSource(changed)) controller.markSourceChanged(); }));
    resources.push(panel.webview.onDidReceiveMessage((raw: unknown) => {
      const request = parseWorkbenchRequest(raw);
      if (!request || disposed) return;
      void (async () => {
        if (request.type === 'source') {
          const location = controller.sourceAtAddress(request.address);
          if (!location?.source.uri) return;
          const target = vscode.Uri.parse(location.source.uri);
          if (target.scheme !== 'file') return;
          const source = await vscode.workspace.openTextDocument(target);
          const line = Math.min(source.lineCount - 1, Math.max(0, location.line - 1));
          await vscode.window.showTextDocument(source, { viewColumn: textEditorColumn(target), selection: new vscode.Range(line, 0, line, 0) });
        } else if (request.type === 'export') {
          if (exportBusy || !controller.image) return;
          exportBusy = true;
          try {
            const image = controller.image;
            const segments = image.segments.filter(segment => ['text', 'ktext', 'data', 'kdata'].includes(segment.name));
            const segment = await vscode.window.showQuickPick(segments.map(segment => ({ label: segment.name,
              description: `0x${segment.baseAddress.toString(16).padStart(8, '0')} · ${segment.words.length} words` })), { title: '导出已汇编的段（每行一个小端存储的 32 位字）' });
            if (!segment) return;
            const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(uri.fsPath), `${path.parse(uri.fsPath).name}.${segment.label}.hex`)), filters: { HexText: ['hex', 'txt'] } });
            if (target?.scheme === 'file') await writeFileAtomicReplace(target.fsPath, Buffer.from(wordsToHexText(imageSegmentWords(image, segment.label)), 'utf8'));
          } finally { exportBusy = false; }
        } else await controller.handle(request);
      })().catch(error => { services.output.appendLine(`[MARS 工作台] ${String(error)}`); if (!disposed) void vscode.window.showErrorMessage(`MARS 工作台：${error instanceof Error ? error.message : String(error)}`); });
    }));
    panel.onDidDispose(() => { disposed = true; if (updateTimer) clearTimeout(updateTimer); controller.dispose(); panels.delete(key); resources.forEach(item => item.dispose()); });
    panel.webview.html = buildMarsWorkbenchHtml({
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'mars-workbench.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'mars-workbench.css')).toString(),
      cspSource: panel.webview.cspSource, nonce: randomBytes(18).toString('hex')
    });
  }));
  context.subscriptions.push({ dispose: () => { for (const panel of panels.values()) panel.dispose(); panels.clear(); } });
}
