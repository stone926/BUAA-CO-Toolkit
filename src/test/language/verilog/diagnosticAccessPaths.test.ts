// @index diagnostic-access-path-tests — Direction/type/region/constant regression matrix
import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let version = 1;
const settings = mergeCoSettings({ verilog: { lint: { courseRules: false } } });
function document(text: string): TextDocument { return TextDocument.create(`test://region/${version++}.v`, 'verilog', version, text); }
function diagnostics(text: string) { return getVerilogDiagnostics(document(text), settings); }
function codes(text: string) { return diagnostics(text).map((diagnostic) => diagnostic.code); }

describe('Verilog direction and lvalue type matrix', () => {
  it.each([
    ['input', 8, 4, false], ['input', 4, 8, true],
    ['output', 8, 4, true], ['output', 4, 8, false],
    ['inout', 8, 4, true], ['inout', 4, 8, true], ['output', 8, 8, false]
  ] as const)('%s port %i connected to %i bits reports truncation=%s', (direction, port, bus, mismatch) => {
    const child = `module child(${direction} [${port - 1}:0] p); endmodule`;
    const top = `module top; wire [${bus - 1}:0] bus; child u(bus); endmodule`;
    expect(codes(`${child}\n${top}`).includes('port-width-mismatch')).toBe(mismatch);
    const index = new VerilogWorkspaceIndex();
    const topDocument = document(top);
    index.updateDocument(document(child), settings);
    index.updateDocument(topDocument, settings);
    expect(getVerilogDiagnostics(topDocument, settings, index).some((diagnostic) => diagnostic.code === 'port-width-mismatch')).toBe(mismatch);
  });

  it.each([
    'parameter P=0; initial P=1;', 'localparam P=0; assign P=1;',
    'wire x; initial x=1;', 'reg x; assign x=1;', 'output reg x; assign x=1;'
  ])('rejects declaration-incompatible assignment: %s', (source) => {
    const hit = diagnostics(`module m; ${source} endmodule`).find((diagnostic) => diagnostic.code === 'invalid-assignment-target');
    expect(hit?.severity).toBe(DiagnosticSeverity.Error);
  });

  it('requires an output connection net lvalue', () => {
    expect(codes("module child(output y); endmodule module top; child u(1'b0); endmodule")).toContain('invalid-assignment-target');
    expect(codes('module child(output y); endmodule module top; reg r; child u(r); endmodule')).toContain('invalid-assignment-target');
  });

  it('resolves shadowed procedural variables by lexical scope for width and type', () => {
    const result = codes("module m; wire [7:0] x; initial begin : local_scope reg [31:0] x; x=32'hffffffff; end endmodule");
    expect(result).not.toContain('invalid-assignment-target');
    expect(result).not.toContain('width-mismatch');
  });
});

