// @index hazard-workflow — 内置冲突分析的可取消编排、工作区会话互斥与报告打开
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureConcreteProfile } from '../config';
import { workspaceFolderForOrFirst } from '../fsUtil';
import { normalizePathKey } from '../pathUtils';
import type { AppServices } from '../types';
import { analyzeHazardProgram } from '../hazardAnalysis/analyzer';
import { isHazardInput, prepareHazardInput, selectHazardInput } from './input';
import { readHazardReport, recentHazardReports, saveHazardReport, SavedHazardReport } from './reportStore';
import { showHazardPanel } from './panel';

export class HazardWorkflow implements vscode.Disposable {
  private readonly runs = new Map<string, AbortController>();
  private readonly panels = new Set<vscode.WebviewPanel>();
  private disposed = false;
  constructor(private readonly services: AppServices) {}

  async analyze(resource?: vscode.Uri): Promise<void> {
    if (this.disposed) return;
    try {
      const active = resource ?? vscode.window.activeTextEditor?.document.uri;
      const source = resource && isHazardInput(resource) ? resource : await selectHazardInput(workspaceFolderForOrFirst(active));
      if (!source || this.disposed) return;
      if (!isHazardInput(source)) throw new Error('请选择本地 ASM、TXT、HEX 或 COE 文件');
      const folder = workspaceFolderForOrFirst(source);
      if (!folder) throw new Error('请先打开一个工作区文件夹，用于保存冲突分析报告');
      const profile = await ensureConcreteProfile(source, '冲突分析需要 P5、P6 或 P7 项目 Profile');
      if (!profile || this.disposed) return;
      if (profile !== 'P5' && profile !== 'P6' && profile !== 'P7') throw new Error('流水线冲突分析适用于 P5–P7，请先切换项目 Profile');
      const key = normalizePathKey(folder.uri.fsPath);
      if (this.runs.has(key)) {
        void vscode.window.showInformationMessage('此工作区正在分析冲突，可在进度通知中取消');
        return;
      }
      const controller = new AbortController();
      this.runs.set(key, controller);
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `流水线冲突分析 · ${path.basename(source.fsPath)}`, cancellable: true }, async (progress, token) => {
          const cancellation = token.onCancellationRequested(() => controller.abort());
          if (token.isCancellationRequested) controller.abort();
          try {
            progress.report({ message: '读取程序 / 内置汇编' });
            const image = await prepareHazardInput(this.services, source, folder, profile, controller.signal);
            if (!image || controller.signal.aborted) return;
            progress.report({ message: '分析动态指令流与转发、阻塞' });
            const report = await analyzeHazardProgram(image, {
              profile, signal: controller.signal, maxEvents: 500,
              yieldControl: () => new Promise((resolve) => setImmediate(resolve))
            });
            if (controller.signal.aborted || this.disposed || report.stopReason === 'cancelled') return;
            const saved: SavedHazardReport = {
              format: 'buaa-co-hazard', version: 1, sourceUri: source.toString(),
              sourceLabel: vscode.workspace.asRelativePath(source, true), createdAt: new Date().toISOString(), report
            };
            const reportFile = await saveHazardReport(folder, saved);
            if (controller.signal.aborted || this.disposed) return;
            this.services.output.appendLine(`内置冲突分析：${saved.sourceLabel} · ${report.summary.instructions} 条动态指令 · ${report.stopReason}`);
            this.services.output.appendLine(`报告：${reportFile.fsPath}`);
            this.showReport(saved, reportFile);
          } finally { cancellation.dispose(); }
        });
      } finally { this.runs.delete(key); }
    } catch (error) { this.showError(error); }
  }

  async openReport(resource?: vscode.Uri): Promise<void> {
    if (this.disposed) return;
    try {
      let uri = resource;
      if (!uri) {
        const folder = workspaceFolderForOrFirst(vscode.window.activeTextEditor?.document.uri);
        const recent = folder ? await recentHazardReports(folder) : [];
        if (recent.length) {
          const selected = await vscode.window.showQuickPick([
            ...recent.map((file, index) => ({ label: path.basename(file.fsPath), description: index === 0 ? '最近生成' : '', uri: file })),
            { label: '$(folder-opened) 浏览其他报告…', description: '', uri: undefined }
          ], { title: '打开冲突分析报告' });
          if (!selected) return;
          uri = selected.uri;
        }
        if (!uri) uri = (await vscode.window.showOpenDialog({ title: '打开内置冲突分析报告', canSelectMany: false, canSelectFolders: false, filters: { '冲突报告 JSON': ['json'] } }))?.[0];
      }
      if (!uri || this.disposed) return;
      if (uri.scheme !== 'file') throw new Error('请选择本地冲突报告 JSON');
      const saved = await readHazardReport(uri);
      if (!this.disposed) this.showReport(saved, uri);
    } catch (error) { this.showError(error); }
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.runs.values()) controller.abort();
    for (const panel of this.panels) panel.dispose();
    this.panels.clear();
  }

  private showReport(saved: SavedHazardReport, file: vscode.Uri): void {
    const panel = showHazardPanel(saved, file, (source) => this.analyze(source));
    this.panels.add(panel);
    panel.onDidDispose(() => this.panels.delete(panel));
  }

  private showError(error: unknown): void {
    if (this.disposed) return;
    const detail = error instanceof Error ? error.message : String(error);
    this.services.output.appendLine(`冲突分析：${detail}`);
    void vscode.window.showErrorMessage(`冲突分析：${detail.slice(0, 1200)}`);
  }
}
