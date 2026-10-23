// @index declaration-diagnostic-tests — Source identity, supplementation and lexical namespace regressions
import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

const settings = mergeCoSettings({ verilog: { lint: { courseRules: false } } });
let version = 1;
function check(source: string) {
  const document = TextDocument.create(`test://declarations/${version++}.v`, 'verilog', version, source);
  const index = new VerilogWorkspaceIndex();
  index.updateDocument(document, settings);
  return { document, diagnostics: getVerilogDiagnostics(document, settings, index) };
}
function expectError(marked: string, code = 'duplicate-declaration') {
  const start = marked.indexOf('[['), end = marked.indexOf(']]');
  const source = marked.replace('[[', '').replace(']]', '');
  const { document, diagnostics } = check(source);
  expect(diagnostics.find((diagnostic) => diagnostic.code === code), JSON.stringify(diagnostics)).toMatchObject({ code, severity: DiagnosticSeverity.Error, range: Range.create(document.positionAt(start), document.positionAt(end - 2)) });
}

describe('Verilog declaration identities and namespaces', () => {
  it.each([
    'wire a; wire [[a]];', 'reg a; reg [[a]];', 'parameter A=1; parameter [[A]]=2;',
    'localparam A=1; localparam [[A]]=2;', 'wire a; reg [[a]];', 'reg a,[[a]];',
    'initial begin : b reg a; reg [[a]]; end',
    'function f; input a; reg x; reg [[x]]; f=a; endfunction',
  ])('rejects repeated storage/parameter declarations: %s', (body) => expectError(`module m; ${body} endmodule`));
  it('checks instance names in their containing scope', () => {
    expectError('module leaf; endmodule module m; leaf u(); leaf [[u]](); endmodule');
    expectError('module leaf; endmodule module m; wire u; leaf [[u]](); endmodule');
  });
  it('checks procedural and generate block names in the parent namespace', () => {
    expectError('module m; initial begin:b end initial begin:[[b]] end endmodule');
    expectError('module m; wire b; initial begin:[[b]] end endmodule');
    expectError('module m; generate begin:g end begin:[[g]] end endgenerate endmodule');
  });
  it('checks callable names and same-scope formals', () => {
    expectError('module m; task t; begin end endtask task [[t]]; begin end endtask endmodule');
    expectError('module m; function f(input a,input [[a]]); f=a; endfunction endmodule');
    expectError('module m; task t; input a,[[a]]; begin end endtask endmodule');
    expectError('module m; function f(input a); reg [[a]]; f=a; endfunction endmodule');
  });
  it('detects repeated module header ports and conflicting old-style directions', () => {
    expectError('module m(input a,input [[a]]); endmodule');
    expectError('module m(a,[[a]]); input a; endmodule');
    expectError('module m(a); input a; output [[a]]; endmodule', 'conflicting-port-direction');
  });
  it('requires a direction for each old-style module header port', () => {
    expectError('module m([[a]]); endmodule', 'missing-port-direction');
    expectError('module m([[a]]); wire a; endmodule', 'missing-port-direction');
  });
  it.each([true, false])('keeps include-provided port directions unknown with complete index=%s', (complete) => {
    const source = 'module m(a);\n`include "ports.vh"\nendmodule';
    const document = TextDocument.create(`test://included-ports-${complete}.v`, 'verilog', version++, source);
    const index = new VerilogWorkspaceIndex({ workspaceComplete: complete });
    if (complete) index.updateDocument(TextDocument.create('test://ports.vh', 'verilog', 1, 'input a;'), settings);
    index.updateDocument(document, settings);
    expect(getVerilogDiagnostics(document, settings, index).some((diagnostic) => diagnostic.code === 'missing-port-direction')).toBe(false);
  });
  it('keeps declaration-macro port directions unknown', () => {
    const source = '`define PORT input a;\nmodule m(a);\n`PORT\nendmodule';
    expect(check(source).diagnostics.some((diagnostic) => diagnostic.code === 'missing-port-direction')).toBe(false);
  });
  it('does not let sibling includes or expression macros hide absent port directions', () => {
    expectError('module other;\n`include "ports.vh"\nendmodule module m([[a]]); endmodule', 'missing-port-direction');
    expectError('`define ONE 1\nmodule m([[a]]); wire b; assign b=`ONE; endmodule', 'missing-port-direction');
  });
  it('rejects incompatible packed ranges by endpoints, including direction', () => {
    expectError('module m(y); output [3:0] y; reg [4:0] [[y]]; endmodule');
    expectError('module m(a); input [3:0] a; wire [0:3] [[a]]; endmodule');
    expectError('module m(y); output y; reg [0:0] [[y]]; endmodule');
    expectError('module m(y); output [3:0] y; reg [[y]]; endmodule');
  });
  it('compares evaluated endpoints while preserving unresolved dependencies', () => {
    for (const source of [
      'module m(a); parameter N=3; input [N:0] a; wire [3:0] a; endmodule',
      'module m(a); input [N:0] a; wire [3:0] a; endmodule',
      'module m(a); input [-1:-8] a; wire [-1:-8] a; endmodule'
    ]) expect(check(source).diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-declaration')).toBe(false);
  });
  it('reserves the function return name from formal arguments', () => {
    expectError('module m; function f(input [[f]]); f=f; endfunction endmodule');
    expectError('module m; function f; input [[f]]; f=f; endfunction endmodule');
  });
  it('permits explicit variable redeclarations of a function return value', () => {
    for (const source of [
      'module m; function f; input a; reg f; f=a; endfunction endmodule',
      'module m; function f(input a); begin:f f=a; end endfunction endmodule',
      'module m; function [3:0] f; input a; reg [4:0] f; f=a; endfunction endmodule',
      'module m; function f; input a; integer f; f=a; endfunction endmodule'
    ]) expect(check(source).diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-declaration')).toBe(false);
  });
  it('rejects repeated storage after an old-style supplementation', () => {
    expectError('module m(y); output y; wire y; wire [[y]]; endmodule');
    expectError('module m(y); output reg y; reg [[y]]; endmodule');
    expectError('module m(input a); wire [[a]]; endmodule');
  });
  it.each([
    'module m(a,y); input a; output y; wire y; assign y=a; endmodule',
    'module m(a,y); wire a; input a; output y; reg y; initial y=a; endmodule',
    'module m; wire a; initial begin:b reg a; a=1; end endmodule',
    'module m; initial begin:a begin:b end end initial begin:c begin:b end end endmodule',
    'module m; function f; input a; reg a; f=a; endfunction endmodule',
    'module m; function f; input a; f=a; endfunction function g; input a; g=a; endfunction endmodule',
    'module leaf; endmodule module m; generate begin:a wire x; leaf u(); end begin:b wire x; leaf u(); end endgenerate endmodule',
    'module m; parameter P=1; generate if(P) begin:g wire a; end else begin:g wire a; end endgenerate endmodule'
  ])('accepts independent lexical scopes and legal supplementation: %s', (source) => {
    const conflicts = check(source).diagnostics.filter((diagnostic) => ['duplicate-declaration', 'conflicting-port-direction', 'missing-port-direction'].includes(String(diagnostic.code)));
    expect(conflicts).toEqual([]);
  });
});
