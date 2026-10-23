import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExecuteCommandRequest,
  InitializeRequest,
  PublishDiagnosticsNotification,
  type Connection,
  type Diagnostic,
  type ProtocolConnection,
  type PublishDiagnosticsParams
} from 'vscode-languageserver/node';
import { Commands } from '../constants';
import type { ExternalVerilogSyntaxCheckResult } from '../language/verilog/externalSyntaxCheck';

const mocks = vi.hoisted(() => ({
  connection: undefined as Connection | undefined,
  compile: vi.fn<typeof import('../language/verilog/externalSyntaxCheck').runExternalVerilogSyntaxCheck>()
}));

vi.mock('vscode-languageserver/node', async (importOriginal) => ({
  ...await importOriginal<typeof import('vscode-languageserver/node')>(),
  createConnection: () => mocks.connection!
}));

vi.mock('../language/verilog/externalSyntaxCheck', () => ({
  runExternalVerilogSyntaxCheck: mocks.compile
}));

const workspaceUri = 'file:///diagnostic-lifecycle';
const uriA = `${workspaceUri}/a.v`;
const uriB = `${workspaceUri}/b.v`;
const sourceA = 'module a;\nendmodule\n';
const sourceB = 'module b;\nendmodule\n';
let client: ProtocolConnection;
let clientToServer: PassThrough;
let serverToClient: PassThrough;
let published: PublishDiagnosticsParams[];

function diagnostic(message: string): Diagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
    source: 'Icarus Verilog',
    code: 'iverilog-syntax',
    severity: 1,
    message
  };
}

function compilerResult(message = 'existing compiler error'): ExternalVerilogSyntaxCheckResult {
  return {
    backend: 'iverilog',
    ok: false,
    diagnosticsByUri: new Map([[uriA, [diagnostic(message)]], [uriB, [diagnostic(message)]]]),
    stdout: '',
    stderr: message,
    timedOut: false
  };
}

function latestDiagnostics(uri: string): Diagnostic[] {
  return [...published].reverse().find((event) => event.uri === uri)?.diagnostics ?? [];
}

function externalDiagnostics(uri: string): Diagnostic[] {
  return latestDiagnostics(uri).filter((entry) => entry.source === 'Icarus Verilog');
}

// This request follows earlier notifications through the real connection, and its
// response follows the diagnostics they publish. It does not access server state.
async function barrier(): Promise<void> {
  await client.sendRequest(ExecuteCommandRequest.type, { command: 'test.notificationBarrier' });
}

async function open(uri: string, text: string): Promise<void> {
  await client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri, languageId: 'verilog', version: 1, text }
  });
  await barrier();
}

async function runCompiler(): Promise<unknown> {
  return client.sendRequest(ExecuteCommandRequest.type, {
    command: Commands.Server.InternalVerilogCheckSyntax,
    arguments: [uriA]
  });
}

async function configure(disabledCodes: string[] = []): Promise<void> {
  await client.sendNotification(DidChangeConfigurationNotification.type, {
    settings: { co: {
      project: { profile: 'P5' },
      diagnostics: { disabledCodes },
      verilog: { lint: { courseRules: false }, syntax: { external: { mode: 'commandOnly' } } }
    } }
  });
  await barrier();
}

beforeEach(async () => {
  vi.resetModules();
  mocks.compile.mockReset();
  // Leave setImmediate real so JSON-RPC transport runs independently of the
  // production content-change debounce that each test advances explicitly.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const lsp = await vi.importActual<typeof import('vscode-languageserver/node')>('vscode-languageserver/node');
  clientToServer = new PassThrough();
  serverToClient = new PassThrough();
  mocks.connection = lsp.createConnection(
    lsp.ProposedFeatures.all,
    new lsp.StreamMessageReader(clientToServer),
    new lsp.StreamMessageWriter(serverToClient)
  );
  client = lsp.createProtocolConnection(serverToClient, clientToServer);
  published = [];
  client.onNotification(PublishDiagnosticsNotification.type, (event) => published.push(event));
  client.listen();
  await import('../server');
  await client.sendRequest(InitializeRequest.type, {
    processId: null,
    rootUri: workspaceUri,
    capabilities: {},
    workspaceFolders: [{ uri: workspaceUri, name: 'diagnostic-lifecycle' }]
  });
  await configure();
});

