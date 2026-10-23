import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/diagnosticProvider';
import { lexVerilog } from '../../../language/verilog/lexer';
import { preprocessVerilogTokens } from '../../../language/verilog/preprocessor';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';
import { collectVerilogPreprocessorDiagnostics } from '../../../language/verilog/preprocessorDiagnostics';
import * as lexer from '../../../language/verilog/lexer';
import { buildIverilogEnvironment, buildIverilogRuntimeArgs, resolveIverilogRuntime } from '../../../verilog/iverilogRuntime';

let version = 0;
function diagnostics(text: string, headers: Record<string, string> = {}, complete = true) {
  const document = TextDocument.create('file:///C:/preprocessor-tests/top.v', 'verilog', ++version, text);
  const index = new VerilogWorkspaceIndex({ workspaceComplete: complete });
  for (const [name, source] of Object.entries(headers)) {
    index.updateDocument(TextDocument.create(`file:///C:/preprocessor-tests/${name}`, 'verilog', ++version, source), defaultCoSettings);
  }
  index.updateDocument(document, defaultCoSettings);
  const result = getVerilogDiagnostics(document, defaultCoSettings, index).filter((issue) => String(issue.code).startsWith('preprocessor-'));
  return { document, result };
}

describe('Verilog preprocessor diagnostics through the indexed production provider', () => {
  it.each([
    ['`endif', 'preprocessor-conditional-mismatch', '`endif'],
    ['`else', 'preprocessor-conditional-mismatch', '`else'],
    ['`elsif FLAG', 'preprocessor-conditional-mismatch', '`elsif'],
    ['`ifdef FLAG', 'preprocessor-unclosed-conditional', '`ifdef'],
    ['`ifdef FLAG\n`else\n`else\n`endif', 'preprocessor-conditional-mismatch', '`else'],
    ['`ifdef FLAG\n`else\n`elsif FLAG\n`endif', 'preprocessor-conditional-mismatch', '`elsif'],
    ['`define', 'preprocessor-missing-argument', '`define'],
    ['`ifdef\n`endif', 'preprocessor-missing-argument', '`ifdef'],
    ['`undef', 'preprocessor-missing-argument', '`undef'],
    ['`include', 'preprocessor-missing-argument', '`include'],
    ['`timescale 3ns/1ps', 'preprocessor-invalid-timescale', '3'],
    ['`timescale 1ns/10ns', 'preprocessor-invalid-timescale', '1'],
    ['`default_nettype bananas', 'preprocessor-invalid-default-nettype', 'bananas'],
    ['`define F(a,a) a', 'preprocessor-invalid-define', 'F']
  ])('reports %s at the original directive or argument', (source, code, rangeText) => {
    const { document, result } = diagnostics(`${source}\nmodule m; endmodule`);
    const issue = result.find((item) => item.code === code)!;
    expect(issue).toBeDefined();
    expect(issue.severity).toBe(DiagnosticSeverity.Error);
    expect(document.getText(issue.range)).toBe(rangeText);
  });

  it('accepts valid directive values, empty object macros, and nested conditional branches', () => {
    const source = ['`timescale 100 ns / 1 ps', '`default_nettype none', '`define EMPTY', '`define ON',
      '`ifdef ON', '`ifndef OFF', '`define F(a,b) ((a)+(b))', '`else', '`define', '`endif',
      '`else', '`timescale 3ns/1ps', '`endif', 'module m; wire y; assign y=`F(1,2); endmodule'].join('\n');
    expect(diagnostics(source).result).toEqual([]);
  });

  it.each(['`F(1)', '`F(1,2,3)', '`F'])('checks function macro arity in %s', (call) => {
    const { document, result } = diagnostics(`\`define F(a,b) ((a)+(b))\nmodule m; wire y; assign y=${call}; endmodule`);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ code: 'preprocessor-macro-arity', severity: DiagnosticSeverity.Error });
    expect(document.getText(result[0].range)).toBe('`F');
  });

  it('counts nested commas and ignores invocations in definitions and inactive branches', () => {
    const source = ['`define F(a,b) ((a)+(b))', '`define UNUSED `F(1)', '`ifdef MISSING', '`F(1)', '`endif',
      'module m; wire [3:0] y; assign y=`F({1\'b1,1\'b0}, (1+2)); endmodule'].join('\n');
    expect(diagnostics(source).result).toEqual([]);
  });

  it('accepts an empty actual macro argument and preserves benign undefined-macro warnings', () => {
    const { document, result } = diagnostics('`define F(a) (1 a)\nmodule m; wire y; assign y=`F(); `OPTIONAL endmodule');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ code: 'preprocessor-undefined-macro', severity: DiagnosticSeverity.Warning });
    expect(document.getText(result[0].range)).toBe('`OPTIONAL');
    const grouped = diagnostics('module m; wire a=`OPTIONAL 1,b=2; endmodule').result;
    expect(grouped).toHaveLength(1);
    expect(grouped[0].severity).toBe(DiagnosticSeverity.Warning);
  });

  it('reports undefined macro operands after undef and undefineall at invocation ranges', () => {
    const source = ['`define VALUE 1', 'module m; wire y; assign y=`VALUE;', '`undef VALUE',
      'assign y=1 + `VALUE;', '`define VALUE 1', '`undefineall', 'assign y=`VALUE;', 'endmodule'].join('\n');
    const { document, result } = diagnostics(source);
    expect(result.map((item) => item.code)).toEqual(['preprocessor-undefined-macro', 'preprocessor-undefined-macro']);
    expect(result.map((item) => item.severity)).toEqual([DiagnosticSeverity.Error, DiagnosticSeverity.Error]);
    expect(result.map((item) => document.getText(item.range))).toEqual(['`VALUE', '`VALUE']);
    expect(result.map((item) => item.range.start.line)).toEqual([3, 6]);
  });

  it('reads transitive indexed includes in invocation order, including header undef transitions', () => {
    const source = ['`include "nested/defs.vh"', 'module m; wire y; assign y=`ADD(1,2);',
      '`include "clear.vh"', 'assign y=`ADD(1,2);', 'endmodule'].join('\n');
    const { document, result } = diagnostics(source, {
      'nested/defs.vh': '`include "../base.vh"\n`ifdef ENABLED\n`define ADD(a,b) ((a)+(b))\n`endif',
      'base.vh': '`define ENABLED 1', 'clear.vh': '`undef ADD'
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ code: 'preprocessor-undefined-macro', severity: DiagnosticSeverity.Error });
    expect(document.getText(result[0].range)).toBe('`ADD');
    expect(result[0].range.start.line).toBe(3);
  });

  it('uses header function macro signatures and header-controlled activity', () => {
    const { document, result } = diagnostics('`include "defs.vh"\n`ifdef ENABLED\nmodule m; wire y; assign y=`F(1); endmodule\n`endif', {
      'defs.vh': '`define ENABLED 1\n`define F(a,b) ((a)+(b))'
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ code: 'preprocessor-macro-arity', severity: DiagnosticSeverity.Error });
    expect(document.getText(result[0].range)).toBe('`F');
  });

  it('defers unknown include, incomplete index, and potential external configuration definitions', () => {
    expect(diagnostics('`include "unavailable.vh"\nmodule m; wire y; assign y=`CONFIG; endmodule').result).toEqual([]);
    expect(diagnostics('module m; wire y; assign y=`CONFIG; endmodule', {}, false).result).toEqual([]);
    expect(diagnostics('module m; wire y; assign y=`CONFIG; endmodule', { 'configuration.v': '`define CONFIG 1' }).result).toEqual([]);
    expect(diagnostics('`include "unavailable.vh"\n`ifdef CONFIG\n`MISSING\n`else\n`MISSING\n`endif').result).toEqual([]);
  });

  it('retains source identity and accepts explicitly supplied configuration macros', () => {
    const text = '`ifdef CONFIG\nmodule m; endmodule\n`else\n`MISSING\n`endif';
    const tokens = lexVerilog(text).tokens;
    const result = preprocessVerilogTokens(text, tokens, { uri: 'test://mapped.v', initialMacros: new Map([['CONFIG', undefined]]) });
    expect(result.issues).toEqual([]);
    expect(result.tokens.some((token) => token.value === 'module')).toBe(true);
    for (const token of result.tokens) {
      expect(tokens).toContain(token);
      expect(result.tokenSources.get(token)).toEqual({ uri: 'test://mapped.v', start: token.start, end: token.end });
    }
  });

  it('accepts keywords as macro names and formal names across their complete lifecycle', () => {
    const source = ['`define wire 1', '`ifdef wire', '`define F(input,output) ((input)+(output))',
      'module m; wire y=`wire; wire z=`F(0,1); endmodule', '`endif', '`undef wire', '`ifndef wire',
      'module n; wire y=1; endmodule', '`endif'].join('\n');
    const { document, result } = diagnostics(source);
    expect(result).toEqual([]);
    const index = new VerilogWorkspaceIndex();
    index.updateDocument(document, defaultCoSettings);
    expect(getVerilogDiagnostics(document, defaultCoSettings, index).filter((issue) => issue.severity === DiagnosticSeverity.Error)).toEqual([]);
    expect(index.getFile(document.uri)?.macros.map((macro) => macro.name)).toContain('wire');
  });

  it('validates nested macro invocations only when their wrappers are called', () => {
    const definitions = '`define F(a,b) ((a)+(b))\n`define BAD `F(1)\n';
    expect(diagnostics(`${definitions}module m; endmodule`).result).toEqual([]);
    const { document, result } = diagnostics(`${definitions}module m; wire y=\`BAD; endmodule`);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ code: 'preprocessor-macro-arity', severity: DiagnosticSeverity.Error });
    expect(document.getText(result[0].range)).toBe('`BAD');
    expect(diagnostics(`${definitions.replace('`F(1)', '`F(1,2)')}module m; wire y=\`BAD; endmodule`).result).toEqual([]);
    const undefinedBody = diagnostics('`define BAD (1 + `MISSING)\nmodule m; wire y=`BAD; endmodule');
    expect(undefinedBody.result[0]).toMatchObject({ code: 'preprocessor-undefined-macro', severity: DiagnosticSeverity.Error });
    expect(undefinedBody.document.getText(undefinedBody.result[0].range)).toBe('`BAD');
    const optionalBody = diagnostics('`define OK (`OPTIONAL 1)\nmodule m; wire y=`OK; endmodule').result;
    expect(optionalBody[0]).toMatchObject({ code: 'preprocessor-undefined-macro', severity: DiagnosticSeverity.Warning });
  });

  it('substitutes wrapper arguments and uses the invocation-time macro lifecycle', () => {
    const source = ['`define F(a,b) ((a)+(b))', '`define WRAP(input) `F(input,2)', '`define ALIAS `WRAP(1)',
      'module m; wire y=`ALIAS;', '`undef F', '`define F(a) (a)', 'wire z=`ALIAS; endmodule'].join('\n');
    const { document, result } = diagnostics(source);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ code: 'preprocessor-macro-arity', severity: DiagnosticSeverity.Error });
    expect(document.getText(result[0].range)).toBe('`ALIAS');
    expect(result[0].range.start.line).toBe(6);
  });

  it.each([
    'module m; reg a; initial if(`MISSING) a=0; endmodule',
    'module m; reg a; initial case(`MISSING) 0:a=0; endcase endmodule',
    'module m; reg a; initial #(`MISSING) a=0; endmodule',
    'module m; wire [`MISSING:0] a; endmodule'
  ])('reports a definitely incomplete required expression after macro expansion', (source) => {
    const { document, result } = diagnostics(source);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ code: 'preprocessor-undefined-macro', severity: DiagnosticSeverity.Error });
    expect(document.getText(result[0].range)).toBe('`MISSING');
  });

  it('validates known empty macros only after expanding their required expression context', () => {
    const invalid = diagnostics('`define EMPTY\nmodule m; reg a; initial if(`EMPTY) a=0; endmodule');
    expect(invalid.result[0]).toMatchObject({ code: 'preprocessor-incomplete-expression', severity: DiagnosticSeverity.Error });
    expect(invalid.document.getText(invalid.result[0].range)).toBe('`EMPTY');
    expect(diagnostics('`define EMPTY\nmodule m; reg a; initial if(`EMPTY 1) a=0; endmodule').result).toEqual([]);
  });

  it('reuses analysis for equal document text and invalidates it on index and text changes', () => {
    const document = TextDocument.create('test://preprocessor-cache/top.v', 'verilog', 1, 'module m; wire y=`CONFIG; endmodule');
    const index = new VerilogWorkspaceIndex();
    index.updateDocument(document, defaultCoSettings);
    const indexed = vi.spyOn(index, 'indexedFiles');
    const lexical = vi.spyOn(lexer, 'lexVerilog');
    try {
      const first = collectVerilogPreprocessorDiagnostics(document, index);
      expect(first[0]?.code).toBe('preprocessor-undefined-macro');
      expect(indexed).toHaveBeenCalledOnce();
      expect(lexical).toHaveBeenCalledOnce();
      const recreated = TextDocument.create(document.uri, 'verilog', 2, document.getText());
      expect(collectVerilogPreprocessorDiagnostics(recreated, index)).toBe(first);
      expect(indexed).toHaveBeenCalledOnce();
      expect(lexical).toHaveBeenCalledOnce();
      index.updateDocument(TextDocument.create('test://preprocessor-cache/config.vh', 'verilog', 1, '`define CONFIG 1'), defaultCoSettings);
      indexed.mockClear(); lexical.mockClear();
      expect(collectVerilogPreprocessorDiagnostics(document, index)).toEqual([]);
      expect(indexed).toHaveBeenCalledOnce();
      expect(lexical).not.toHaveBeenCalled();
      const changed = TextDocument.create(document.uri, 'verilog', 2, 'module m; wire y=`OTHER; endmodule');
      expect(collectVerilogPreprocessorDiagnostics(changed, index)[0]?.code).toBe('preprocessor-undefined-macro');
      expect(lexical).toHaveBeenCalledOnce();
    } finally { indexed.mockRestore(); lexical.mockRestore(); }
  });

  it('isolates equally versioned indexes and caches standalone analysis by exact text', () => {
    const document = TextDocument.create('test://preprocessor-isolation/top.v', 'verilog', 1, 'module m; wire y=`CONFIG; endmodule');
    const makeIndex = (header: string) => {
      const index = new VerilogWorkspaceIndex();
      index.updateDocument(document, defaultCoSettings);
      index.updateDocument(TextDocument.create('test://preprocessor-isolation/defs.vh', 'verilog', 1, header), defaultCoSettings);
      return index;
    };
    const configured = makeIndex('`define CONFIG 1');
    const other = makeIndex('`define OTHER 1');
    expect(configured.version).toBe(other.version);
    expect(collectVerilogPreprocessorDiagnostics(document, configured)).toEqual([]);
    expect(collectVerilogPreprocessorDiagnostics(document, other)[0]?.code).toBe('preprocessor-undefined-macro');
    expect(collectVerilogPreprocessorDiagnostics(document)).toBe(collectVerilogPreprocessorDiagnostics(document));
  });
});

