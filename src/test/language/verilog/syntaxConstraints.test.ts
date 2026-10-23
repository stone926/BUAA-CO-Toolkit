import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let version = 0;
function diagnostics(source: string, languageId = 'verilog') {
  const document = TextDocument.create(`file:///syntax-constraints/top-${++version}.v`, languageId, version, source);
  const leaf = TextDocument.create('file:///syntax-constraints/leaf.v', 'verilog', 1,
    'module leaf #(parameter A=1, B=2)(input a, b); endmodule');
  const settings = mergeCoSettings({ verilog: { lint: { courseRules: false } } });
  const index = new VerilogWorkspaceIndex();
  index.updateDocument(leaf, settings);
  index.updateDocument(document, settings);
  return { document, result: getVerilogDiagnostics(document, settings, index) };
}

describe('Verilog-2005 syntax constraints through the workspace diagnostic entry', () => {
  it.each([
    ['if() a=0;', 'if(a) a=0;', 'syntax-malformed-if', ')'],
    ['case() 0:a=0; endcase', 'case(a) 0:a=0; endcase', 'syntax-malformed-case', ')'],
    ['#() a=0;', '#(1) a=0;', 'syntax-malformed-delay', ')'],
    ['begin a=1; #() a=0; end', 'begin a=1; #1 a=0; end', 'syntax-malformed-delay', ')'],
    ['for(i=0;;i=i+1) a=0;', 'for(i=0;i<2;i=i+1) a=0;', 'syntax-malformed-for', ';i='],
    ['if(a +) a=0;', 'if(a + 1) a=0;', 'syntax-malformed-if', ')']
  ])('validates %s and accepts its completed expression', (bad, good, code, anchor) => {
    const source = `module top; reg a; integer i; initial ${bad} endmodule`;
    const { document, result } = diagnostics(source);
    const error = result.find((entry) => entry.code === code);
    expect(error).toBeDefined();
    expect(error!.severity).toBe(DiagnosticSeverity.Error);
    const offset = source.indexOf(anchor);
    expect(error!.range.start).toEqual(document.positionAt(offset));
    expect(error!.range.end).toEqual(document.positionAt(offset + (bad.includes('a +)') ? 0 : 1)));
    const valid = diagnostics(`module top; reg a; integer i; initial ${good} endmodule`);
    expect(valid.result.filter((entry) => entry.code === code)).toEqual([]);
  });

  it.each([
    ['wire [:0] a;', 'wire [-1:-8] a;', 'syntax-malformed-declaration', ':'],
    ['wire [7:] a;', 'wire [7:0] a;', 'syntax-malformed-declaration', ']'],
    ['reg a[0:];', 'reg a[0:7];', 'syntax-malformed-declaration', ']'],
    ['input [:0] a;', 'input [7:0] a;', 'syntax-malformed-declaration', ':'],
    ['function [:0] f(input x); f=x; endfunction', 'function [7:0] f(input x); f=x; endfunction', 'syntax-malformed-declaration', ':']
  ])('validates declaration range endpoints in %s', (bad, good, code, anchor) => {
    const source = `module top; ${bad} endmodule`;
    const { document, result } = diagnostics(source);
    const error = result.find((entry) => entry.code === code);
    expect(error).toBeDefined();
    expect(error!.severity).toBe(DiagnosticSeverity.Error);
    expect(error!.range).toEqual({ start: document.positionAt(source.indexOf(anchor)), end: document.positionAt(source.indexOf(anchor)) });
    expect(diagnostics(`module top; ${good} endmodule`).result.filter((entry) => entry.code === code)).toEqual([]);
  });

  it.each([
    ['module top(input [:0] a); endmodule', 'module top(input [7:0] a); endmodule'],
    ['module top; function f(input [:0] x); f=x; endfunction endmodule',
      'module top; function f(input [7:0] x); f=x; endfunction endmodule']
  ])('validates ANSI declaration ranges', (source, good) => {
    const { document, result } = diagnostics(source);
    expect(result.find((entry) => entry.code === 'syntax-malformed-port-list')).toMatchObject({
      severity: DiagnosticSeverity.Error,
      range: { start: document.positionAt(source.indexOf(':')), end: document.positionAt(source.indexOf(':')) }
    });
    expect(diagnostics(good).result.filter((entry) => entry.code === 'syntax-malformed-port-list')).toEqual([]);
  });

  it.each([
    ['leaf u(.a(a), b);', 'leaf u(.a(a), .b(b));', 'b);'],
    ['leaf u(a, .b(b));', 'leaf u(a, b);', '.b'],
    ['leaf #(.A(1), 2) u(a,b);', 'leaf #(.A(1), .B(2)) u(a,b);', '2)'],
    ['leaf #(1, .B(2)) u(a,b);', 'leaf #(1, 2) u(a,b);', '.B'],
    ['leaf u(.a(a),);', 'leaf u(a,);', ',']
  ])('rejects mixed connection forms in %s', (bad, good, anchor) => {
    const source = `module top(input a,b); ${bad} endmodule`;
    const { document, result } = diagnostics(source);
    expect(result.find((entry) => entry.code === 'syntax-malformed-instance')).toMatchObject({
      severity: DiagnosticSeverity.Error,
      range: {
        start: document.positionAt(source.indexOf(anchor, source.indexOf('leaf'))),
        end: document.positionAt(source.indexOf(anchor, source.indexOf('leaf')) + 1)
      }
    });
    expect(diagnostics(`module top(input a,b); ${good} endmodule`).result.filter((entry) => entry.code === 'syntax-malformed-instance')).toEqual([]);
  });

  it('does not apply the Verilog-2005 empty-for condition rule to SystemVerilog documents', () => {
    const source = 'module top; integer i; initial for(i=0;;i=i+1); endmodule';
    expect(diagnostics(source).result.some((entry) => entry.code === 'syntax-malformed-for')).toBe(true);
    expect(diagnostics(source, 'systemverilog').result.some((entry) => entry.code === 'syntax-malformed-for')).toBe(false);
  });

  it('accepts ternaries and nested selects in declaration endpoints', () => {
    const source = 'module top; parameter A=1; wire [A ? 7 : 3:0] a; wire [(A ? 7 : 3):0] b; endmodule';
    expect(diagnostics(source).result.filter((entry) => String(entry.code).startsWith('syntax-'))).toEqual([]);
  });

  it.each([
    'module top #(parameter [:0] A=1)(); endmodule',
    'module top #(parameter A=1, parameter [7:] B=2)(); endmodule'
  ])('validates parameter header ranges through shared declaration checks', (source) => {
    const { document, result } = diagnostics(source);
    const position = source.includes('[:') ? source.indexOf(':') : source.indexOf(']');
    expect(result.find((entry) => entry.code === 'syntax-malformed-declaration')).toMatchObject({
      severity: DiagnosticSeverity.Error,
      range: { start: document.positionAt(position), end: document.positionAt(position) }
    });
  });

  it.each(['a=1;', ';', 'begin a=1; end'])('accepts wait controls followed by %s', (body) => {
    expect(diagnostics(`module top; reg a; initial wait(a) ${body} endmodule`).result
      .filter((entry) => entry.severity === DiagnosticSeverity.Error)).toEqual([]);
  });

  it.each([
    ['if() begin wire a; end', 'if(1) begin wire a; end', 'syntax-malformed-if'],
    ['case() 0: begin wire a; end endcase', 'case(0) 0: begin wire a; end endcase', 'syntax-malformed-case']
  ])('validates complete implicit generate controls: %s', (bad, good, code) => {
    const source = `module top; ${bad} endmodule`;
    const { document, result } = diagnostics(source);
    expect(result.find((entry) => entry.code === code)).toMatchObject({
      severity: DiagnosticSeverity.Error,
      range: { start: document.positionAt(source.indexOf(')')), end: document.positionAt(source.indexOf(')') + 1) }
    });
    expect(diagnostics(`module top; ${good} endmodule`).result.filter((entry) => String(entry.code).startsWith('syntax-'))).toEqual([]);
  });

  it.each([
    'initial #(1:2:3) a=1;',
    'initial #(1 ? 2 : 3) a=1;',
    'initial #(1 ? 2 : 3 : 4 : 5) a=1;',
    'leaf #(1:2:3,2) u(a,a);',
    'leaf #(.A(1:2:3), .B(2)) u(a,a);',
    'function integer f; input integer x; f=x; endfunction'
  ])('keeps neighboring legal expression and formal syntax: %s', (statement) => {
    expect(diagnostics(`module top; reg a; ${statement} endmodule`).result
      .filter((entry) => String(entry.code).startsWith('syntax-'))).toEqual([]);
  });

  it.each([
    'function f(input x, input z); f = x & z; endfunction',
    'function integer f(input integer x, input integer z); f = x & z; endfunction',
    'task automatic t(input integer x, output reg z); z=x; endtask'
  ])('accepts the ANSI subroutine header without per-argument semicolons: %s', (declaration) => {
    expect(diagnostics(`module top(input a, output y); ${declaration} endmodule`).result
      .filter((entry) => String(entry.code).startsWith('syntax-'))).toEqual([]);
  });

  it('retains missing-semicolon errors in old-style subroutine body declarations', () => {
    const source = 'module top; function f; input x\n reg z; f=x; endfunction endmodule';
    const { document, result } = diagnostics(source);
    expect(result.find((entry) => entry.code === 'syntax-missing-semicolon')).toMatchObject({
      severity: DiagnosticSeverity.Error,
      range: { start: document.positionAt(source.indexOf('input')), end: document.positionAt(source.indexOf('input') + 5) }
    });
  });
});
