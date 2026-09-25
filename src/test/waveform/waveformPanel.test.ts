import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';

const vscodeMock = vi.hoisted(() => ({
  watchers: [] as Array<{ disposed: boolean; pattern: string; listeners: Record<string, Array<(uri: URI) => void>> }>,
  clipboard: [] as string[]
}));

vi.mock('vscode', async () => {
  const { URI: Uri } = await import('vscode-uri');
  const fsPromises = await import('fs/promises');
  return {
    Uri: Object.assign(Uri, { joinPath: (base: URI, ...parts: string[]) => Uri.file(path.join(base.fsPath, ...parts)) }),
    RelativePattern: class {
      constructor(readonly base: unknown, readonly pattern: string) {}
    },
    ViewColumn: { One: 1, Beside: -2 },
    env: { clipboard: { writeText: async (text: string) => { vscodeMock.clipboard.push(text); } } },
    workspace: {
      createFileSystemWatcher: (pattern: { pattern: string }) => {
        const watcher = { disposed: false, pattern: pattern.pattern, listeners: {} as Record<string, Array<(uri: URI) => void>> };
        vscodeMock.watchers.push(watcher);
        const on = (kind: string) => (listener: (uri: URI) => void) => {
          (watcher.listeners[kind] ??= []).push(listener);
          return { dispose: () => undefined };
        };
        return {
          onDidChange: on('change'),
          onDidCreate: on('create'),
          onDidDelete: on('delete'),
          dispose: () => { watcher.disposed = true; }
        };
      },
      fs: {
        stat: async (uri: URI) => {
          const info = await fsPromises.stat(uri.fsPath);
          return { size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, type: 1 };
        },
        readFile: async (uri: URI) => fsPromises.readFile(uri.fsPath)
      }
    }
  };
});

import { WaveformEditorProvider } from '../../waveform/host/waveformEditorProvider';
import { WaveformPanel } from '../../waveform/host/waveformPanel';
import type { HostToWebviewMessage } from '../../waveform/model/protocol';

const vcd = '$timescale 1ps $end\n$scope module tb $end\n$var reg 1 ! clk $end\n$enddefinitions $end\n#0\n0!\n#5\n1!\n';