const runtime = resolveIverilogRuntime(path.resolve(__dirname, '../../../..'));
describe.skipIf(!fs.existsSync(runtime.iverilogPath))('preprocessor legal controls against bundled Icarus -g2005', () => {
  it.each([
    '`define wire 1\n`ifdef wire\nmodule m; wire y=`wire; endmodule\n`endif\n`undef wire\n`ifndef wire\nmodule n; endmodule\n`endif',
    '`define F(input,output) ((input)+(output))\nmodule m; wire y=`F(0,1); endmodule',
    '`define F(a,b) ((a)+(b))\n`define BAD `F(1,2)\nmodule m; wire y=`BAD; endmodule',
    '`define F(a,b) ((a)+(b))\n`define BAD `F(1)\nmodule m; endmodule',
    'module m; reg a; initial if(`MISSING 1) a=0; endmodule',
    '`define EMPTY\nmodule m; reg a; initial if(`EMPTY 1) a=0; endmodule',
    '`define EMPTY\nmodule m; reg a; initial #(1:`EMPTY 2:3) a=0; endmodule',
    'module m; wire [`MISSING 1:0] a; endmodule',
    '`define CAT(a,b) a``b\nmodule m; wire ab=1; wire y=`CAT(a,b); endmodule'
  ])('accepts legal keyword/lazy wrapper macro source', (source) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'co-preprocessor-'));
    const filename = path.join(directory, 'source.v');
    try {
      fs.writeFileSync(filename, source);
      const compiled = spawnSync(runtime.iverilogPath, [...buildIverilogRuntimeArgs(runtime), '-g2005', '-tnull', '-i', filename], {
        cwd: directory, encoding: 'utf8', timeout: 10000, env: buildIverilogEnvironment(runtime)
      });
      expect(compiled.error).toBeUndefined();
      expect(compiled.status, compiled.stderr).toBe(0);
      const { document } = diagnostics(source);
      const index = new VerilogWorkspaceIndex();
      index.updateDocument(document, defaultCoSettings);
      expect(getVerilogDiagnostics(document, defaultCoSettings, index).filter((issue) => issue.severity === DiagnosticSeverity.Error)).toEqual([]);
    } finally { fs.unlinkSync(filename); fs.rmdirSync(directory); }
  });
});
