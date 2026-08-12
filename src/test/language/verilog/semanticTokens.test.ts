import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { mipsSemanticTokenTypes } from '../../../language/mips/resources';
import { verilogSemanticTokenTypes } from '../../../language/verilog/model';
import { clearVerilogSemanticTokenCache, getVerilogSemanticTokens } from '../../../language/verilog/service';

interface DecodedToken {
  line: number;
  character: number;
  length: number;
  type: number;
  modifiers: number;
}

function doc(text: string, version = 1): TextDocument {
  return TextDocument.create('test://semantic.v', 'verilog', version, text);
}

function decode(data: number[]): DecodedToken[] {
  const tokens: DecodedToken[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < data.length; index += 5) {
    line += data[index];
    character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
    tokens.push({
      line,
      character,
      length: data[index + 2],
      type: data[index + 3],
      modifiers: data[index + 4]
    });
  }
  return tokens;
}

function type(name: typeof verilogSemanticTokenTypes[number]): number {
  return mipsSemanticTokenTypes.length + verilogSemanticTokenTypes.indexOf(name);
}

describe('Verilog semantic tokens', () => {
  afterEach(() => clearVerilogSemanticTokenCache());

  it('highlights backtick macro uses as one macro token', () => {
    const text = [
      '`define WIDTH 8',
      'module m;',
      '    wire [`WIDTH-1:0] data;',
      '    assign data = `WIDTH;',
      'endmodule'
    ].join('\n');
    const tokens = decode(getVerilogSemanticTokens(doc(text), mergeCoSettings({})).data);
    const line = text.split('\n')[3];

    expect(tokens).toContainEqual(expect.objectContaining({
      line: 3,
      character: line.indexOf('`WIDTH'),
      length: '`WIDTH'.length,
      type: type('verilogMacro')
    }));
  });

  it('leaves comments, strings, numbers, keywords and punctuation to TextMate', () => {
    const text = [
      'module m;',
      '  wire [31:0] pc;',
      '  assign pc = 32\'h4; // pc and "pc" are lexical trivia',
      '  initial $display("%h", pc);',
      'endmodule'
    ].join('\n');
    const tokens = decode(getVerilogSemanticTokens(doc(text), mergeCoSettings({})).data);
    const commentStart = text.split('\n')[2].indexOf('//');
    const stringStart = text.split('\n')[3].indexOf('"');

    expect(tokens.some((token) => token.line === 2 && token.character >= commentStart)).toBe(false);
    expect(tokens.some((token) => token.line === 3 && token.character >= stringStart && token.character < stringStart + 4)).toBe(false);
    expect(tokens.some((token) => token.type < mipsSemanticTokenTypes.length)).toBe(false);
  });

  it('classifies modules, ports, parameters, instances and signals by AST role', () => {
    const text = [
      'module Child #(parameter WIDTH = 8) (input wire a); endmodule',
      'module Top;',
      '  wire sig;',
      '  Child #(.WIDTH(4)) u_child(.a(sig));',
      'endmodule'
    ].join('\n');
    const lines = text.split('\n');
    const tokens = decode(getVerilogSemanticTokens(doc(text), mergeCoSettings({})).data);

    expect(tokenAt(tokens, 0, lines[0].indexOf('Child'))?.type).toBe(type('verilogModule'));
    expect(tokenAt(tokens, 0, lines[0].indexOf('WIDTH'))?.type).toBe(type('verilogParameter'));
    expect(tokenAt(tokens, 0, lines[0].lastIndexOf('a'))?.type).toBe(type('verilogPort'));
    expect(tokenAt(tokens, 3, lines[3].indexOf('u_child'))?.type).toBe(type('verilogInstance'));
    expect(tokenAt(tokens, 3, lines[3].indexOf('.WIDTH') + 1)?.type).toBe(type('verilogParameter'));
    expect(tokenAt(tokens, 3, lines[3].indexOf('.a') + 1)?.type).toBe(type('verilogPort'));
    expect(tokenAt(tokens, 3, lines[3].indexOf('sig'))?.type).toBe(type('verilogSignal'));
  });

  it('keeps named connection roles stable without a workspace index', () => {
    const text = 'module top; wire sig; Missing #(.WIDTH(4)) u(.clk(sig)); endmodule';
    const tokens = decode(getVerilogSemanticTokens(doc(text), mergeCoSettings({})).data);

    expect(tokenAt(tokens, 0, text.indexOf('.WIDTH') + 1)?.type).toBe(type('verilogParameter'));
    expect(tokenAt(tokens, 0, text.indexOf('.clk') + 1)?.type).toBe(type('verilogPort'));
  });

  it('highlights task and function declarations and calls distinctly', () => {
    const text = [
      'module m;',
      '  task do_it; begin end endtask',
      '  function [31:0] add1; input [31:0] x; begin add1 = x + 1; end endfunction',
      '  initial begin do_it; $display("%h", add1(1)); end',
      'endmodule'
    ].join('\n');
    const lines = text.split('\n');
    const tokens = decode(getVerilogSemanticTokens(doc(text), mergeCoSettings({})).data);

    expect(tokenAt(tokens, 1, lines[1].indexOf('do_it'))?.type).toBe(type('verilogTask'));
    expect(tokenAt(tokens, 3, lines[3].indexOf('do_it'))?.type).toBe(type('verilogTask'));
    expect(tokenAt(tokens, 2, lines[2].indexOf('add1'))?.type).toBe(type('verilogFunction'));
    expect(tokenAt(tokens, 3, lines[3].indexOf('add1'))?.type).toBe(type('verilogFunction'));
  });

  it('colors legal implicit nets and unresolved signal-like identifiers', () => {
    const text = 'module m; assign b = a; endmodule';
    const tokens = decode(getVerilogSemanticTokens(doc(text), mergeCoSettings({})).data);

    expect(tokenAt(tokens, 0, text.indexOf('b ='))?.type).toBe(type('verilogSignal'));
    expect(tokenAt(tokens, 0, text.indexOf('a;'))?.type).toBe(type('verilogSignal'));
  });

  it('reuses results for identical text and replaces them after an edit', () => {
    const settings = mergeCoSettings({});
    const firstDocument = doc('module m; wire a; endmodule', 1);
    const first = getVerilogSemanticTokens(firstDocument, settings);
    expect(getVerilogSemanticTokens(doc(firstDocument.getText(), 2), settings)).toBe(first);

    const changed = getVerilogSemanticTokens(doc('module m; wire longer_name; endmodule', 3), settings);
    expect(changed).not.toBe(first);
    expect(changed.data).not.toEqual(first.data);
  });
});

function tokenAt(tokens: DecodedToken[], line: number, character: number): DecodedToken | undefined {
  return tokens.find((token) =>
    token.line === line &&
    token.character <= character &&
    character < token.character + token.length
  );
}
