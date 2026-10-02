import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';

const state = vi.hoisted(() => ({
  command: undefined as ((uri?: unknown) => Promise<void>) | undefined,
  listener: undefined as ((message: unknown) => void) | undefined,
  groups: [] as Array<{ isActive?: boolean; viewColumn: number; tabs: Array<{ input: unknown }> }>,
  showTextDocument: vi.fn(async (..._args: unknown[]) => undefined),
  openTextDocument: vi.fn(async (uri: unknown) => ({ uri, languageId: 'mipsasm', lineCount: 40 })),
  panel: undefined as { webview: { html: string; onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void }; postMessage(): Promise<boolean> }; onDidDispose(listener: () => void): { dispose(): void } } | undefined
}));

vi.mock('vscode', async () => {
  const { URI: Uri, Utils } = await import('vscode-uri');
  Object.assign(Uri, { joinPath: Utils.joinPath });
  class TabInputText { constructor(readonly uri: { fsPath: string }) {} }
  return {
    Uri,
    TabInputText,
    ViewColumn: { Active: -1, Beside: -2 },
    Range: class Range { constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {} },
    RelativePattern: class RelativePattern { constructor(readonly base: unknown, readonly pattern: string) {} },
    window: {
      get activeTextEditor() { return undefined; },
      tabGroups: { get all() { return state.groups; } },
      showTextDocument: state.showTextDocument,
      showInformationMessage: vi.fn(), showErrorMessage: vi.fn(),
      createWebviewPanel: vi.fn(() => {
        const panel = {
          webview: {
            html: '',
            cspSource: 'vscode-webview://fixture',
            asWebviewUri(uri: unknown) { return uri; },
            onDidReceiveMessage(listener: (message: unknown) => void) { state.listener = listener; return { dispose: vi.fn() }; },
            postMessage: vi.fn(async () => true)
          },
          onDidDispose: vi.fn(() => ({ dispose: vi.fn() }))
        };
        state.panel = panel;
        return panel;
      }),
      showQuickPick: vi.fn(), showSaveDialog: vi.fn()
    },
    workspace: {
      openTextDocument: state.openTextDocument,
      getWorkspaceFolder: () => ({ uri: Uri.file('E:/work') }),
      onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
      createFileSystemWatcher: vi.fn(() => ({
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDelete: vi.fn(() => ({ dispose: vi.fn() })), dispose: vi.fn()
      }))
    },
    languages: { createDiagnosticCollection: vi.fn(() => ({ set: vi.fn(), clear: vi.fn(), dispose: vi.fn() })) },
    commands: { registerCommand: vi.fn((_command: string, callback: (uri?: unknown) => Promise<void>) => { state.command = callback; return { dispose: vi.fn() }; }) }
  };
});

vi.mock('../../mips/debug/controller', () => ({
  MarsWorkbenchController: class {
    sources = [];
    image = undefined;
    constructor() {}
    sourceAtAddress() { return { source: { uri: URI.file('E:/work/include.asm').toString() }, line: 12 }; }
    handle() { return Promise.resolve(); }
    dispose() {}
  }
}));
vi.mock('../../config', () => ({ getProfile: () => 'P5', getMemoryConfiguration: () => 'Default', useDelayedBranching: () => false }));
vi.mock('../../mips/core/profiles/profileIds', () => ({ isCourseProfile: () => false }));
vi.mock('../../mips/core/profiles/marsMemoryLayout', () => ({ isMarsMemoryConfiguration: () => true }));
vi.mock('../../mips/core/assembler/artifacts', () => ({ imageSegmentWords: vi.fn(), wordsToHexText: vi.fn() }));
vi.mock('../../mips/replay/atomicFile', () => ({ writeFileAtomicReplace: vi.fn() }));
vi.mock('../../mips/debug/html', () => ({ buildMarsWorkbenchHtml: () => '<workbench />' }));
vi.mock('../../mips/debug/messages', () => ({ parseWorkbenchRequest: (message: unknown) => message }));
vi.mock('../../mips/debug/source', () => ({ captureWorkbenchSource: vi.fn(), showAssemblyDiagnostics: vi.fn(), workbenchSourcesCurrent: vi.fn() }));
vi.mock('../../mips/replay/boundedFile', () => ({ readBoundedRegularFile: vi.fn(async () => Buffer.from('')) }));

import * as vscode from 'vscode';
import { Commands } from '../../constants';
import { registerMarsWorkbench } from '../../mips/debug/workbench';

describe('MARS workbench source navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.command = undefined;
    state.listener = undefined;
    state.panel = undefined;
    state.groups = [];
  });

  it('reveals include source in its existing editor group without creating another split', async () => {
    const source = URI.file('E:/work/include.asm');
    state.groups = [{ isActive: true, viewColumn: 5, tabs: [{ input: new vscode.TabInputText(source) }] }];
    registerMarsWorkbench({ extensionUri: URI.file('E:/extension'), subscriptions: { push: vi.fn() } } as never,
      { mipsRuntime: {} as never, output: { appendLine: vi.fn() } } as never);
    await state.command?.(URI.file('E:/work/main.asm'));
    state.listener?.({ type: 'source', address: 0x3000 });
    await vi.waitFor(() => expect(state.openTextDocument).toHaveBeenCalledTimes(2));
    expect(state.openTextDocument.mock.calls.at(-1)?.[0]).toMatchObject({ fsPath: source.fsPath.toLowerCase() });
    await vi.waitFor(() => expect(state.showTextDocument).toHaveBeenCalled());
    expect(state.showTextDocument).toHaveBeenCalledWith(expect.objectContaining({
      uri: expect.objectContaining({ fsPath: source.fsPath.toLowerCase() })
    }), expect.objectContaining({ viewColumn: 5, selection: expect.objectContaining({ startLine: 11 }) }));
  });
});
