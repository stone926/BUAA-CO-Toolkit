import { testToolTimeoutMs } from '../helpers/testTimeouts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { mergeCoSettings } from '../../language/common/settings';
import { getVerilogDiagnostics } from '../../language/verilog/diagnosticProvider';
import { mergeVerilogExternalDiagnostics } from '../../language/verilog/externalDiagnosticLocations';
import { parseIverilogDiagnostics, runIverilogSyntaxCheck } from '../../language/verilog/iverilogSyntaxCheck';
import { buildIverilogEnvironment, buildIverilogRuntimeArgs, resolveIverilogRuntime } from '../../verilog/iverilogRuntime';

const runtime = resolveIverilogRuntime(path.resolve(__dirname, '../../..'));
const available = fs.existsSync(runtime.iverilogPath);
if (!available) console.warn('SKIP Icarus diagnostic locations: bundled compiler is unavailable');
const settings = mergeCoSettings({ verilog: { lint: { courseRules: false } } });

describe.skipIf(!available)('diagnostic locations from real bundled Icarus', () => {
  let directory: string;
  beforeAll(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'co syntax 定位 ')); });
  afterAll(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

  it.each(['inferred', 'explicit-file', 'explicit-directory'])('preserves mixed-case document URIs for %s project diagnostics', async (mode) => {
    const root = path.join(directory, `Project ${mode}`);
    const rtl = path.join(root, 'Mixed RTL');
    fs.mkdirSync(rtl, { recursive: true });
    const file = path.join(rtl, 'CPU.v');
    fs.writeFileSync(file, 'module top(output y); assign y = missing_case_signal; endmodule\n');
    const uri = URI.file(file).toString();
    const result = await runIverilogSyntaxCheck({
      workspaceFolders: [{ uri: URI.file(root).toString(), name: 'mixed-case project' }],
      triggerUri: uri,
      extensionRoot: path.resolve(__dirname, '../../..'),
      timeoutMs: testToolTimeoutMs,
      projects: mode === 'inferred' ? {} : { CPU: [mode === 'explicit-file' ? file : rtl] }
    });
    expect(result.ok).toBe(false);
    expect(result.toolchainError).toBeUndefined();
    expect([...result.diagnosticsByUri.keys()]).toEqual([uri]);
    expect(result.diagnosticsByUri.get(uri)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'iverilog-syntax', message: expect.stringContaining('missing_case_signal') })
    ]));
  });

  function check(source: string) {
    const file = path.join(directory, 'alu with spaces.v');
    fs.writeFileSync(file, source);
    const result = spawnSync(runtime.iverilogPath, [...buildIverilogRuntimeArgs(runtime), '-g2005', '-tnull', '-i', file], {
      cwd: directory, env: buildIverilogEnvironment(runtime), encoding: 'utf8', timeout: testToolTimeoutMs
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const document = TextDocument.create(URI.file(file).toString(), 'verilog', 1, source);
    const compiler = parseIverilogDiagnostics(`${result.stdout}\n${result.stderr}`, directory).get(document.uri)!;
    expect(compiler?.length).toBeGreaterThan(0);
    return { document, compiler, merged: mergeVerilogExternalDiagnostics(document, getVerilogDiagnostics(document, settings), compiler) };
  }

  it.each(['<=', '=='])('keeps %s underlined instead of the indentation', (operator) => {
    const { document, compiler, merged } = check(`module alu(input [31:0] inputA,inputB);\n    wire [31:0] a_add_b ${operator} inputA + inputB;\nendmodule\n`);
    expect(compiler.every((diagnostic) => diagnostic.data.iverilogLocation === 'line')).toBe(true);
    const located = merged.find((diagnostic) => diagnostic.code === 'syntax-malformed-declaration')!;
    expect(document.getText(located.range)).toBe(operator);
    expect(located.relatedInformation?.some((item) => item.message.includes('Icarus Verilog'))).toBe(true);
  });

  it('locates a compiler-named unresolved identifier without deleting local diagnostics', () => {
    const { document, merged } = check('module top(output y);\n    assign y = missing_name;\nendmodule\n');
    const compiler = merged.filter((item) => item.code === 'iverilog-syntax');
    expect(compiler.length).toBeGreaterThan(0);
    expect(compiler.every((diagnostic) => document.getText(diagnostic.range) === 'missing_name')).toBe(true);
    expect(merged.some((item) => item.code === 'implicit-net:missing_name')).toBe(true);
  });
});
