// @index subroutine-provider-tests — Shared signatures for argument help and scoped navigation
import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Range } from 'vscode-languageserver-types';
import { defaultCoSettings } from '../../../language/common/settings';
import { getVerilogDefinition, getVerilogReferences, getVerilogSignatureHelp } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let version = 1;
function setup(marked: string) {
  const cursor = marked.indexOf('|');
  const source = marked.replace('|', '');
  const document = TextDocument.create(`test://subroutine-providers/${version++}.v`, 'verilog', version, source);
  const index = new VerilogWorkspaceIndex();
  index.updateDocument(document, defaultCoSettings);
  return { document, index, position: document.positionAt(cursor), source };
}

describe('Verilog subroutine signature help', () => {
  it('shows formal order, inherited integer types, direction and function return type', () => {
    const { document, index, position } = setup('module m; function integer f(input integer x,z); f=x+z; endfunction integer y; initial y=f(1,|2); endmodule');
    const help = getVerilogSignatureHelp(document, position, defaultCoSettings, index);
    expect(help?.activeParameter).toBe(1);
    expect(help?.signatures[0].label).toBe('function integer f(input integer x, input integer z)');
    expect(help?.signatures[0].parameters?.map((parameter) => parameter.label)).toEqual(['input integer x', 'input integer z']);
    expect(help?.signatures[0].documentation).toMatchObject({ value: expect.stringContaining('返回位宽：`32` 位') });
  });
  it('shows old-style task directions and variables in source order', () => {
    const { document, index, position } = setup('module m; reg [7:0] a; task t; input [7:0] source; output [7:0] dest; dest=source; endtask initial t(a,|a); endmodule');
    const help = getVerilogSignatureHelp(document, position, defaultCoSettings, index);
    expect(help?.activeParameter).toBe(1);
    expect(help?.signatures[0].label).toBe('task t(input reg [7:0] source, output reg [7:0] dest)');
  });
  it('finds the innermost call and ignores commas inside concatenations', () => {
    const body = 'function f(input x,z); f=x+z; endfunction function g(input a,b); g=a+b; endfunction reg y;';
    const inner = setup(`module m; ${body} initial y=f(1,g(1,|2)); endmodule`);
    expect(getVerilogSignatureHelp(inner.document, inner.position, defaultCoSettings, inner.index)?.signatures[0].label).toContain(' g(');
    const outer = setup(`module m; ${body} initial y=f({1'b0,1'b1},|2); endmodule`);
    expect(getVerilogSignatureHelp(outer.document, outer.position, defaultCoSettings, outer.index)?.activeParameter).toBe(1);
  });
  it('binds an unfinished call from the lexical model', () => {
    const { document, index, position } = setup('module m; function f(input a,b); f=a+b; endfunction reg y; initial y=f(1,|');
    const help = getVerilogSignatureHelp(document, position, defaultCoSettings, index);
    expect(help?.activeParameter).toBe(1);
    expect(help?.signatures[0].label).toBe('function reg f(input reg a, input reg b)');
  });
  it('uses the callable declared in the containing generate scope', () => {
    const { document, index, position } = setup('module m(output y,z); if(1) begin:a function f(input x); f=x; endfunction assign y=f(1); end if(1) begin:b function [7:0] f(input x,input q); f=x&q; endfunction assign z=f(1,|1); end endmodule');
    const help = getVerilogSignatureHelp(document, position, defaultCoSettings, index);
    expect(help?.signatures[0].label).toBe('function reg [7:0] f(input reg x, input reg q)');
    expect(help?.activeParameter).toBe(1);
    expect(help?.signatures[0].documentation).toMatchObject({ value: expect.stringContaining('返回位宽：`8` 位') });
  });
  it('withholds an argument list whose included formals have not been resolved', () => {
    const { document, index, position } = setup('module m; function f;\n`include "args.vh"\nf=a; endfunction wire y=f(1,|1); endmodule');
    expect(getVerilogSignatureHelp(document, position, defaultCoSettings, index)).toBeUndefined();
  });
  it('does not offer a call signature inside a declaration or for a non-callable', () => {
    for (const source of ['module m; function f(input |a); f=a; endfunction endmodule', 'module m; wire f; initial f(|1); endmodule']) {
      const { document, index, position } = setup(source);
      expect(getVerilogSignatureHelp(document, position, defaultCoSettings, index)).toBeUndefined();
    }
  });
});

describe('Verilog scoped subroutine navigation', () => {
  it('selects the corresponding callable declaration and formals in each generate scope', () => {
    const marked = 'module m(output y,z); if(1) begin:a function f(input x); f=x; endfunction assign y=f(1); end if(1) begin:b function f(input x,input q); f=x&q; endfunction assign z=f(1,1); end endmodule';
    const { document, index, source } = setup(marked);
    const firstDeclaration = source.indexOf('f(input x)');
    const secondDeclaration = source.indexOf('f(input x,input q)');
    const firstCall = source.indexOf('=f(1)') + 1;
    const secondCall = source.indexOf('f(1,1)');
    const definition = (offset: number) => getVerilogDefinition(document, document.positionAt(offset), defaultCoSettings, index)?.range;
    expect(definition(firstCall)).toEqual(Range.create(document.positionAt(firstDeclaration), document.positionAt(firstDeclaration + 1)));
    expect(definition(secondCall)).toEqual(Range.create(document.positionAt(secondDeclaration), document.positionAt(secondDeclaration + 1)));
    const firstFormal = source.indexOf('x);');
    const secondFormal = source.indexOf('x,input q');
    expect(definition(source.indexOf('f=x;') + 2)).toEqual(Range.create(document.positionAt(firstFormal), document.positionAt(firstFormal + 1)));
    expect(definition(source.indexOf('f=x&q') + 2)).toEqual(Range.create(document.positionAt(secondFormal), document.positionAt(secondFormal + 1)));
    const references = getVerilogReferences(document, { textDocument: { uri: document.uri }, position: document.positionAt(secondCall), context: { includeDeclaration: true } }, defaultCoSettings, index);
    expect(references.map((reference) => document.offsetAt(reference.range.start)).sort((left, right) => left - right)).toEqual([secondDeclaration, source.indexOf('f=x&q'), secondCall]);
  });
});