afterEach(() => {
  client?.dispose();
  mocks.connection?.dispose();
  clientToServer?.destroy();
  serverToClient?.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('server external Verilog diagnostic lifecycle', () => {
  it.each([false, true])('merges compiler context only when its diagnostic is enabled (suppressed: %s)', async (suppressed) => {
    await configure(suppressed ? ['verilog:iverilog-syntax'] : []);
    await open(uriA, 'module a(input [31:0] inputA,inputB);\nwire [31:0] a_add_b <= inputA + inputB;\nendmodule\n');
    const local = latestDiagnostics(uriA).find((entry) => entry.code === 'syntax-malformed-declaration');
    expect(local).toBeDefined();
    const external = {
      ...diagnostic('syntax error'),
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
      data: { iverilogLocation: 'line' }
    };
    mocks.compile.mockResolvedValueOnce({
      ...compilerResult(),
      diagnosticsByUri: new Map([[uriA, [external]]])
    });
    await runCompiler();

    const merged = latestDiagnostics(uriA).find((entry) => entry.code === 'syntax-malformed-declaration')!;
    expect(merged.range).toEqual(local!.range);
    expect(merged.relatedInformation?.map((entry) => entry.message) ?? []).toEqual(
      suppressed ? [] : ['Icarus Verilog: syntax error']
    );
    expect(externalDiagnostics(uriA)).toEqual([]);
  });

  it('keeps workspace compiler diagnostics when another document is first opened', async () => {
    await open(uriA, sourceA);
    mocks.compile.mockResolvedValueOnce(compilerResult());
    await runCompiler();
    expect(externalDiagnostics(uriA)).toHaveLength(1);

    // TextDocuments fires both onDidOpen and onDidChangeContent for didOpen.
    // Opening B must keep the compiler result already stored for that URI.
    await open(uriB, sourceB);
    expect(externalDiagnostics(uriB)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    await barrier();

    expect(externalDiagnostics(uriA)).toHaveLength(1);
    expect(externalDiagnostics(uriB)).toHaveLength(1);
    expect(mocks.compile).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)(
    'aborts an old compiler run on edit, clears other open files after debounce, and ignores its late %s',
    async (completion) => {
      await open(uriA, sourceA);
      await open(uriB, sourceB);
      await vi.advanceTimersByTimeAsync(250);
      await barrier();
      mocks.compile.mockResolvedValueOnce(compilerResult());
      await runCompiler();
      expect(externalDiagnostics(uriA)).toHaveLength(1);
      expect(externalDiagnostics(uriB)).toHaveLength(1);

      let finish!: (result: ExternalVerilogSyntaxCheckResult) => void;
      let fail!: (error: Error) => void;
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => { started = resolve; });
      const pendingResult = new Promise<ExternalVerilogSyntaxCheckResult>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      mocks.compile.mockImplementationOnce(() => {
        started();
        return pendingResult;
      });
      const pendingCommand = runCompiler();
      await didStart;
      const signal = mocks.compile.mock.calls[1][0].signal!;
      expect(signal.aborted).toBe(false);
      const publicationCount = published.length;

      await client.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri: uriA, version: 2 },
        contentChanges: [{ text: `// edited\n${sourceA}` }]
      });
      await barrier();
      expect(signal.aborted).toBe(true);
      expect(published).toHaveLength(publicationCount);
      await vi.advanceTimersByTimeAsync(249);
      await barrier();
      expect(published).toHaveLength(publicationCount);
      await vi.advanceTimersByTimeAsync(1);
      await barrier();

      expect(published.slice(publicationCount).map((event) => event.uri)).toContain(uriB);
      expect(externalDiagnostics(uriA)).toEqual([]);
      expect(externalDiagnostics(uriB)).toEqual([]);
      const clearedPublicationCount = published.length;
      if (completion === 'resolve') finish(compilerResult('stale compiler error'));
      else fail(new Error('stale compiler failure'));
      await pendingCommand;
      await barrier();

      expect(published).toHaveLength(clearedPublicationCount);
      expect(externalDiagnostics(uriA)).toEqual([]);
      expect(externalDiagnostics(uriB)).toEqual([]);
      expect(mocks.compile).toHaveBeenCalledTimes(2);
    }
  );
});
