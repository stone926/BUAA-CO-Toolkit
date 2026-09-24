import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';

const vscodeMock = vi.hoisted(() => ({
  watchers: [] as Array<{ disposed: boolean; listeners: Record<string, Array<() => void>> }>,
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
      createFileSystemWatcher: () => {
        const watcher = { disposed: false, listeners: {} as Record<string, Array<() => void>> };
        vscodeMock.watchers.push(watcher);
        const on = (kind: string) => (listener: () => void) => {
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

import { WaveformPanel } from '../../waveform/host/waveformPanel';
import type { HostToWebviewMessage } from '../../waveform/model/protocol';

const vcd = '$timescale 1ps $end\n$scope module tb $end\n$var reg 1 ! clk $end\n$enddefinitions $end\n#0\n0!\n#5\n1!\n';

function createPanel() {
  const posted: HostToWebviewMessage[] = [];
  let receive: (message: unknown) => void = () => undefined;
  let disposePanel: () => void = () => undefined;
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
    onDidDispose: (listener: () => void) => {
      disposePanel = listener;
      return { dispose: () => undefined };
    }
  };
  return { panel, webview, posted, send: (message: unknown) => receive(message), dispose: () => disposePanel() };
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
