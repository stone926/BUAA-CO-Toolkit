import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/diagnosticProvider';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

const settings = mergeCoSettings({ verilog: { lint: { courseRules: false } } });
let version = 1;
function check(body: string, prefix = 'input [7:0] n,a, output [7:0] y') {
  const source = `module m(${prefix});\n${body}\nendmodule`;
  const document = TextDocument.create(`test://constant-context/${version++}.v`, 'verilog', version, source);
  const index = new VerilogWorkspaceIndex();
  index.updateDocument(TextDocument.create('test://constant-context/leaf.v', 'verilog', 1, 'module leaf; endmodule'), settings);
  index.updateDocument(document, settings);
  return { document, diagnostics: getVerilogDiagnostics(document, settings, index) };
}

describe('constant contexts through the indexed production diagnostic entry', () => {
  it.each([
    ['packed declaration', 'wire [n:0] b;', 'n'],
    ['unpacked dimension', 'reg b[0:n];', 'n'],
    ['parameter', 'localparam P=n;', 'n'],
    ['part-select', 'assign y=a[n:0];', 'n'],
    ['indexed-select width', 'assign y=a[0+:n];', 'n'],
    ['replication', 'assign y={n{a}};', 'n'],
    ['instance array', 'leaf u[n:0]();', 'n'],
    ['generate if', 'generate if(n) begin:g wire b; end endgenerate', 'n'],
    ['generate case', 'generate case(n) 0:begin:g wire b; end endcase endgenerate', 'n'],
    ['generate case label', 'generate case(1) n:begin:g wire b; end endcase endgenerate', 'n'],
    ['generate loop boundary', 'genvar i; generate for(i=0;i<n;i=i+1) begin:g wire b; end endgenerate', 'i<n'],
    ['generate initialization', 'genvar i; generate for(i=n;i<4;i=i+1) begin:g wire b; end endgenerate', 'n'],
    ['scoped declaration', 'initial begin:b reg c[0:n]; end', 'n']
  ])('rejects runtime input in %s', (_name, source, marked) => {
    const { document, diagnostics } = check(source);
    const error = diagnostics.find((item) => item.code === 'nonconstant-expression');
    expect(error, JSON.stringify(diagnostics)).toBeDefined();
    expect(error?.severity).toBe(DiagnosticSeverity.Error);
    expect(document.getText(error!.range)).toBe(marked);
  });

  it.each([
    'assign y=a[n];', 'assign y=a[n+:2];', 'wire [-1:-8] b;',
    "localparam X=4'bx1z0; localparam Z={X,4'hz};",
    'function integer f(input integer x); f=x+1; endfunction localparam P=f(2); wire [P:0] b;',
    'localparam P=2; wire [P:0] b; reg c[0:P]; leaf u[P:0]();',
    'genvar i; generate for(i=0;i<8;i=i+1) begin:g assign y[i]=a[i]; end endgenerate',
    'generate for(genvar i=0;i<8;i=i+1) begin:g assign y[i]=a[i]; end endgenerate',
    'genvar i; generate for(i=0;i<8;i=i+1) begin:g localparam P=i+1; wire [P:0] b; end endgenerate',
    'genvar i; for(i=0;i<8;i=i+1) assign y[i]=i;',
    'genvar i,j; for(i=0;i<2;i=i+1) for(j=0;j<2;j=j+1) assign y[2*i+j]=i+j;',
    'genvar i; for(i=0;i<2;i=i+1) begin:g function integer f(input x); f=x+i; endfunction localparam P=f(1); wire [P:0] b; end',
    'genvar i; for(i=0;i<2;i=i+1) begin:g initial begin:b integer i; i=1; end end',
    'localparam P=2; initial begin:b reg P; reg c[0:1]; P=0; end'
  ])('keeps the adjacent legal case: %s', (source) => {
    const { diagnostics } = check(source);
    expect(diagnostics.filter((item) => item.severity === DiagnosticSeverity.Error)).toEqual([]);
  });

  it('does not treat an unresolved dependency as proven nonconstant', () => {
    const { diagnostics } = check('localparam P=`MISSING; wire [P:0] b;');
    expect(diagnostics.filter((item) => item.code === 'nonconstant-expression')).toEqual([]);
  });

  it('reports a parameter dependency chain with the closing reference range', () => {
    const { document, diagnostics } = check('parameter A=B; parameter B=A;');
    const cycle = diagnostics.find((item) => item.code === 'parameter-cycle');
    expect(cycle?.severity).toBe(DiagnosticSeverity.Error);
    expect(cycle?.message).toContain('A -> B -> A');
    expect(document.getText(cycle!.range)).toBe('A');
  });

  it('binds parameter dependencies at their declaration rather than a shadowing use', () => {
    const { diagnostics } = check('localparam P=2; localparam Q=P; initial begin:b reg P; reg a[0:Q]; end');
    expect(diagnostics.filter((item) => item.code === 'nonconstant-expression' || item.code === 'parameter-cycle')).toEqual([]);
  });

  it.each([
    ['integer i; generate for(i=0;i<2;i=i+1) begin:g wire b; end endgenerate', 'generate-loop-variable', 'i'],
    ['genvar i; initial i=0;', 'invalid-genvar-use', 'i'],
    ['genvar i; assign y=i;', 'invalid-genvar-use', 'i']
  ])('enforces genvar context: %s', (source, code, marked) => {
    const { document, diagnostics } = check(source);
    const error = diagnostics.find((item) => item.code === code);
    expect(error?.severity).toBe(DiagnosticSeverity.Error);
    expect(document.getText(error!.range)).toBe(marked);
  });

  it.each(['assign i=1;', 'initial i=1;'])('treats the elaborated loop value as read-only: %s', (assignment) => {
    const { document, diagnostics } = check(`genvar i; for(i=0;i<2;i=i+1) begin:g ${assignment} end`);
    const error = diagnostics.find((item) => item.code === 'invalid-assignment-target');
    expect(error?.severity).toBe(DiagnosticSeverity.Error);
    expect(document.getText(error!.range)).toBe('i');
  });
});

