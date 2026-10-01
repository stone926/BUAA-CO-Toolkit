import { describe, expect, it } from 'vitest';
import { CancellationTokenSource, TextEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createFormattingRequestHandler } from '../../../language/common/formattingRequest';
import { languageDocumentSelector, languageRangeFormattingSelector } from '../../../language/languageRegistry';

describe('formatting request lifecycle', () => {
  function fixture() {
    let document: TextDocument | undefined = TextDocument.create('file:///test.v', 'verilog', 1, 'module m;\nendmodule');
    let resolve!: (value: string) => void;
    const settings = new Promise<string>((done) => { resolve = done; });
    let calls = 0;
    const token = new CancellationTokenSource();
    const handler = createFormattingRequestHandler({
      getDocument: () => document,
      getSettings: () => settings,
      format: (doc: TextDocument, _params: { textDocument: { uri: string } }, value: string) => {
        calls++;
        expect(value).toBe('settings');
        return [TextEdit.insert(doc.positionAt(0), ' ')];
      },
      onError: (error: unknown) => { throw error; }
    });
    return { token, handler, resolve, calls: () => calls, document: () => document!, setDocument: (next: TextDocument | undefined) => { document = next; } };
  }
  it('applies current document edits', async () => {
    const f = fixture();
    const pending = f.handler({ textDocument: { uri: f.document().uri } }, f.token.token);
    f.resolve('settings');
    expect(TextDocument.applyEdits(f.document(), await pending)).toBe(' module m;\nendmodule');
    expect(f.calls()).toBe(1);
  });
  for (const change of ['cancel', 'update', 'close', 'reopen'] as const) {
    it(`drops a request after ${change} while awaiting settings`, async () => {
      const f = fixture();
      const pending = f.handler({ textDocument: { uri: f.document().uri } }, f.token.token);
      if (change === 'cancel') f.token.cancel();
      if (change === 'update') TextDocument.update(f.document(), [{ text: 'module changed; endmodule' }], 2);
      if (change === 'close') f.setDocument(undefined);
      if (change === 'reopen') f.setDocument(TextDocument.create(f.document().uri, 'verilog', 1, 'module reopened; endmodule'));
      f.resolve('settings');
      expect(await pending).toEqual([]);
      expect(f.calls()).toBe(0);
    });
  }
  it('passes range parameters unchanged and applies all returned edits', async () => {
    const document = TextDocument.create('file:///range.v', 'verilog', 3, 'module m;\na=1;\nendmodule');
    const range = { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } };
    const params = { textDocument: { uri: document.uri }, range, options: { tabSize: 2, insertSpaces: true } };
    const handler = createFormattingRequestHandler({
      getDocument: () => document,
      getSettings: async () => 'settings',
      format: (doc, request: typeof params) => {
        expect(request).toBe(params);
        return [TextEdit.insert(doc.positionAt(11), ' '), TextEdit.insert(doc.positionAt(12), ' ')];
      },
      onError: (error: unknown) => { throw error; }
    });
    expect(TextDocument.applyEdits(document, await handler(params, new CancellationTokenSource().token)))
      .toBe('module m;\na = 1;\nendmodule');
  });
  it('reports failed configuration reads without returning edits', async () => {
    const document = TextDocument.create('file:///error.v', 'verilog', 1, 'module m; endmodule');
    const failure = new Error('configuration failed');
    const errors: unknown[] = [];
    const handler = createFormattingRequestHandler({
      getDocument: () => document,
      getSettings: async () => { throw failure; },
      format: () => { throw new Error('must not format'); },
      onError: (error) => { errors.push(error); }
    });
    expect(await handler({ textDocument: { uri: document.uri } }, new CancellationTokenSource().token)).toEqual([]);
    expect(errors).toEqual([failure]);
  });
  it('does not load settings when already cancelled or closed', async () => {
    const f = fixture();
    f.token.cancel();
    expect(await f.handler({ textDocument: { uri: f.document().uri } }, f.token.token)).toEqual([]);
    f.setDocument(undefined);
    expect(await f.handler({ textDocument: { uri: 'file:///closed.v' } }, new CancellationTokenSource().token)).toEqual([]);
    expect(f.calls()).toBe(0);
  });
});

describe('formatting selectors', () => {
  it('advertises range formatting only for file Verilog documents', () => {
    expect(languageRangeFormattingSelector()).toEqual([{ scheme: 'file', language: 'verilog' }]);
  });
  it('preserves the full formatting and general service boundaries', () => {
    expect(languageDocumentSelector(true)).toEqual([
      { scheme: 'file', language: 'mipsasm' }, { scheme: 'file', language: 'verilog' }
    ]);
    expect(languageDocumentSelector()).toEqual([
      { scheme: 'file', language: 'mipsasm' }, { scheme: 'file', language: 'verilog' }, { scheme: 'file', pattern: '**/*.circ' }
    ]);
  });
});
