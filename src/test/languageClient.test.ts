import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clients: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    sendRequest: ReturnType<typeof vi.fn>;
  }> = [];
  const listeners: Array<(document: { languageId: string; uri?: { fsPath: string } }) => void> = [];
  const documents: Array<{ languageId: string; uri?: { fsPath: string } }> = [];
  const startResults: Array<Promise<void>> = [];
  return { clients, listeners, documents, startResults };
});

vi.mock('vscode', () => ({
  workspace: {
    textDocuments: mocks.documents,
    onDidOpenTextDocument: (listener: (document: { languageId: string; uri?: { fsPath: string } }) => void) => {
      mocks.listeners.push(listener);
      return { dispose: () => {
        const index = mocks.listeners.indexOf(listener);
        if (index >= 0) mocks.listeners.splice(index, 1);
      } };
    },
    createFileSystemWatcher: () => ({ dispose: vi.fn() })
  },
  languages: { match: (selector: Array<{ language?: string; pattern?: string }>,
    document: { languageId: string; uri?: { fsPath: string } }) =>
    selector.some(({ language, pattern }) => language === document.languageId ||
      (pattern === '**/*.circ' && document.uri?.fsPath.endsWith('.circ'))) ? 1 : 0 }
}));

vi.mock('vscode-languageclient/node', () => ({
  TransportKind: { ipc: 1 },
  LanguageClient: class {
    readonly start = vi.fn(() => mocks.startResults.shift() ?? Promise.resolve());
    readonly stop = vi.fn(async () => undefined);
    readonly sendRequest = vi.fn(async () => 'ok');
    constructor() { mocks.clients.push(this); }
  }
}));

import { ensureLanguageClient, executeLanguageServerCommand, startLanguageServer, stopLanguageServer } from '../languageClient';

function context() {
  return {
    asAbsolutePath: (path: string) => path,
    extensionUri: { fsPath: 'E:/extension' },
    subscriptions: [] as Array<{ dispose(): void }>
  } as never;
}

afterEach(async () => {
  await stopLanguageServer();
  mocks.clients.length = 0;
  mocks.listeners.length = 0;
  mocks.documents.length = 0;
  mocks.startResults.length = 0;
});

describe('lazy language client', () => {
  it('starts once on a matching document and reuses concurrent requests', async () => {
    startLanguageServer(context());
    expect(mocks.clients).toHaveLength(0);
    mocks.listeners[0]({ languageId: 'plaintext', uri: { fsPath: 'readme.txt' } });
    expect(mocks.clients).toHaveLength(0);
    mocks.listeners[0]({ languageId: 'verilog' });
    await Promise.all([ensureLanguageClient(), ensureLanguageClient()]);
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.clients[0].start).toHaveBeenCalledTimes(1);
    expect(mocks.listeners).toHaveLength(0);
  });

  it('starts for an open Logisim circuit selected by its file extension', async () => {
    mocks.documents.push({ languageId: 'xml', uri: { fsPath: 'cpu.circ' } });
    startLanguageServer(context());
    await ensureLanguageClient();
    expect(mocks.clients).toHaveLength(1);
  });

  it('retries after a failed startup through a command', async () => {
    startLanguageServer(context());
    mocks.startResults.push(Promise.reject(new Error('startup failed')));
    const first = ensureLanguageClient();
    await expect(first).rejects.toThrow('startup failed');
    expect(await executeLanguageServerCommand('co.test')).toBe('ok');
    expect(mocks.clients).toHaveLength(2);
  });

  it('stops a client whose startup is still pending and removes its open listener', async () => {
    let resolveStart!: () => void;
    startLanguageServer(context());
    mocks.startResults.push(new Promise<void>((resolve) => { resolveStart = resolve; }));
    const started = ensureLanguageClient();
    const stopped = stopLanguageServer();
    resolveStart();
    await Promise.all([started, stopped]);
    expect(mocks.clients[0].stop).toHaveBeenCalledTimes(1);
    expect(mocks.listeners).toHaveLength(0);
    await expect(ensureLanguageClient()).rejects.toThrow('before extension activation');
  });
});
