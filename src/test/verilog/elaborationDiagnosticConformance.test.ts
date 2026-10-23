import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { Range } from 'vscode-languageserver-types';
import { mergeCoSettings } from '../../language/common/settings';
import { getVerilogDiagnostics } from '../../language/verilog/diagnosticProvider';
import { VerilogWorkspaceIndex } from '../../language/verilog/workspaceIndex';
import { buildIverilogEnvironment, buildIverilogRuntimeArgs, resolveIverilogRuntime } from '../../verilog/iverilogRuntime';

const runtime = resolveIverilogRuntime(path.resolve(__dirname, '../../..'));
const available = fs.existsSync(runtime.iverilogPath);
const settings = mergeCoSettings({ verilog: { lint: { courseRules: false } } });
const moduleWith = (body: string) => `module m(input [7:0] n,a, output [7:0] y); ${body} endmodule`;
const vectors = [
  ['packed range', moduleWith('wire [[|n|]:0] b;'), moduleWith('wire [-1:-8] b;'), 'nonconstant-expression', 'n'],
  ['unpacked dimension', moduleWith('reg b[0:[|n|]];'), moduleWith('reg b[0:7];'), 'nonconstant-expression', 'n'],
  ['parameter initializer', moduleWith('localparam P=[|n|];'), moduleWith("localparam P=4'bx1z0;"), 'nonconstant-expression', 'n'],
  ['part-select', moduleWith('assign y=a[[|n|]:0];'), moduleWith('assign y=a[n];'), 'nonconstant-expression', 'n'],
  ['indexed select width', moduleWith('assign y=a[0+:[|n|]];'), moduleWith('assign y=a[n+:2];'), 'nonconstant-expression', 'n'],
  ['replication count', moduleWith('assign y={[|n|]{a}};'), moduleWith("assign y={2{4'bx1z0}};"), 'nonconstant-expression', 'n'],
  ['instance range', moduleWith('leaf u[[|n|]:0]();'), moduleWith('leaf u[1:0]();'), 'nonconstant-expression', 'n'],
  ['generate if', moduleWith('generate if([|n|]) begin:g wire b; end endgenerate'), moduleWith('generate if(1) begin:g wire b; end endgenerate'), 'nonconstant-expression', 'n'],
  ['generate case', moduleWith('generate case([|n|]) 0:begin:g wire b; end endcase endgenerate'), moduleWith('generate case(0) 0:begin:g wire b; end endcase endgenerate'), 'nonconstant-expression', 'n'],
  ['generate loop condition', moduleWith('genvar i; for(i=0;[|i<n|];i=i+1) begin:g wire b; end'), moduleWith('genvar i; for(i=0;i<8;i=i+1) begin:g assign y[i]=a[i]; end'), 'nonconstant-expression', 'i<n'],
  ['parameter cycle', moduleWith('parameter A=B; parameter B=[|A|];'), moduleWith('parameter A=1; parameter B=A;'), 'parameter-cycle', 'A'],
  ['generate loop variable', moduleWith('integer i; for([|i|]=0;i<2;i=i+1) begin:g wire b; end'), moduleWith('genvar i; for(i=0;i<2;i=i+1) begin:g wire b; end'), 'generate-loop-variable', 'i'],
  ['genvar procedural assignment', moduleWith('genvar i; initial [|i|]=0;'), moduleWith('integer i; initial i=0;'), 'invalid-genvar-use', 'i'],
  ['genvar runtime reference', moduleWith('genvar i; assign y=[|i|];'), moduleWith('genvar i; for(i=0;i<8;i=i+1) begin:g assign y[i]=i; end'), 'invalid-genvar-use', 'i'],
  ['unsized concatenation', moduleWith('assign y={[|1|],2};'), moduleWith("assign y={2'd1,2'd2};"), 'indefinite-concatenation-width', '1'],
  ['zero-width result', moduleWith("assign y=[|{0{1'b0}}|];"), moduleWith("assign y={1'b1,{0{1'b0}}};"), 'zero-width-concatenation', "{0{1'b0}}"],
  ['duplicate wire', 'module m; wire a; wire a; endmodule', 'module m; wire a; initial begin:b reg a; a=0; end endmodule', 'duplicate-declaration', 'a'],
  ['duplicate reg', 'module m; reg a; reg a; endmodule', 'module m; reg a; reg b; endmodule', 'duplicate-declaration', 'a'],
  ['duplicate parameter', 'module m; parameter A=0; parameter A=1; endmodule', 'module m; parameter A=0; parameter B=1; endmodule', 'duplicate-declaration', 'A'],
  ['wire/reg conflict', 'module m; wire a; reg a; endmodule', 'module m; wire a; reg b; endmodule', 'duplicate-declaration', 'a'],
  ['duplicate instance', 'module m; leaf u(); leaf u(); endmodule', 'module m; leaf u(); leaf v(); endmodule', 'duplicate-declaration', 'u'],
  ['duplicate block', 'module m; initial begin:b end initial begin:b end endmodule', 'module m; initial begin:b end initial begin:c end endmodule', 'duplicate-declaration', 'b'],
  ['duplicate port', 'module m(input a,input a); endmodule', 'module m(input a,input b); endmodule', 'duplicate-declaration', 'a'],
  ['conflicting directions', 'module m(a); input a; output a; endmodule', 'module m(a,y); input a; output y; wire y; assign y=a; endmodule', 'conflicting-port-direction', 'a'],
  ['missing port direction', 'module m(a); endmodule', 'module m(a); input a; endmodule', 'missing-port-direction', 'a']
];
vectors.push(
  ['generated loop parameter is read-only', moduleWith('genvar i; for(i=0;i<2;i=i+1) begin:g assign i=1; end'), moduleWith('genvar i; for(i=0;i<8;i=i+1) assign y[i]=i;'), 'invalid-assignment-target', 'i'],
  ['generate case labels', moduleWith('case(1) n:begin:g wire b; end endcase'), moduleWith('case(1) 1:begin:g wire b; end endcase'), 'nonconstant-expression', 'n'],
  ['macro concatenation width', '`define N 1\n' + moduleWith('assign y={`N,1\'b0};'), '`define N 2\'d1\n' + moduleWith('assign y={`N,1\'b0};'), 'indefinite-concatenation-width', '`N'],
  ['macro zero width', '`define Z {0{1\'b0}}\n' + moduleWith('assign y=`Z;'), '`define Z {0{1\'b0}}\n' + moduleWith('assign y={1\'b1,`Z};'), 'zero-width-concatenation', '`Z'],
  ['parameter binds at definition', moduleWith('localparam P=0; localparam Q=P; if(1) begin:g localparam P=1; assign y={Q{1\'b0}}; end'), moduleWith('localparam P=1; localparam Q=P; if(1) begin:g localparam P=-1; assign y={Q{1\'b0}}; end'), 'zero-width-concatenation', '{Q{1\'b0}}']
);

