import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/diagnosticProvider';
import { mergeVerilogExternalDiagnostics } from '../../../language/verilog/externalDiagnosticLocations';
import { parseIverilogDiagnostics } from '../../../language/verilog/iverilogSyntaxCheck';
import { getCachedVerilogParse } from '../../../language/verilog/parseCache';

const file = path.resolve('诊断 with spaces', 'alu.v');
const settings = mergeCoSettings({ verilog: { lint: { courseRules: false } } });
function doc(text: string) { return TextDocument.create(URI.file(file).toString(), 'verilog', 1, text); }
function external(output: string) { return parseIverilogDiagnostics(output, path.dirname(file)).get(URI.file(file).toString())!; }

describe('Icarus source locations and local diagnostic merging', () => {
  it.each(['<=', '=='])('retains the exact %s declaration error and attaches generic compiler messages', (operator) => {
    const document = doc(`module alu(input [31:0] inputA,inputB);\n    wire [31:0] a_add_b ${operator} inputA + inputB;\nendmodule\n`);
    const local = getVerilogDiagnostics(document, settings);
    const exact = local.find((item) => item.code === 'syntax-malformed-declaration')!;
    expect(document.getText(exact.range)).toBe(operator);
    const compiler = external(`${file}:2: syntax error\n${file}:2: error: Invalid module item.\n`);
    const merged = mergeVerilogExternalDiagnostics(document, local, compiler);
    const retained = merged.find((item) => item.code === exact.code)!;
    expect(retained.range).toEqual(exact.range);
    expect(retained.relatedInformation?.map((item) => item.message)).toEqual(['Icarus Verilog: syntax error', 'Icarus Verilog: Invalid module item.']);
    expect(merged.some((item) => item.code === 'iverilog-syntax')).toBe(false);
    expect(exact.relatedInformation).toBeUndefined();
    expect(compiler.every((item) => item.range.start.character === 0)).toBe(true);
    expect(mergeVerilogExternalDiagnostics(document, local, compiler)).toEqual(merged);
  });

  it.each([
    ["Unable to bind wire/reg/memory `missing_name' in `top'", 'assign y = missing_name; // missing_name', 'missing_name'],
    ['Unable to elaborate r-value: missing_name', 'assign y = missing_name;', 'missing_name'],
    ["port ``bogus'' is not a port of u.", 'child u(.bogus(a));', 'bogus']
  ])('anchors a uniquely named compiler token: %s', (message, source, name) => {
    const document = doc(`module top;\n\t${source}\nendmodule`);
    const merged = mergeVerilogExternalDiagnostics(document, [], external(`${file}:2: error: ${message}`));
    expect(document.getText(merged[0].range)).toBe(name);
    expect(merged[0].source).toBe('Icarus Verilog');
  });

  it('uses the non-comment code span when the compiler supplies no precise evidence', () => {
    const document = doc('module m;\r\n\t  unknown ? syntax; // comment\r\nendmodule');
    const merged = mergeVerilogExternalDiagnostics(document, [], external(`${file}:2: syntax error`));
    expect(document.getText(merged[0].range)).toBe('unknown ? syntax;');
  });

  it('does not guess between repeated symbol occurrences', () => {
    const document = doc('module m;\n  assign y=missing_name+missing_name;\nendmodule');
    const merged = mergeVerilogExternalDiagnostics(document, [], external(`${file}:2: error: Unable to elaborate r-value: missing_name`));
    expect(document.getText(merged[0].range)).toBe('assign y=missing_name+missing_name;');
  });

  it.each([false, true])('does not mistake a multiline comment for the compiler-named identifier (cached tokens: %s)', (cached) => {
    const sourceTokens = (document: TextDocument) => cached ? getCachedVerilogParse(document, settings, false).ast.tokens : undefined;
    const message = `${file}:4: error: Unable to elaborate r-value: missing_name`;
    const macro = doc('`define BAD missing_name\nmodule m(output y);\n/* explanatory comment\nmissing_name */ assign y = `BAD;\nendmodule');
    const macroResult = mergeVerilogExternalDiagnostics(macro, [], external(message), sourceTokens(macro));
    expect(macro.getText(macroResult[0].range)).toBe('assign y = `BAD;');
    const direct = doc('module m;\nwire y;\n/* comment\nmissing_name */ assign y = missing_name;\nendmodule');
    const directResult = mergeVerilogExternalDiagnostics(direct, [], external(message), sourceTokens(direct));
    expect(directResult[0].range.start.character).toBeGreaterThan(12);
    expect(direct.getText(directResult[0].range)).toBe('missing_name');
  });

  it('honors an explicit compiler column including column one', () => {
    const document = doc('endmodule\n    wire a == b;');
    const merged = mergeVerilogExternalDiagnostics(document, [], external(`${file}:1:1: syntax error\n${file}:2:12: syntax error`));
    expect(merged[0].range).toEqual(Range.create(0, 0, 0, 9));
    expect(document.getText(merged[1].range)).toBe('==');
  });

  it('does not remove other errors on a line or attach an unrelated warning', () => {
    const document = doc('    wire a == b; wire c == d;');
    const local: Diagnostic[] = [
      { range: Range.create(0, 11, 0, 13), severity: DiagnosticSeverity.Error, code: 'syntax-first', message: 'first' },
      { range: Range.create(0, 24, 0, 26), severity: DiagnosticSeverity.Error, code: 'syntax-second', message: 'second' }
    ];
    const merged = mergeVerilogExternalDiagnostics(document, local, external(`${file}:1: syntax error\n${file}:1: warning: implicit definition`));
    expect(merged.slice(0, 2)).toEqual(local);
    expect(merged).toHaveLength(4);
    expect(merged[2].range.start.character).toBe(4);
    expect(merged[3].severity).toBe(DiagnosticSeverity.Warning);
  });

  it('keeps a preceding missing-semicolon error when Icarus reports the following line', () => {
    const document = doc('module m;\n  wire a\nendmodule');
    const local: Diagnostic[] = [{ range: Range.create(1, 7, 1, 8), severity: 1, code: 'syntax-missing-semicolon', message: 'missing semicolon' }];
    const merged = mergeVerilogExternalDiagnostics(document, local, external(`${file}:3: syntax error`));
    expect(merged[0]).toEqual(local[0]);
    expect(document.getText(merged[1].range)).toBe('endmodule');
  });

  it('clamps EOF ranges and leaves tool failures without source locations unchanged', () => {
    const document = doc('module m;\n');
    const failure: Diagnostic = { range: Range.create(0, 0, 0, 1), code: 'iverilog-syntax', message: 'Icarus Verilog syntax check timed out.', severity: 1 };
    const merged = mergeVerilogExternalDiagnostics(document, [], [...external(`${file}:999: syntax error`), failure]);
    expect(merged[0].range).toEqual(Range.create(1, 0, 1, 0));
    expect(merged[1]).toBe(failure);
  });
});