function createPanel() {
  const posted: HostToWebviewMessage[] = [];
  let receive: (message: unknown) => void = () => undefined;
  const disposeListeners: Array<() => void> = [];
  const webview = {
    options: {} as unknown,
    html: '',
    cspSource: 'vscode-webview://test',
    asWebviewUri: (uri: URI) => uri,
    postMessage: async (message: HostToWebviewMessage) => {
      posted.push(message);
      return true;
    },
    onDidReceiveMessage: (listener: (message: unknown) => void) => {
      receive = listener;
      return { dispose: () => undefined };
    }
  };
  const panel = {
    webview,
    viewColumn: 1,
    active: false,
    onDidDispose: (listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: () => undefined };
    }
  };
  const dispose = (): void => {
    for (const listener of disposeListeners) {
      listener();
    }
  };
  return { panel, webview, posted, send: (message: unknown) => receive(message), dispose };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('waveform panel host controller', () => {
  let directory: string;
  let dump: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'co panel 面板-'));
    dump = path.join(directory, 'tb.vcd');
    fs.writeFileSync(dump, vcd);
    vscodeMock.watchers.length = 0;
    vscodeMock.clipboard.length = 0;
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('serves a CSP-locked page, loads on ready and handles webview requests', async () => {
    const { panel, webview, posted, send, dispose } = createPanel();
    const saved: unknown[] = [];
    const opened: Array<[string, boolean]> = [];
    const stateStore = {
      load: () => ({ version: 1 as const, rows: [{ kind: 'signal' as const, path: 'tb.clk' }] }),
      save: async (_uri: unknown, state: unknown) => {
        saved.push(state);
      }
    };
    const controller = new WaveformPanel(URI.file(dump) as never, panel as never, {
      extensionUri: URI.file(directory) as never,
      stateStore: stateStore as never,
      openSource: async (_uri, signalPath, isScope) => {
        opened.push([signalPath, isScope]);
      }
    });
    expect(webview.options).toMatchObject({ enableScripts: true });
    expect(webview.html).toContain("script-src 'nonce-");
    expect(webview.html).toContain('waveform.js');
    expect(webview.html).not.toContain('unsafe-inline');

    send({ type: 'ready' });
    await vi.waitFor(() => expect(posted.map((message) => message.type)).toEqual(['init', 'progress', 'document', 'trace']));
    expect(posted[0]).toMatchObject({ type: 'init', fileName: 'tb.vcd', state: { rows: [{ path: 'tb.clk' }] } });
    const document = posted[2] as Extract<HostToWebviewMessage, { type: 'document' }>;
    expect(document.reload).toBe(false);
    expect(document.data.vars.map((variable) => variable.path)).toEqual(['tb.clk']);

    send({ type: 'saveState', state: { version: 1, rows: [], cursor: 5 } });
    send({ type: 'saveState', state: { version: 7 } });
    send({ type: 'openSource', path: 'tb.clk', scope: false });
    send({ type: 'openSource', path: 42 });
    send({ type: 'copyText', text: '0000abcd' });
    send('garbage');
    send({ type: 'unknown' });
    await settle();
    expect(saved).toEqual([{ version: 1, rows: [], cursor: 5 }]);
    expect(opened).toEqual([['tb.clk', false]]);
    expect(vscodeMock.clipboard).toEqual(['0000abcd']);

    // An external reload of an unchanged file is skipped; an explicit one is not.
    posted.length = 0;
    controller.reload();
    await settle();
    expect(posted).toEqual([]);
    send({ type: 'reload' });
    await vi.waitFor(() => expect(posted.map((message) => message.type)).toEqual(['progress', 'document', 'trace']));
    expect((posted[1] as Extract<HostToWebviewMessage, { type: 'document' }>).reload).toBe(true);

    posted.length = 0;
    fs.appendFileSync(dump, '#10\n0!\n');
    controller.reload();
    controller.revealTime(10);
    await vi.waitFor(() => expect(posted.map((message) => message.type)).toEqual(['revealTime', 'progress', 'document', 'trace']));

    dispose();
    expect(vscodeMock.watchers.every((watcher) => watcher.disposed)).toBe(true);
  });

  it('watches dumps whose names are glob syntax and ignores sibling files', async () => {
    const globDump = path.join(directory, 'cpu[1] {p5}.vcd');
    fs.writeFileSync(globDump, vcd);
    const { panel, posted, send } = createPanel();
    new WaveformPanel(URI.file(globDump) as never, panel as never, {
      extensionUri: URI.file(directory) as never,
      stateStore: { load: () => undefined, save: async () => undefined } as never,
      openSource: async () => undefined
    });
    send({ type: 'ready' });
    await vi.waitFor(() => expect(posted.map((message) => message.type)).toContain('trace'));
    const [watcher] = vscodeMock.watchers;
    const fire = (kind: string, file: string): void => {
      for (const listener of watcher.listeners[kind] ?? []) {
        listener(URI.file(file));
      }
    };

    posted.length = 0;
    fs.appendFileSync(globDump, '#10\n0!\n');
    fire('change', path.join(directory, 'other.vcd'));
    fire('delete', path.join(directory, 'tb.vcd'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(posted).toEqual([]);

    fire('change', globDump);
    await vi.waitFor(() => expect(posted.map((message) => message.type)).toEqual(['progress', 'document', 'trace']));
    fire('delete', globDump);
    expect(posted[posted.length - 1]).toMatchObject({ type: 'error', message: '波形文件已被删除' });
  });

  it('forwards keybinding shortcuts to the active, ready waveform editor', async () => {
    const provider = new WaveformEditorProvider({
      extensionUri: URI.file(directory) as never,
      stateStore: { load: () => undefined, save: async () => undefined } as never,
      openSource: async () => undefined
    });
    const background = createPanel();
    const active = createPanel();
    active.panel.active = true;
    for (const { panel } of [background, active]) {
      provider.resolveCustomEditor(provider.openCustomDocument(URI.file(dump) as never), panel as never);
    }

    // Not ready yet: the page could not handle it.
    provider.activePanel()?.runShortcut('goToTime');
    expect(active.posted).toEqual([]);

    active.send({ type: 'ready' });
    await vi.waitFor(() => expect(active.posted.map((message) => message.type)).toContain('trace'));
    active.posted.length = 0;
    provider.activePanel()?.runShortcut('selectAllRows');
    expect(active.posted).toEqual([{ type: 'shortcut', shortcut: 'selectAllRows' }]);
    expect(background.posted).toEqual([]);

    active.dispose();
    expect(provider.activePanel()).toBeUndefined();
    expect(provider.isOpen(URI.file(dump) as never)).toBe(true);
  });

  it('reports unreadable files as retryable errors', async () => {
    const { panel, posted, send } = createPanel();
    new WaveformPanel(URI.file(path.join(directory, 'missing.vcd')) as never, panel as never, {
      extensionUri: URI.file(directory) as never,
      stateStore: { load: () => undefined, save: async () => undefined } as never,
      openSource: async () => undefined
    });
    send({ type: 'ready' });
    await vi.waitFor(() => expect(posted.map((message) => message.type)).toEqual(['init', 'error']));
    expect(posted[1]).toMatchObject({ type: 'error', canRetry: true });
  });
});
