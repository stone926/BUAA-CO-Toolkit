// @index orchestration — Lazy custom instruction metadata publication to the language server
import * as vscode from 'vscode';
import type { CustomInstructionFactsUpdate } from './language/mips/customInstructionFacts';
import { inspectCustomMarsInstructions } from './mips/host/customMarsBridge';
import { captureScriptInstructions, inspectScriptInstructions } from './mips/host/scriptInstructions';

interface WorkspaceInspection {
  folder: vscode.WorkspaceFolder;
  watcher: vscode.FileSystemWatcher;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
}

/** Only open MIPS workspaces activate discovery; file events are coalesced per root. */
export function startCustomInstructionLanguage(context: vscode.ExtensionContext,
  send: (method: string, payload: unknown) => Promise<void>): void {
  const roots = new Map<string, WorkspaceInspection>();
  const diagnostics = vscode.languages.createDiagnosticCollection('co-custom-instructions');

  const publish = (payload: CustomInstructionFactsUpdate) => send('co/customInstructions', payload).catch(() => undefined);
  const update = (state: WorkspaceInspection): void => {
    if (state.timer) clearTimeout(state.timer);
    state.controller?.abort();
    const { folder } = state;
    const controller = state.controller = new AbortController();
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const { signal } = controller;
      void Promise.allSettled([
        inspectWorkspaceScripts(folder, signal),
        inspectCustomMarsInstructions(folder.uri, signal)
      ]).then(([scripts, classes]) => {
        if (signal.aborted) return;
        const errors = [scripts, classes].flatMap(result => result.status === 'rejected' ? [new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1), `自定义指令加载失败：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          vscode.DiagnosticSeverity.Error
        )] : []);
        diagnostics.set(vscode.Uri.joinPath(folder.uri, '.co/custom-instructions'), errors);
        return publish({ rootUri: folder.uri.toString(), instructions: scripts.status === 'fulfilled' ? scripts.value : [],
          marsInstructions: classes.status === 'fulfilled' ? classes.value : [] });
      });
    }, 250);
  };
  const opened = (document: vscode.TextDocument): void => {
    if (document.languageId !== 'mipsasm' || document.uri.scheme !== 'file') return;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || roots.has(folder.uri.toString())) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.co/custom-instructions/**/*.{js,ts,class,CLASS}'));
    const state = { folder, watcher };
    roots.set(folder.uri.toString(), state);
    watcher.onDidCreate(() => update(state));
    watcher.onDidChange(() => update(state));
    watcher.onDidDelete(() => update(state));
    update(state);
  };
  const stop = (state: WorkspaceInspection): void => {
    clearTimeout(state.timer);
    state.controller?.abort();
    state.watcher.dispose();
  };
  context.subscriptions.push(diagnostics, vscode.workspace.onDidOpenTextDocument(opened),
    vscode.workspace.onDidChangeConfiguration(event => {
      for (const state of roots.values()) {
        if (event.affectsConfiguration('co.toolchain.mars', state.folder.uri) || event.affectsConfiguration('co.toolchain.java', state.folder.uri)) update(state);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(event => {
      for (const folder of event.removed) {
        const rootUri = folder.uri.toString();
        const state = roots.get(rootUri);
        if (!state) continue;
        stop(state);
        roots.delete(rootUri);
        diagnostics.delete(vscode.Uri.joinPath(folder.uri, '.co/custom-instructions'));
        void publish({ rootUri, removed: true });
      }
      vscode.workspace.textDocuments.forEach(opened);
    }),
    { dispose() { for (const state of roots.values()) stop(state); roots.clear(); } });
  vscode.workspace.textDocuments.forEach(opened);
}

async function inspectWorkspaceScripts(folder: vscode.WorkspaceFolder, signal: AbortSignal) {
  const bundle = await captureScriptInstructions(folder.uri.fsPath, { signal });
  return bundle ? inspectScriptInstructions(bundle, undefined, undefined, { signal }) : [];
}
