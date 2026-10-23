// @index builtin-diagnostic-conformance — Real bundled Icarus differential checks for audited diagnostic gaps.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { mergeCoSettings } from '../../language/common/settings';
import { getVerilogDiagnostics } from '../../language/verilog/diagnosticProvider';
import { VerilogWorkspaceIndex } from '../../language/verilog/workspaceIndex';
import { runProcessCore } from '../../processCore';
import {
  buildIverilogEnvironment, buildIverilogIncludeArgs, buildIverilogRuntimeArgs,
  preflightIverilogRuntime, type IverilogRuntime
} from '../../verilog/iverilogRuntime';

interface Fixture {
  name: string;
  /** [|...|] explicitly marks the expected diagnostic span; [||] marks recovery insertion. */
  bad: string;
  good: string;
  code: string;
}

const fixtures: Fixture[] = [
  { name: 'constant function captures its initializing parameter', code: 'parameter-cycle',
    bad: 'module m; parameter P=[|f|](1); function integer f(input x); f=P; endfunction endmodule',
    good: 'module m; parameter P=f(1); function integer f(input P); f=P; endfunction endmodule' },
  { name: 'nested constant-function capture creates parameter cycle', code: 'parameter-cycle',
    bad: 'module m; parameter P=[|f|](1); function integer f(input x); f=g(x); endfunction function integer g(input x); g=P; endfunction endmodule',
    good: 'module m; parameter P=f(1); function integer f(input x); f=g(x); endfunction function integer g(input P); g=P; endfunction endmodule' },
  { name: 'unknown formal branch still captures recursive parameter', code: 'parameter-cycle',
    bad: 'module m; parameter P=[|f|](0); function integer f(input x); if(x) f=P; else f=1; endfunction endmodule',
    good: 'module m; parameter P=f(0); function integer f(input x); if(0) f=P; else f=1; endfunction endmodule' },
  { name: 'runtime argument to constant conversion', code: 'nonconstant-expression',
    bad: 'module m(input [7:0] n); localparam P=[|$rtoi(n)|]; endmodule',
    good: 'module m; localparam P=$rtoi(2.5); wire [P:0] a; endmodule' },
  { name: 'runtime system function in parameter', code: 'nonconstant-expression',
    bad: 'module m; localparam P=[|$random()|]; endmodule',
    good: 'module m; localparam P=$pow(2,3); wire [P:0] a; endmodule' },
  { name: 'required if condition', code: 'syntax-malformed-if',
    bad: 'module m; reg a; initial if([|)|] a=0; endmodule',
    good: 'module m; reg a; initial if(1) a=0; endmodule' },
  { name: 'required case expression', code: 'syntax-malformed-case',
    bad: 'module m; reg a; initial case([|)|] 0:a=0; endcase endmodule',
    good: 'module m; reg a; initial case(0) 0:a=0; endcase endmodule' },
  { name: 'required delay expression', code: 'syntax-malformed-delay',
    bad: 'module m; reg a; initial #([|)|] a=0; endmodule',
    good: 'module m; reg a; initial #(1) a=0; endmodule' },
  { name: 'declaration range endpoint', code: 'syntax-malformed-declaration',
    bad: 'module m; wire [[||]:0] a; endmodule',
    good: 'module m; wire [-1:-8] a; endmodule' },
  { name: 'module parameter header range endpoint', code: 'syntax-malformed-declaration',
    bad: 'module m #(parameter [[||]:0] A=1)(); endmodule',
    good: 'module m #(parameter [-1:-8] A=1)(); endmodule' },
  { name: 'wait requires condition', code: 'syntax-malformed-wait',
    bad: 'module m; reg a; initial wait([|)|] a=1; endmodule',
    good: 'module m; reg a; initial wait(a) a=1; endmodule' },
  { name: 'mintypmax requires typical expression', code: 'syntax-malformed-if',
    bad: 'module m; reg a; initial if((1:[||]:3)) a=1; endmodule',
    good: 'module m; reg a; initial if((1:2:3)) a=1; endmodule' },
  { name: 'mintypmax requires maximum in range endpoint', code: 'syntax-malformed-declaration',
    bad: 'module m; wire [(1:2:[||]):0] a; endmodule',
    good: 'module m; wire [(1:2:3):0] a; endmodule' },
  { name: 'mintypmax requires maximum inside delay arithmetic', code: 'syntax-malformed-delay',
    bad: 'module m; reg a; initial #(1+(1:2:[||])) a=1; endmodule',
    good: 'module m; reg a; initial #(1+(1:2:3)) a=1; endmodule' },
  { name: 'consistent port connection form', code: 'syntax-malformed-instance',
    bad: 'module m(input a,b); leaf u(.a(a), [|b|]); endmodule',
    good: 'module m(input a,b); leaf u(.a(a), .b(b)); endmodule' },
  { name: 'consistent parameter override form', code: 'syntax-malformed-instance',
    bad: 'module m(input a,b); leaf #(.A(1), [|2|]) u(a,b); endmodule',
    good: 'module m(input a,b); leaf #(.A(1), .B(2)) u(a,b); endmodule' },
  { name: 'Verilog-2005 required for condition', code: 'syntax-malformed-for',
    bad: 'module m; integer i; initial for(i=0;[|;|]i=i+1); endmodule',
    good: 'module m; integer i; initial for(i=0;i<2;i=i+1); endmodule' },
  { name: 'function too few arguments', code: 'subroutine-argument-count',
    bad: 'module m(input a,output y); function f(input x,input z); f=x&z; endfunction assign y=[|f|](a); endmodule',
    good: 'module m(input a,output y); function f(input x,input z); f=x&z; endfunction assign y=f(a,a); endmodule' },
  { name: 'function too many arguments', code: 'subroutine-argument-count',
    bad: 'module m(input a,output y); function f(input x,input z); f=x&z; endfunction assign y=[|f|](a,a,a); endmodule',
    good: 'module m(input a,output y); function f(input x,input z); f=x&z; endfunction assign y=f(a,a); endmodule' },
  { name: 'task too few arguments', code: 'subroutine-argument-count',
    bad: 'module m; reg y; task t; input a,b; y=a&b; endtask initial [|t|](1); endmodule',
    good: 'module m; reg y; task t; input a,b; y=a&b; endtask initial t(1,1); endmodule' },
  { name: 'task output actual must be writable', code: 'invalid-assignment-target',
    bad: "module m; task t; output reg x; x=1; endtask initial t([|1'b0|]); endmodule",
    good: 'module m; reg a; task t; output reg x; x=1; endtask initial t(a); endmodule' },
  { name: 'function delay restriction', code: 'function-timing-control',
    bad: 'module m; function f; input a; [|#|]1 f=a; endfunction endmodule',
    good: 'module m; function f; input a; f=a; endfunction endmodule' },
  { name: 'function event restriction', code: 'function-timing-control',
    bad: 'module m; function f; input a; [|@|](a) f=a; endfunction endmodule',
    good: 'module m; function f; input a; f=a; endfunction endmodule' },
  { name: 'function nonblocking restriction', code: 'function-nonblocking-assignment',
    bad: 'module m; function f; input a; f[|<=|]a; endfunction endmodule',
    good: 'module m; function f; input a; f=(a<=1); endfunction endmodule' },
  { name: 'Verilog-2005 function formal direction', code: 'function-formal-direction',
    bad: 'module m; function f; input a; [|output|] z; f=a; endfunction endmodule',
    good: 'module m; function f; input a,z; f=a&z; endfunction endmodule' },
  { name: 'Verilog-2005 function requires input', code: 'function-missing-input',
    bad: 'module m; function [|f|]; f=1; endfunction endmodule',
    good: 'module m; function f; input a; f=a; endfunction endmodule' },
  { name: 'Verilog-2005 function requires body', code: 'subroutine-missing-body',
    bad: 'module m; function [|f|]; input a; endfunction endmodule',
    good: 'module m; function f; input a; f=a; endfunction endmodule' },
  { name: 'Verilog-2005 task requires body', code: 'subroutine-missing-body',
    bad: 'module m; task [|t|]; input a; endtask endmodule',
    good: 'module m; task t; input a; begin end endtask endmodule' },
  { name: 'unknown function binding', code: 'unknown-subroutine',
    bad: 'module m; reg y; initial y=[|missing|](1); endmodule',
    good: 'module m; reg y; function f(input a); f=a; endfunction initial y=f(1); endmodule' },
  { name: 'unknown task binding', code: 'unknown-subroutine',
    bad: 'module m; initial [|missing|](1); endmodule',
    good: 'module m; task t(input a); begin end endtask initial t(1); endmodule' },
  { name: 'orphan endif', code: 'preprocessor-conditional-mismatch',
    bad: '[|`endif|]\nmodule m; endmodule',
    good: '`ifdef FLAG\n`endif\nmodule m; endmodule' },
  { name: 'orphan else', code: 'preprocessor-conditional-mismatch',
    bad: '[|`else|]\nmodule m; endmodule',
    good: '`ifdef FLAG\n`else\n`endif\nmodule m; endmodule' },
  { name: 'unclosed conditional', code: 'preprocessor-unclosed-conditional',
    bad: '[|`ifdef|] FLAG\nmodule m; endmodule',
    good: '`ifdef FLAG\n`endif\nmodule m; endmodule' },
  { name: 'timescale multiplier', code: 'preprocessor-invalid-timescale',
    bad: '`timescale [|3|]ns/1ps\nmodule m; endmodule',
    good: '`timescale 100ns/1ps\nmodule m; endmodule' },
  { name: 'default net type', code: 'preprocessor-invalid-default-nettype',
    bad: '`default_nettype [|bananas|]\nmodule m; endmodule',
    good: '`default_nettype none\nmodule m; endmodule' },
  { name: 'define requires name', code: 'preprocessor-missing-argument',
    bad: '[|`define|]\nmodule m; endmodule',
    good: '`define EMPTY\nmodule m; endmodule' },
  { name: 'function macro too few arguments', code: 'preprocessor-macro-arity',
    bad: '`define F(a,b) ((a)+(b))\nmodule m; wire y; assign y=[|`F|](1); endmodule',
    good: '`define F(a,b) ((a)+(b))\nmodule m; wire y; assign y=`F(1,2); endmodule' },
  { name: 'function macro too many arguments', code: 'preprocessor-macro-arity',
    bad: '`define F(a,b) ((a)+(b))\nmodule m; wire y; assign y=[|`F|](1,2,3); endmodule',
    good: '`define F(a,b) ((a)+(b))\nmodule m; wire y; assign y=`F(1,2); endmodule' },
  { name: 'undefined macro operand', code: 'preprocessor-undefined-macro',
    bad: 'module m; wire y; assign y=[|`MISSING|]; endmodule',
    good: '`define VALUE 1\nmodule m; wire y; assign y=`VALUE; endmodule' }
];