describe.skipIf(!available)('audited elaboration diagnostics against real bundled Icarus', () => {
  let directory: string;
  beforeAll(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'CO elaboration 语义 ')); });
  afterAll(() => {
    if (directory) {
      expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  function check(source: string) {
    const fullSource = `module leaf; endmodule\n${source}`;
    const file = path.join(directory, '语义 with spaces.v');
    fs.writeFileSync(file, fullSource);
    const document = TextDocument.create(URI.file(file).toString(), 'verilog', 1, fullSource);
    const index = new VerilogWorkspaceIndex({ workspaceComplete: true });
    index.updateDocument(document, settings);
    const diagnostics = getVerilogDiagnostics(document, settings, index);
    const result = spawnSync(runtime.iverilogPath, [...buildIverilogRuntimeArgs(runtime), '-g2005', '-tnull', '-i', file], {
      cwd: directory, env: buildIverilogEnvironment(runtime), encoding: 'utf8', timeout: 5000
    });
    expect(result.error).toBeUndefined();
    return { document, diagnostics, result };
  }
  it.each(vectors)('%s agrees on rejection, source location and legal neighbor', (_name, bad, good, code, marked) => {
    const markerStart = bad.indexOf('[|'), markerEnd = bad.indexOf('|]');
    const rejected = check(bad.replace('[|', '').replace('|]', ''));
    expect(rejected.result.status, rejected.result.stderr).not.toBe(0);
    const diagnostic = rejected.diagnostics.find((item) => item.code === code);
    expect(diagnostic, JSON.stringify(rejected.diagnostics)).toBeDefined();
    expect(diagnostic?.severity).toBe(1);
    expect(rejected.document.getText(diagnostic!.range)).toBe(marked);
    if (markerStart >= 0) {
      const prefix = 'module leaf; endmodule\n'.length;
      expect(diagnostic!.range).toEqual(Range.create(rejected.document.positionAt(prefix + markerStart), rejected.document.positionAt(prefix + markerEnd - 2)));
    }
    const accepted = check(good);
    expect(accepted.result.status, accepted.result.stderr).toBe(0);
    expect(accepted.diagnostics.filter((item) => item.severity === 1)).toEqual([]);
  });
  it.each([
    'for(genvar i=0;i<8;i=i+1) begin:g assign y[i]=a[i]; end',
    'genvar i,j; for(i=0;i<2;i=i+1) for(j=0;j<2;j=j+1) assign y[2*i+j]=i+j;',
    'genvar i; for(i=0;i<2;i=i+1) begin:g function integer f(input x); f=x+i; endfunction localparam P=f(1); wire [P:0] b; end',
    'genvar i; for(i=0;i<2;i=i+1) begin:g initial begin:b integer i; i=1; end end'
  ])('preserves legal elaborated scopes: %s', (source) => {
    const accepted = check(moduleWith(source));
    expect(accepted.result.status, accepted.result.stderr).toBe(0);
    expect(accepted.diagnostics.filter((item) => item.severity === 1)).toEqual([]);
  });
});
