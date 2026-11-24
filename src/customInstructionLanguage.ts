// @index orchestration — Lazy custom instruction metadata publication to the language server
import * as vscode from 'vscode';
import type { CustomInstructionFactsUpdate } from './language/mips/customInstructionFacts';
import { customInstructionsForResource } from './mips/host/customInstructionResource';
import { customInstructionRelativeDirectory, customInstructionWatchPattern } from './mips/host/customInstructionFiles';
import type { WorkspaceCustomInstructions } from './mips/host/customInstructionService';

interface WorkspaceInspection {
  root: vscode.Uri;
  resource: vscode.Uri;
  workspace: WorkspaceCustomInstructions;
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
    const { root, workspace } = state;
    const controller = state.controller = new AbortController();
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const { signal } = controller;
      const diagnosticUri = vscode.Uri.joinPath(root, customInstructionRelativeDirectory);
      void workspace.inspect(signal).then(facts => {
        if (signal.aborted) return;
        diagnostics.delete(diagnosticUri);
        return publish({ rootUri: root.toString(), ...facts });
      }, error => {
        if (signal.aborted) return;
        diagnostics.set(diagnosticUri, [new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1), `自定义指令加载失败：${error instanceof Error ? error.message : String(error)}`,
          vscode.DiagnosticSeverity.Error
        )]);
        return publish({ rootUri: root.toString(), instructions: [], marsInstructions: [] });
      });
    }, 250);
  };
  const opened = (document: vscode.TextDocument): void => {
    if (document.languageId !== 'mipsasm' || document.uri.scheme !== 'file') return;
    const workspace = customInstructionsForResource(document.uri);
    const root = vscode.Uri.file(workspace.root);
    if (roots.has(root.toString())) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, customInstructionWatchPattern));
    const state = { root, resource: document.uri, workspace, watcher };
    roots.set(root.toString(), state);
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
  const remove = (state: WorkspaceInspection): void => {
    stop(state);
    const rootUri = state.root.toString();
    roots.delete(rootUri);
    diagnostics.delete(vscode.Uri.joinPath(state.root, customInstructionRelativeDirectory));
    void publish({ rootUri, removed: true });
  };
  context.subscriptions.push(diagnostics, vscode.workspace.onDidOpenTextDocument(opened),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.languageId !== 'mipsasm' || document.uri.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(document.uri)) return;
      const root = customInstructionsForResource(document.uri).root;
      const state = roots.get(vscode.Uri.file(root).toString());
      if (state && !vscode.workspace.textDocuments.some(other => other !== document
        && other.languageId === 'mipsasm' && other.uri.scheme === 'file' && customInstructionsForResource(other.uri).root === root)) remove(state);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      for (const state of roots.values()) {
        if (event.affectsConfiguration('co.toolchain.mars', state.resource) || event.affectsConfiguration('co.toolchain.java', state.resource)) update(state);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      for (const state of roots.values()) {
        if (customInstructionsForResource(state.resource).root !== state.workspace.root) remove(state);
      }
      vscode.workspace.textDocuments.forEach(opened);
    }),
    { dispose() { for (const state of roots.values()) stop(state); roots.clear(); } });
  vscode.workspace.textDocuments.forEach(opened);
}