const legalRegressions = [
  ['named function body sharing its return name', 'module m; function f(input a); begin:f f=a; end endfunction endmodule'],
  ['ANSI function', 'module m(input a,output y); function f(input x,input z); f=x&z; endfunction assign y=f(a,a); endmodule'],
  ['ANSI integer function', 'module m(input a,output y); function integer f(input integer x,input integer z); f=x&z; endfunction assign y=f(a,a); endmodule'],
  ['implicit task output variable', 'module m; reg a; task t; output x; x=1; endtask initial t(a); endmodule'],
  ['writable old-style function input', 'module m; function f; input a; begin a=1; f=a; end endfunction endmodule'],
  ['legal task delay', 'module m; reg a; task t; output x; #1 x=1; endtask initial t(a); endmodule'],
  ['inactive invalid macro invocation', '`define F(a,b) ((a)+(b))\n`ifdef OFF\n`F(1)\n`endif\nmodule m; endmodule'],
  ['wait followed by assignment', 'module m; reg a; initial wait(a) a=1; endmodule'],
  ['wait followed by empty statement', 'module m; reg a; initial wait(a); endmodule'],
  ['wait followed by begin block', 'module m; reg a; initial wait(a) begin a=1; end endmodule'],
  ['inherited and repeated parameter header declarations', 'module m #(parameter [3:0] A=1,B=2,parameter integer C=3)(); endmodule'],
  ['parenthesized mintypmax condition', 'module m; reg a; initial if((1:2:3)) a=1; endmodule'],
  ['parenthesized mintypmax declaration range', 'module m; wire [(1:2:3):0] a; endmodule'],
  ['nested mintypmax delay arithmetic', 'module m; reg a; initial #(1+(1:2:3)) a=1; endmodule'],
  ['mintypmax parameter header initializer', 'module m #(parameter A=(1:2:3))(); endmodule'],
  ['empty actual macro argument', '`define F(a,b) (1 a + b)\nmodule m; wire y; assign y=`F(,1); endmodule'],
  ['empty macro in condition', '`define EMPTY\nmodule m; reg a; initial if(`EMPTY 1) a=1; endmodule'],
  ['constant ceil system function', 'module m; localparam P=$ceil(2.5); wire [P:0] a; endmodule'],
  ['constant rtoi inside user function', 'module m; function integer f(input x); f=$rtoi(2.5); endfunction localparam P=f(1); wire [P:0] a; endmodule'],
  ['constant ceil inside user function', 'module m; function integer f(input x); f=$ceil(2.5); endfunction localparam P=f(1); wire [P:0] a; endmodule'],
  ['constant pow inside user function', 'module m; function integer f(input x); f=$pow(2,3); endfunction localparam P=f(1); wire [P:0] a; endmodule'],
  ['function local variable shadows initializing parameter', 'module m; parameter P=f(1); function integer f(input x); reg P; begin P=x; f=P; end endfunction endmodule'],
  ['function local parameter shadows initializing parameter', 'module m; parameter P=f(1); function integer f(input x); localparam P=2; f=P+x; endfunction endmodule'],
  ['acyclic function parameter capture', 'module m; parameter Q=2; parameter P=f(1); function integer f(input x); f=Q+x; endfunction endmodule'],
  ['inactive captured parameter branch', 'module m; parameter P=f(1); function integer f(input x); if(0) f=P; else f=1; endfunction endmodule'],
  ['resolved parameter type dependency', 'module m; parameter B=3; parameter [B:0] A=1; endmodule'],
  ['parameter-resolved inactive function branch', 'module m; localparam OFF=0; parameter P=f(1); function integer f(input x); if(OFF) f=P; else f=1; endfunction endmodule'],
  ['conservative unknown type-query system function', 'module m(input [7:0] x); localparam P=$bits(x); wire [P:0] a; endmodule']
];

