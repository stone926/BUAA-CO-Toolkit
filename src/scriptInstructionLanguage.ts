// @index orchestration — Lazy custom instruction metadata publication to the language server
import * as vscode from 'vscode';
import { captureScriptInstructions, inspectScriptInstructions } from './mips/host/scriptInstructions';

/** Only open MIPS workspaces activate discovery; file events are coalesced per root. */
export function startScriptInstructionLanguage(context: vscode.ExtensionContext,
  send: (method: string, payload: unknown) => Promise<void>): void {
  const roots = new Map<string, { folder: vscode.WorkspaceFolder; revision: number; timer?: ReturnType<typeof setTimeout>; controller?: AbortController }>();
  const diagnostics = vscode.languages.createDiagnosticCollection('co-custom-instructions');
  let disposed = false;
  const update = (folder: vscode.WorkspaceFolder): void => {
    const key = folder.uri.toString();
    let state = roots.get(key);
    if (!state) {
      state = { folder, revision: 0 }; roots.set(key, state);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.co/custom-instructions/**/*.{js,ts}'));
      context.subscriptions.push(watcher, watcher.onDidCreate(() => update(folder)), watcher.onDidChange(() => update(folder)), watcher.onDidDelete(() => update(folder)));
    }
    if (state.timer) clearTimeout(state.timer);
    state.controller?.abort();
    const current = state, revision = ++state.revision;
    state.timer = setTimeout(() => {
      current.timer = undefined;
      const controller = current.controller = new AbortController();
      void (async () => {
        try {
          const bundle = await captureScriptInstructions(folder.uri.fsPath, { signal: controller.signal });
          const instructions = bundle ? await inspectScriptInstructions(bundle, undefined, undefined, { signal: controller.signal }) : [];
          if (disposed || current.revision !== revision) return;
          diagnostics.delete(vscode.Uri.joinPath(folder.uri, '.co/custom-instructions'));
          await send('co/customInstructions', { rootUri: key, instructions });
        } catch (error) {
          if (disposed || current.revision !== revision || controller.signal.aborted) return;
          await send('co/customInstructions', { rootUri: key, instructions: [] });
          diagnostics.set(vscode.Uri.joinPath(folder.uri, '.co/custom-instructions'), [new vscode.Diagnostic(
            new vscode.Range(0, 0, 0, 1), `自定义指令加载失败：${error instanceof Error ? error.message : String(error)}`, vscode.DiagnosticSeverity.Error
          )]);
        }
      })();
    }, 250);
  };
  const opened = (document: vscode.TextDocument): void => {
    if (document.languageId !== 'mipsasm') return;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder && !roots.has(folder.uri.toString())) update(folder);
  };
  context.subscriptions.push(diagnostics, vscode.workspace.onDidOpenTextDocument(opened), {
    dispose() { disposed = true; for (const state of roots.values()) { if (state.timer) clearTimeout(state.timer); state.controller?.abort(); } roots.clear(); }
  });
  vscode.workspace.textDocuments.forEach(opened);
}