describe('Verilog driver access path matrix', () => {
  it('binds object macro lvalues at the invocation and preserves their regions', () => {
    expect(codes('`define BITS r[3:0]\nmodule m; reg [7:0] r; always @* `BITS=0; always @* r[3:0]=1; endmodule')).toContain('multi-driver');
    expect(codes('`define BITS r[3:0]\nmodule m; reg [7:0] r; always @* `BITS=0; always @* r[7:4]=1; endmodule')).not.toContain('multi-driver');
    expect(codes('`define PAIR {a,b}\nmodule m; reg a,b; always @* `PAIR=0; always @* b=1; endmodule')).toContain('multi-driver');
    expect(codes('`define DEST r\nmodule m; wire r; initial `DEST=0; endmodule')).toContain('invalid-assignment-target');
    expect(codes('`define DEST r\nmodule m; wire r; initial begin : inner reg r; `DEST=0; end endmodule')).not.toContain('invalid-assignment-target');
    expect(codes('`define BITS(v) v[3:0]\nmodule m; reg [7:0] r; initial `BITS(r)=0; endmodule')).not.toContain('invalid-assignment-target');
    expect(codes('`define BAD 1\nmodule m; initial `BAD=0; endmodule')).toContain('invalid-assignment-target');
  });

  it('does not alias hierarchical writes to the instance name', () => {
    expect(codes('module child; reg x,y; endmodule module m; child u(); always @* u.x=1; always @* u.y=0; endmodule')).not.toContain('multi-driver');
  });

  it('evaluates selected regions in the lexical scope of the write', () => {
    expect(codes('module m; localparam I=0; reg [7:0] x; always @* begin : a localparam I=1; x[I]=1; end always @* x[0]=0; endmodule')).not.toContain('multi-driver');
  });
  it.each([
    ['wire [7:0] x; assign x[3:0]=0; assign x[7:4]=0;', false],
    ['wire [7:0] x; assign x[3:0]=0; assign x[4:2]=0;', true],
    ['reg [7:0] x; always @* x[3:0]=0; always @* x[7:4]=0;', false],
    ['reg [7:0] x; always @* x[3:0]=0; always @* x[4:2]=0;', true],
    ['reg [7:0] mem[0:3]; always @* mem[0]=0; always @* mem[1]=0;', false],
    ['reg [7:0] mem[0:3]; always @* mem[0][3:0]=0; always @* mem[0][4:2]=0;', true],
    ['reg [7:0] mem[0:3][0:3]; always @* mem[0][0]=0; always @* mem[0][1]=0;', false],
    ['wire x=0; assign x=1;', true], ['wire x; and g(x, 1, 1); assign x=1;', true],
    ['wire [1:0] x; buf g(x[0], x[1], 1); assign x[1]=0;', true],
    ['tri x; assign x=0; assign x=1;', false], ['inout x; assign x=0; assign x=1;', false]
  ] as const)('preserves selected regions: %s', (source, conflict) => {
    expect(codes(`module m; ${source} endmodule`).includes('multi-driver')).toBe(conflict);
  });

  it.each([
    ['{x[3:2],x[1:0]}', 'x[7:4]', false], ['{x[3:2],x[1:0]}', 'x[4:1]', true]
  ] as const)('includes instance output concatenation %s / %s', (first, second, conflict) => {
    const child = 'module child(output [3:0] y); endmodule';
    const top = `module top; wire [7:0] x; child a(${first}); child b(${second}); endmodule`;
    expect(codes(`${child}\n${top}`).includes('multi-driver')).toBe(conflict);
    const index = new VerilogWorkspaceIndex();
    const topDocument = document(top);
    index.updateDocument(document(child), settings);
    index.updateDocument(topDocument, settings);
    expect(getVerilogDiagnostics(topDocument, mergeCoSettings({}), index).some((diagnostic) => diagnostic.code === 'multi-driver')).toBe(conflict);
  });
});

describe('Verilog array bounds, legal constants and directive state', () => {
  it.each(['mem[4][0]', 'mem[0][8]', 'mem[0][0][8]'])('checks each selected dimension in %s', (expression) => {
    expect(codes(`module m; reg [7:0] mem[0:3][0:7]; wire [7:0] y=${expression}; endmodule`)).toContain('select-out-of-range');
  });
  it('checks arrays and ranges inside later procedural assignments', () => {
    expect(codes('module m; reg [7:0] mem[0:3]; reg x; initial begin x=0; x=mem[4][8]; end endmodule')).toContain('select-out-of-range');
  });
  it('rejects reversed and zero-width part selects', () => {
    expect(codes('module m(input [7:0] a); wire [3:0] b=a[0:3]; endmodule')).toContain('select-direction-mismatch');
    expect(codes('module m(input [7:0] a); wire b=a[0+:0]; endmodule')).toContain('invalid-select-width');
  });
  it('accepts four-state literals and constant functions as parameter overrides', () => {
    expect(codes(`module child #(parameter P=0)(); endmodule
      module top; function integer f; input integer n; begin f=n+1; end endfunction
      child #(4'bxz01) a(); child #(f(2)) b(); endmodule`)).not.toContain('parameter-not-constant');
  });
  it('still rejects runtime signal parameter overrides', () => {
    expect(codes('module child #(parameter P=0)(); endmodule module top(input x); child #(x) u(); endmodule')).toContain('parameter-not-constant');
  });
  it('restores default_nettype wire at its directive position', () => {
    const hits = diagnostics('`default_nettype none\nmodule a(p); input p; endmodule\n`default_nettype wire\nmodule b(p); input p; endmodule').filter((diagnostic) => diagnostic.code === 'explicit-port-wire');
    expect(hits).toHaveLength(1);
    expect(hits[0].range.start.line).toBe(1);
  });
});
