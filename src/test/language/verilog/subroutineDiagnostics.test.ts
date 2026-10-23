// @index subroutine-diagnostic-tests — Production callable binding and formal variable regressions
import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';
import { parseVerilogCore } from '../../../language/verilog/parseCore';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

const settings = mergeCoSettings({ verilog: { lint: { courseRules: false } } });
let version = 1;
function check(source: string, languageId = 'verilog') {
  const document = TextDocument.create(`test://subroutines/${version++}.v`, languageId, version, source);
  const index = new VerilogWorkspaceIndex();
  index.updateDocument(document, settings);
  return { document, diagnostics: getVerilogDiagnostics(document, settings, index) };
}
function expectError(source: string, code: string, selected: string, occurrence = 0, selectionLength = selected.length) {
  const { document, diagnostics } = check(source);
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) offset = source.indexOf(selected, offset + 1);
  expect(offset).toBeGreaterThanOrEqual(0);
  const hit = diagnostics.find((diagnostic) => diagnostic.code === code);
  expect(hit, JSON.stringify(diagnostics)).toMatchObject({ code, severity: DiagnosticSeverity.Error, range: Range.create(document.positionAt(offset), document.positionAt(offset + selectionLength)) });
}

describe('bound Verilog subroutine diagnostics', () => {
  it.each(['f(a)', 'f(a,a,a)'])('checks function positional arity: %s', (call) => {
    const source = `module m(input a, output y); function f(input x,input z); f=x&z; endfunction assign y=${call}; endmodule`;
    expectError(source, 'subroutine-argument-count', 'f', 4);
  });
  it('checks task positional arity including bare calls', () => {
    expectError('module m; task t; input a,b; begin end endtask initial t(1); endmodule', 'subroutine-argument-count', 't', 5);
    expectError('module m; task t; input a; begin end endtask initial t; endmodule', 'subroutine-argument-count', 't', 5);
  });
  it('checks output and inout actual lvalues', () => {
    for (const direction of ['output', 'inout']) {
      expectError(`module m; task t; ${direction} reg x; x=1; endtask initial t(1'b0); endmodule`, 'invalid-assignment-target', "1'b0");
    }
  });
  it.each(['#1 f=a;', '@(a) f=a;'])('rejects function timing controls: %s', (body) => {
    expectError(`module m; function f; input a; ${body} endfunction endmodule`, 'function-timing-control', body[0]);
  });
  it('rejects function nonblocking assignments without confusing comparisons', () => {
    expectError('module m; function f; input a; f<=a; endfunction endmodule', 'function-nonblocking-assignment', '<=');
    expect(check('module m; function f; input a; f=(a<=1); endfunction endmodule').diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('function-nonblocking-assignment');
  });
  it('applies Verilog-2005 formal and body requirements', () => {
    expectError('module m; function f; output a; f=a; endfunction endmodule', 'function-formal-direction', 'output');
    expectError('module m; function f; f=1; endfunction endmodule', 'function-missing-input', 'f', 1);
    expectError('module m; function f; input a; endfunction endmodule', 'subroutine-missing-body', 'f', 1);
    expectError('module m; task t; input a; endtask endmodule', 'subroutine-missing-body', 't', 1);
  });
  it('keeps wider SystemVerilog formal and body rules separate', () => {
    const result = check('module m; function f; output a; endfunction task t; endtask endmodule', 'systemverilog').diagnostics;
    expect(result.map((diagnostic) => diagnostic.code)).not.toContain('function-formal-direction');
    expect(result.map((diagnostic) => diagnostic.code)).not.toContain('function-missing-input');
    expect(result.map((diagnostic) => diagnostic.code)).not.toContain('subroutine-missing-body');
  });
  it('rejects calls to tasks from a function', () => {
    expectError('module m; task t; output a; a=1; endtask function f; input x; t(x); f=x; endfunction endmodule', 'function-task-call', 't(x)', 0, 1);
  });
  it.each([
    'module m(output y,z); if(1) begin : a function f(input x); f=x; endfunction assign y=f(1); end if(1) begin : b function f(input x,input q); f=x&q; endfunction assign z=f(1,1); end endmodule',
    'module m(output y,z); function f(input x); f=x; endfunction assign y=f(1); if(1) begin : b function f(input x,input q); f=x&q; endfunction assign z=f(1,1); end endmodule',
    'module m; reg a; task t; output x; x=1; endtask initial begin wait(a) t(a); end endmodule',
    'module m; reg a; initial wait(a); endmodule',
    'module m; reg a; initial wait(a) begin a=1; end endmodule',
    'module m; reg a; initial wait(a) a=1; endmodule'
  ])('binds scoped callables and traverses wait controls: %s', (source) => {
    expect(check(source).diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error)).toEqual([]);
  });
  it.each([true, false])('preserves unknown include-provided callables with complete index=%s', (complete) => {
    const source = 'module m;\n`include "f.vh"\nlocalparam P=f(1); reg a; initial t(a);\nendmodule';
    const document = TextDocument.create(`test://included-callable-${complete}.v`, 'verilog', version++, source);
    const index = new VerilogWorkspaceIndex({ workspaceComplete: complete });
    if (complete) index.updateDocument(TextDocument.create('test://f.vh', 'verilog', 1, 'function f(input a); f=a; endfunction task t; output a; a=1; endtask'), settings);
    index.updateDocument(document, settings);
    const result = getVerilogDiagnostics(document, settings, index);
    expect(result.some((diagnostic) => diagnostic.code === 'unknown-subroutine')).toBe(false);
    expect(result.some((diagnostic) => diagnostic.code === 'parameter-not-constant')).toBe(false);
  });
  it('still rejects unknown calls when macros only supply expression arguments', () => {
    expectError('`define ONE 1\nmodule m; wire y; assign y=missing(`ONE); endmodule', 'unknown-subroutine', 'missing');
  });
  it('preserves unknown declarations provided by module-level macros', () => {
    const source = '`define DECL function f(input a); f=a; endfunction\nmodule m;\n`DECL\nlocalparam P=f(1); endmodule';
    const result = check(source).diagnostics;
    expect(result.some((diagnostic) => diagnostic.code === 'unknown-subroutine')).toBe(false);
    expect(result.some((diagnostic) => diagnostic.code === 'parameter-not-constant')).toBe(false);
  });
  it.each(['include', 'macro'])('keeps formals contributed by a subroutine-local %s unknown', (dependency) => {
    const prefix = dependency === 'macro' ? '`define ARGS input a,b;\n' : '';
    const formals = dependency === 'macro' ? '`ARGS' : '`include "args.vh"';
    const source = `${prefix}module m; function f;\n${formals}\nf=a&b; endfunction wire y=f(1,1); task t;\n${formals}\nbegin end endtask initial t(1,1); endmodule`;
    const result = check(source).diagnostics;
    expect(result.some((diagnostic) => ['subroutine-argument-count', 'function-missing-input', 'subroutine-missing-body'].includes(String(diagnostic.code)))).toBe(false);
    const parsed = parseVerilogCore(TextDocument.create(`test://signature-${dependency}.v`, 'verilog', 1, source));
    expect(parsed.modules[0].subroutines?.map((signature) => signature.complete)).toEqual([false, false]);
  });
  it('still checks arity when a macro only supplies a function-body expression', () => {
    expectError('`define ONE 1\nmodule m; function f(input a,b); f=`ONE&a&b; endfunction wire y=f(1); endmodule', 'subroutine-argument-count', 'f(1)', 0, 1);
  });
  it('does not assign a positional output direction until included formals are known', () => {
    const source = 'module m; task t;\n`include "args.vh"\noutput b; b=1; endtask initial t(1,1); endmodule';
    expect(check(source).diagnostics.some((diagnostic) => diagnostic.code === 'invalid-assignment-target')).toBe(false);
  });
  it('reports unknown functions and tasks as callable errors', () => {
    for (const body of ['reg y; initial y=missing(1);', 'initial missing(1);', 'initial missing;']) {
      const source = `module m; ${body} endmodule`;
      expectError(source, 'unknown-subroutine', 'missing');
      expect(check(source).diagnostics.some((diagnostic) => String(diagnostic.code).startsWith('implicit-net:missing'))).toBe(false);
    }
  });
});

