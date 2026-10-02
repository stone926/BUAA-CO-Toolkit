// @index course-testing — 测试历史页宿主 glue 与按需文件监视刷新
import * as vscode from 'vscode';
import {
  asmCaseIndexDirectory,
  listAsmCaseManifestsInDirectory
} from './asmCaseStore';
import type { AsmCaseManifestEntry } from './courseTestReport';
import { renderAsmCaseIndex } from './courseTestReport';
import { acceptsInspectionMessage } from './courseTesting/failureDiagnosis';

const historyRefreshDebounceMs = 500;

export interface AsmCaseHistoryPanel {
  readonly webview: { html: string };
  onDidDispose(listener: () => void): vscode.Disposable;
  onDidChangeViewState(listener: (event: { webviewPanel: { active: boolean } }) => void): vscode.Disposable;
}

export interface AsmCaseHistoryLiveDependencies {
  readonly watch: (casesDirectory: string) => vscode.FileSystemWatcher;
  readonly list: (casesDirectory: string) => Promise<AsmCaseManifestEntry[]>;
  readonly render: (entries: AsmCaseManifestEntry[]) => string;
  readonly showError: (message: string) => void;
  readonly debounceMs?: number;
}

const defaultLiveDependencies: AsmCaseHistoryLiveDependencies = {
  watch: (casesDirectory) => vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(casesDirectory), '*/case.json')
  ),
  list: listAsmCaseManifestsInDirectory,
  render: renderAsmCaseIndex,
  showError: (message) => { void vscode.window.showWarningMessage(message); }
};

/** Open history and keep it current only while this panel remains open. */
export function openAsmCaseIndex(resource?: vscode.Uri, inspect?: (casesDirectory: string, caseId: string) => Promise<void>): void {
  const indexResource = resource ?? vscode.window.activeTextEditor?.document.uri;
  const casesDirectory = asmCaseIndexDirectory(indexResource);
  const panel = vscode.window.createWebviewPanel(
    'coAsmCaseIndex',
    '测试历史 / 失败用例',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      enableFindWidget: true,
      localResourceRoots: []
    }
  );
  let visibleCases = new Set<string>();
  let opening = false;
  const listener = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!inspect || opening || !acceptsInspectionMessage(message) || !visibleCases.has(message.caseId)) return;
    opening = true;
    try { await inspect(casesDirectory, message.caseId); }
    catch (error) { void vscode.window.showErrorMessage(`无法打开用例：${error instanceof Error ? error.message : String(error)}`); }
    finally { opening = false; }
  });
  panel.onDidDispose(() => listener.dispose());
  attachAsmCaseIndexLiveRefresh(panel, casesDirectory, {
    ...defaultLiveDependencies,
    render: (entries) => {
      visibleCases = new Set(entries.map(entry => entry.manifest.caseId));
      return renderAsmCaseIndex(entries);
    }
  });
}

/** Small seam for testing the watcher lifecycle without constructing a VS Code panel. */
export function attachAsmCaseIndexLiveRefresh(
  panel: AsmCaseHistoryPanel,
  casesDirectory: string,
  dependencies: AsmCaseHistoryLiveDependencies = defaultLiveDependencies
): vscode.Disposable {
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshPromise: Promise<void> | undefined;
  let refreshRequested = false;
  let lastReportedError: string | undefined;
  const disposables: vscode.Disposable[] = [];

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    refreshRequested = true;
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      while (refreshRequested && !disposed) {
        refreshRequested = false;
        try {
          const entries = await dependencies.list(casesDirectory);
          if (disposed) return;
          // Publish each completed read. Continuous writes must not starve the page;
          // the queued request will refresh it again without overlapping reads.
          panel.webview.html = dependencies.render(entries);
          lastReportedError = undefined;
        } catch (error) {
          if (disposed) return;
          const detail = error instanceof Error ? error.message : String(error);
          const message = `刷新测试历史失败：${detail}`;
          if (message !== lastReportedError) {
            lastReportedError = message;
            dependencies.showError(message);
          }
        }
      }
    })().finally(() => {
      refreshPromise = undefined;
      // A request can arrive as the previous refresh is settling.
      if (refreshRequested && !disposed) void refresh();
    });
    return refreshPromise;
  };

  const scheduleRefresh = (): void => {
    if (disposed || debounceTimer !== undefined) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void refresh();
    }, dependencies.debounceMs ?? historyRefreshDebounceMs);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    refreshRequested = false;
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    for (const item of disposables.splice(0)) item.dispose();
  };

  // Keep a usable initial page if the first read fails, then install the watcher
  // before starting that read so no case change can fall into an initialization gap.
  try {
    panel.webview.html = dependencies.render([]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dependencies.showError(`打开测试历史失败：${detail}`);
  }

  try {
    const watcher = dependencies.watch(casesDirectory);
    const schedule = (): void => scheduleRefresh();
    disposables.push(
      watcher,
      watcher.onDidCreate(schedule),
      watcher.onDidChange(schedule),
      watcher.onDidDelete(schedule)
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dependencies.showError(`无法监视测试历史更新：${detail}`);
  }

  disposables.push(
    panel.onDidDispose(dispose),
    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) void refresh();
    })
  );

  void refresh();
  return { dispose };
}