let directory: string;
let runtime: IverilogRuntime;
let sequence = 0;
const settings = mergeCoSettings({ verilog: { lint: { courseRules: false } } });
const leafSource = 'module leaf #(parameter A=1,B=2)(input a,b); endmodule';

beforeAll(async () => {
  ({ runtime } = await preflightIverilogRuntime(path.resolve(__dirname, '../../..')));
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'CO 内置 差分验收 '));
  await fs.writeFile(path.join(directory, '叶 模块.v'), leafSource, 'utf8');
});

afterAll(async () => {
  if (directory) {
    expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function annotatedSource(marked: string) {
  const start = marked.indexOf('[|');
  const end = marked.indexOf('|]', start + 2);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThanOrEqual(start + 2);
  return { source: marked.slice(0, start) + marked.slice(start + 2, end) + marked.slice(end + 2),
    start, end: end - 2 };
}

async function check(source: string) {
  const sourcePath = path.join(directory, `用例 ${++sequence}.v`);
  const leafPath = path.join(directory, '叶 模块.v');
  await fs.writeFile(sourcePath, source, 'utf8');
  const document = TextDocument.create(URI.file(sourcePath).toString(), 'verilog', 1, source);
  const index = new VerilogWorkspaceIndex({ workspaceComplete: true });
  index.updateDocument(TextDocument.create(URI.file(leafPath).toString(), 'verilog', 1, leafSource), settings);
  index.updateDocument(document, settings);
  const diagnostics = getVerilogDiagnostics(document, settings, index);
  const compiler = await runProcessCore(runtime.iverilogPath, [
    ...buildIverilogRuntimeArgs(runtime), '-g2005', '-tnull', '-i',
    ...buildIverilogIncludeArgs(directory, [leafPath, sourcePath]), leafPath, sourcePath
  ], { cwd: directory, env: buildIverilogEnvironment(runtime), timeoutMs: 5_000,
    maxStdoutBytes: 128 * 1024, maxStderrBytes: 128 * 1024 });
  expect(compiler.timedOut, compiler.stderr).toBe(false);
  expect(compiler.exitCode, compiler.stderr).not.toBeNull();
  return { document, diagnostics, compiler };
}

describe('real bundled Icarus and indexed built-in diagnostic conformance', () => {
  it.each(fixtures)('rejects $name with an exact built-in diagnostic', async ({ bad, code }) => {
    const { source, start, end } = annotatedSource(bad);
    const { document, diagnostics, compiler } = await check(source);
    expect(compiler.ok, compiler.stderr).toBe(false);
    expect(diagnostics, compiler.stderr).toContainEqual(expect.objectContaining({
      code, severity: DiagnosticSeverity.Error,
      range: Range.create(document.positionAt(start), document.positionAt(end))
    }));
  });

  it.each(fixtures)('accepts the adjacent legal case for $name', async ({ good }) => {
    const { diagnostics, compiler } = await check(good);
    expect(compiler.ok, compiler.stderr).toBe(true);
    expect(diagnostics.filter((issue) => issue.severity === DiagnosticSeverity.Error)).toEqual([]);
  });

  it.each(legalRegressions)('preserves legal %s', async (_name, source) => {
    const { diagnostics, compiler } = await check(source);
    expect(compiler.ok, compiler.stderr).toBe(true);
    expect(diagnostics.filter((issue) => issue.severity === DiagnosticSeverity.Error)).toEqual([]);
  });

  it('keeps a harmless undefined macro as a warning when Icarus accepts its empty expansion', async () => {
    const source = 'module m; `OPTIONAL endmodule';
    const { document, diagnostics, compiler } = await check(source);
    expect(compiler.ok, compiler.stderr).toBe(true);
    expect(diagnostics.filter((issue) => issue.severity === DiagnosticSeverity.Error)).toEqual([]);
    const start = source.indexOf('`OPTIONAL');
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'preprocessor-undefined-macro', severity: DiagnosticSeverity.Warning,
      range: Range.create(document.positionAt(start), document.positionAt(start + '`OPTIONAL'.length))
    }));
  });
});
