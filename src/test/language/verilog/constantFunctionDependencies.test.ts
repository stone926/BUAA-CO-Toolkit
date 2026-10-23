import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/diagnosticProvider';
import { classifyExpressionConstant } from '../../../language/verilog/expressions';
import { parseVerilogExpression } from '../../../language/verilog/exprAst';
import { parseVerilogCore } from '../../../language/verilog/parseCore';
import { classifySystemFunctionConstant } from '../../../language/verilog/systemFunctionConstants';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

const settings = mergeCoSettings({ verilog: { lint: { courseRules: false } } });
let version = 0;
function check(source: string) {
  const document = TextDocument.create(`file:///constant-functions/${++version}.v`, 'verilog', version, source);
  const index = new VerilogWorkspaceIndex();
  index.updateDocument(document, settings);
  return { document, diagnostics: getVerilogDiagnostics(document, settings, index), module: parseVerilogCore(document).modules[0] };
}

describe('shared system-function constant legality', () => {
  it.each(['$rtoi(2.5)', '$ceil(2.5)', '$pow(2,3)', '$floor(2.5)', '$sqrt(4)', '$itor(2)', '$realtobits(2.5)', '$bitstoreal(64\'h4000000000000000)'])
  ('accepts %s without requiring an implemented numeric evaluator', (expression) => {
    const { diagnostics, module } = check(`module m; localparam P=${expression}; wire [P:0] a; endmodule`);
    expect(classifyExpressionConstant(parseVerilogExpression(expression), module)).toBe('constant');
    expect(diagnostics.filter((issue) => issue.severity === DiagnosticSeverity.Error)).toEqual([]);
  });

  it.each(['$rtoi(x)', '$pow(x,2)'])('still rejects runtime arguments to %s', (expression) => {
    const source = `module m(input [7:0] x); localparam P=${expression}; endmodule`;
    const { document, diagnostics } = check(source);
    const start = source.indexOf(expression);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'nonconstant-expression', severity: DiagnosticSeverity.Error,
      range: Range.create(document.positionAt(start), document.positionAt(start + expression.length)) }));
  });

  it.each(['$random', '$time', '$fopen', '$display'])('classifies known runtime behavior in %s', (name) => {
    expect(classifySystemFunctionConstant(name)).toBe('nonConstant');
  });

  it('keeps unknown system functions conservative even with runtime operands', () => {
    const { module, diagnostics } = check('module m(input [7:0] x); localparam P=$bits(x); wire [P:0] a; endmodule');
    expect(classifyExpressionConstant(parseVerilogExpression('$bits(x)'), module)).toBe('unknown');
    expect(classifySystemFunctionConstant('$vendor_constant')).toBe('unknown');
    expect(diagnostics.filter((issue) => issue.code === 'nonconstant-expression')).toEqual([]);
  });

  it.each(['$rtoi(2.5)', '$ceil(2.5)', '$pow(2,3)'])('shares %s legality with user constant functions', (expression) => {
    const { module, diagnostics } = check(`module m; function integer f(input x); f=${expression}; endfunction localparam P=f(1); wire [P:0] a; endmodule`);
    expect(module.declarations.get('f')?.constantFunction).toBe(true);
    expect(diagnostics.filter((issue) => issue.severity === DiagnosticSeverity.Error)).toEqual([]);
  });
});

describe('parameter dependency cycles through bound constant-function captures', () => {
  it.each([
    'parameter P=f(1); function integer f(input x); f=P; endfunction',
    'parameter P=f(0); function integer f(input x); if(x) f=P; else f=1; endfunction',
    'parameter P=f(1); function integer f(input x); f=g(x); endfunction function integer g(input x); g=P; endfunction'
  ])('reports an initializer call that captures its own parameter: %s', (body) => {
    const source = `module m; ${body} endmodule`;
    const { document, diagnostics } = check(source);
    const start = source.indexOf('f(');
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'parameter-cycle', severity: DiagnosticSeverity.Error,
      range: Range.create(document.positionAt(start), document.positionAt(start + 1)), message: 'Parameter dependency cycle: P -> P.' }));
  });

  it.each([
    'parameter P=f(1); function integer f(input P); f=P; endfunction',
    'parameter P=f(1); function integer f(input x); reg P; begin P=x; f=P; end endfunction',
    'parameter P=f(1); function integer f(input x); localparam P=2; f=P+x; endfunction',
    'parameter P=f(1); function integer f(input x); if(0) f=P; else f=1; endfunction',
    'localparam OFF=0; parameter P=f(1); function integer f(input x); if(OFF) f=P; else f=1; endfunction',
    'parameter Q=2; parameter P=f(1); function integer f(input x); f=Q+x; endfunction'
  ])('preserves bound formals, local shadowing and acyclic captures: %s', (body) => {
    expect(check(`module m; ${body} endmodule`).diagnostics.filter((issue) => issue.severity === DiagnosticSeverity.Error)).toEqual([]);
  });

  it('retains direct and captured parameter identities in a multi-parameter chain', () => {
    const { document, diagnostics } = check('module m; parameter P=f(1); parameter Q=P; function integer f(input x); f=Q; endfunction endmodule');
    const issue = diagnostics.find((entry) => entry.code === 'parameter-cycle');
    expect(issue).toMatchObject({ severity: DiagnosticSeverity.Error, message: 'Parameter dependency cycle: P -> Q -> P.' });
    expect(document.getText(issue!.range)).toBe('P');
  });

  it('includes parameter type ranges in the dependency graph without asking Icarus to elaborate a circular type', () => {
    const { document, diagnostics } = check('module m; parameter [B:0] A=1; parameter B=A; endmodule');
    const issue = diagnostics.find((entry) => entry.code === 'parameter-cycle');
    expect(issue).toMatchObject({ severity: DiagnosticSeverity.Error, message: 'Parameter dependency cycle: A -> B -> A.' });
    expect(document.getText(issue!.range)).toBe('A');
    expect(check('module m; parameter B=3; parameter [B:0] A=1; endmodule').diagnostics.filter((entry) => entry.severity === DiagnosticSeverity.Error)).toEqual([]);
  });

  it('bounds nested and recursive function dependency traversal', () => {
    const functions = Array.from({ length: 150 }, (_value, index) =>
      `function integer f${index}(input x); f${index}=${index === 149 ? '1' : `f${index + 1}(x)`}; endfunction`).join(' ');
    const result = check(`module m; parameter P=f0(1); ${functions} endmodule`).diagnostics;
    expect(result.filter((issue) => issue.code === 'parameter-cycle')).toEqual([]);
    expect(check('module m; parameter P=f(1); function integer f(input x); f=f(x); endfunction endmodule').diagnostics
      .filter((issue) => issue.code === 'parameter-cycle')).toEqual([]);
  });
});