describe('concatenation widths and replication context', () => {
  it.each([
    ['{1,2}', 'indefinite-concatenation-width', '1'],
    ["{(1+2),1'b0}", 'indefinite-concatenation-width', '(1+2)'],
    ["{(1'b1+1),1'b0}", 'indefinite-concatenation-width', "(1'b1+1)"],
    ["{0{1'b0}}", 'zero-width-concatenation', "{0{1'b0}}"],
    ["{{0{1'b0}}}", 'zero-width-concatenation', "{{0{1'b0}}}"],
    ["{-1{1'b0}}", 'invalid-replication-count', '-1']
  ])('rejects %s', (expression, code, marked) => {
    const { document, diagnostics } = check(`assign y=${expression};`);
    const error = diagnostics.find((item) => item.code === code);
    expect(error?.severity).toBe(DiagnosticSeverity.Error);
    expect(document.getText(error!.range)).toBe(marked);
  });

  it.each(["{1'b1,{0{1'b0}}}", "{(1==2),1'b0}", "{(1'b1<<1),1'b0}", "{2'd1,2'd2}", "{P,1'b0}"])('accepts %s', (expression) => {
    const { diagnostics } = check(`parameter P=1; assign y=${expression};`);
    expect(diagnostics.filter((item) => item.severity === DiagnosticSeverity.Error)).toEqual([]);
  });

  it.each([
    ['`define N 1\nassign y={`N,1\'b0};', 'indefinite-concatenation-width', '`N'],
    ['`define Z {0{1\'b0}}\nassign y=`Z;', 'zero-width-concatenation', '`Z'],
    ['`define Z {P{1\'b0}}\nlocalparam P=1; if(1) begin:g localparam P=0; assign y=`Z; end', 'zero-width-concatenation', '`Z'],
    ['localparam P=0; localparam Q=P; if(1) begin:g localparam P=1; assign y={Q{1\'b0}}; end', 'zero-width-concatenation', '{Q{1\'b0}}']
  ])('uses expansion and definition bindings: %s', (source, code, marked) => {
    const { document, diagnostics } = check(source);
    const error = diagnostics.find((item) => item.code === code);
    expect(error?.severity).toBe(DiagnosticSeverity.Error);
    expect(document.getText(error!.range)).toBe(marked);
  });

  it.each([
    '`define N 2\'d1\nassign y={`N,1\'b0};',
    '`define Z {0{1\'b0}}\nassign y={1\'b1,`Z};',
    '`define Z {P{1\'b0}}\nlocalparam P=0; if(1) begin:g localparam P=1; assign y=`Z; end',
    'localparam P=1; localparam Q=P; if(1) begin:g localparam P=-1; assign y={Q{1\'b0}}; end'
  ])('does not confuse macro use scope with parameter definition scope: %s', (source) => {
    expect(check(source).diagnostics.filter((item) => item.severity === DiagnosticSeverity.Error)).toEqual([]);
  });
});