describe('subroutine signature storage and scopes', () => {
  it.each([
    'task t; begin end endtask initial t;',
    'reg a; task t; output x; x=1; endtask initial t(a);',
    'function f; input a; begin a=1; f=a; end endfunction',
    'reg a; task t(output x); #1 x=1; endtask initial t(a);',
    'function f(input x,input z); f=x&z; endfunction wire y; assign y=f(1,1);',
    'wire a; function f; input a; begin : inner reg a; a=1; f=a; end endfunction function g; input a; a=1; g=a; endfunction',
    'reg a; task t; output x; begin : inner reg x; x=1; end endtask initial t(a);'
  ])('accepts legal formals, timing and shadowing: %s', (body) => {
    const errors = check(`module m; ${body} endmodule`).diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error);
    expect(errors).toEqual([]);
  });
  it('keeps unresolved constant-function dependencies unknown', () => {
    const source = 'module m; function f; input a; f=a+missing; endfunction function g; input a; g=f(a); endfunction endmodule';
    const document = TextDocument.create('test://unresolved-function.v', 'verilog', 1, source);
    const parsed = parseVerilogCore(document);
    expect(parsed.modules[0].declarations.get('f')?.constantFunction).toBeUndefined();
    expect(parsed.modules[0].declarations.get('g')?.constantFunction).toBeUndefined();
  });
  it('retains certain runtime captures through a function with other unknown dependencies', () => {
    const source = 'module m; wire runtime; function f; input a; f=a+runtime; endfunction function g; input a; g=f(a)+missing; endfunction endmodule';
    const document = TextDocument.create('test://runtime-function.v', 'verilog', 1, source);
    const parsed = parseVerilogCore(document);
    expect(parsed.modules[0].declarations.get('f')?.constantFunction).toBe(false);
    expect(parsed.modules[0].declarations.get('g')?.constantFunction).toBe(false);
  });
  it('preserves formal order, inherited types, return type and declaration identity', () => {
    const document = TextDocument.create('test://signatures.v', 'verilog', 1, 'module m; function integer f(input integer a,b); f=a+b; endfunction function g; input a; g=a; endfunction endmodule');
    const parsed = parseVerilogCore(document);
    const [first, second] = parsed.modules[0].subroutines!;
    expect(first.formals.map((formal) => [formal.name, formal.direction, formal.valueType, formal.storage])).toEqual([['a', 'input', 'integer', 'variable'], ['b', 'input', 'integer', 'variable']]);
    expect(first.declaration.functionReturnType).toBe('integer');
    expect(first.formals[0]).not.toBe(second.formals[0]);
    expect(parsed.modules[0].declarations.has('a')).toBe(false);
    expect(parsed.semantic.symbols.filter((symbol) => symbol.name === 'a')).toHaveLength(2);
  });
});
