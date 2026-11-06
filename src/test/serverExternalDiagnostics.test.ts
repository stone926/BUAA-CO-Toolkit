import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodeActionRequest,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  ExecuteCommandRequest,
  InitializeRequest,
  PublishDiagnosticsNotification,
  type Connection,
  type CodeAction,
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

async function configure(disabledCodes: string[] = [], mode = 'commandOnly'): Promise<void> {
  await client.sendNotification(DidChangeConfigurationNotification.type, {
    settings: { co: {
      project: { profile: 'P5' },
      diagnostics: { disabledCodes },
      verilog: { lint: { courseRules: false }, syntax: { external: { mode } } }
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

describe('server diagnostic quick fixes', () => {
  it('applies per-project profiles and entrypoints before LSP diagnostics', async () => {
    await client.sendNotification(DidChangeConfigurationNotification.type, { settings: { co: {
      project: { profile: 'P5', overrides: { p4: { profile: 'P4', topModule: 'cpu4' }, p5: { profile: 'P5', topModule: 'cpu5' } } },
      verilog: { lint: { courseRules: true }, syntax: { external: { mode: 'commandOnly' } } }
    } } });
    await barrier();
    const p4 = `${workspaceUri}/p4/mips.v`, p5 = `${workspaceUri}/p5/mips.v`;
    await open(p4, 'module cpu4(input wire clk, input wire reset); endmodule');
    await open(p5, 'module cpu5(input wire clk, input wire reset); endmodule');
    await client.sendRequest(ExecuteCommandRequest.type, { command: Commands.Server.InferVerilogProjects });
    await barrier();
    expect(latestDiagnostics(p4)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'project-pc-reset' })]));
    expect(latestDiagnostics(p4).find((entry) => entry.code === 'project-pc-reset')?.message).toContain('P4:');
    expect(latestDiagnostics(p5).find((entry) => entry.code === 'project-pc-reset')?.message).toContain('P5:');
  });
  it.each([
    ['width-mismatch', 'module a(input [31:0] x, output y, z); assign y = x; assign z = x; endmodule'],
    ['port-width-mismatch', 'module child(input x); endmodule\nmodule a(input [31:0] x); child u1(.x(x)); child u2(.x(x)); endmodule']
  ])('returns one Chinese suppression action per scope for repeated %s diagnostics', async (code, text) => {
    await open(uriA, text);
    const diagnostics = latestDiagnostics(uriA).filter((entry) => entry.code === code);
    expect(diagnostics).toHaveLength(2);

    const result = await client.sendRequest(CodeActionRequest.type, {
      textDocument: { uri: uriA },
      range: diagnostics[0].range,
      context: { diagnostics: [...diagnostics, diagnostics[0]] }
    });
    const actions = (result ?? []).filter((action): action is CodeAction =>
      typeof action.command === 'object' && action.command.command === Commands.Diagnostics.DisableCode);

    expect(actions.map((action) => action.title)).toEqual([
      `对此文件禁用「${code}」检查`,
      `对此工作区禁用「${code}」检查`
    ]);
    expect(actions.map((action) => action.command?.arguments)).toEqual([
      ['verilog', code, 'file', uriA],
      ['verilog', code, 'workspace', uriA]
    ]);
    expect(actions.every((action) => action.command?.title === action.title)).toBe(true);
  });
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
  it.each([
    'function f(input x, input z); f = x & z; endfunction',
    'function integer f(input integer x, input integer z); f = x & z; endfunction'
  ])('automatically checks a saved legal ANSI function: %s', async (declaration) => {
    await configure([], 'onSave');
    await open(uriA, `module a(input a, output y); ${declaration} assign y = f(a, a); endmodule`);
    expect(latestDiagnostics(uriA).filter((entry) => entry.severity === 1 && String(entry.code).startsWith('syntax-'))).toEqual([]);
    mocks.compile.mockResolvedValueOnce({ ...compilerResult(), ok: true, diagnosticsByUri: new Map() });
    await client.sendNotification(DidSaveTextDocumentNotification.type, { textDocument: { uri: uriA } });
    await barrier();
    await vi.advanceTimersByTimeAsync(500);
    await barrier();
    expect(mocks.compile).toHaveBeenCalledTimes(1);
    expect(mocks.compile.mock.calls[0][0].triggerUri).toBe(uriA);
  });

  it('keeps automatic Icarus checks blocked for a real required-expression syntax error', async () => {
    await configure([], 'onSave');
    const text = 'module a; reg a; initial if() a=0; endmodule';
    await open(uriA, text);
    const error = latestDiagnostics(uriA).find((entry) => entry.code === 'syntax-malformed-if');
    expect(error).toMatchObject({ severity: 1, range: {
      start: { line: 0, character: text.indexOf(')') }, end: { line: 0, character: text.indexOf(')') + 1 }
    } });
    await client.sendNotification(DidSaveTextDocumentNotification.type, { textDocument: { uri: uriA } });
    await barrier();
    await vi.advanceTimersByTimeAsync(500);
    await barrier();
    expect(mocks.compile).not.toHaveBeenCalled();
  });

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
