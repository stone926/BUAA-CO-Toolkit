import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseModules } from '../../language/verilog/moduleParser';
import { parseVerilogExpression } from '../../language/verilog/exprAst';
import {
  evalExpressionAstConstant,
  evalExpressionAstTypedConstant,
  evalExpressionConstant,
  widthOfDecl
} from '../../language/verilog/expressions';
import type { VerilogIntegralConstant } from '../../language/verilog/typedConstants';
import { buildIverilogEnvironment, buildIverilogRuntimeArgs, resolveIverilogRuntime } from '../../verilog/iverilogRuntime';

const runtime = resolveIverilogRuntime(path.resolve(__dirname, '../../..'));
const available = fs.existsSync(runtime.iverilogPath) && fs.existsSync(runtime.vvpPath);
if (!available) console.warn('SKIP language semantics: bundled Icarus compiler or vvp is unavailable');

const declarations = `
  localparam signed [7:0] S = 8'shff;
  localparam [3:0] P = 4'hf + 4'h1;
  localparam [7:0] W = 4'hf + 4'h1;
  parameter time T = 64'h100000000;
  localparam [8:1] A = 8'h80;
  localparam [0:7] B = 8'h80;
  localparam PA = A, PB = B;
  localparam XZ = 4'bx1z0;
`;

const known = [
  { name: 'signed_literal', expression: "8'shff", expected: -1n },
  { name: 'signed_parameter', expression: 'S', expected: -1n },
  { name: 'signed_comparison', expression: 'S < 0', expected: 1n },
  { name: 'arithmetic_shift', expression: 'S >>> 1', expected: -1n },
  { name: 'declaration_truncation', expression: 'P', expected: 0n },
  { name: 'declaration_context', expression: 'W', expected: 16n },
  { name: 'time_value', expression: 'T', expected: 4294967296n },
  { name: 'comparison_context', expression: "(4'hf + 4'h1) == 8'h10", expected: 1n },
  { name: 'ternary_context', expression: "1'b1 ? 4'hf + 4'h1 : 8'h0", expected: 16n },
  { name: 'unsigned_shift_context', expression: "(8'sh80 >>> 1) + 8'h0", expected: 64n },
  { name: 'wide_unsigned_shift_context', expression: "(8'sh80 >>> 1) + 16'h0", expected: 64n },
  { name: 'unsigned_cast_boundary', expression: "$unsigned(8'sh80 >>> 1) + 16'h0", expected: 192n },
  { name: 'nonzero_packed_index', expression: 'A[8]', expected: 1n },
  { name: 'ascending_packed_index', expression: 'B[0]', expected: 1n },
  { name: 'nonzero_packed_range', expression: 'A[8:5]', expected: 8n },
  { name: 'ascending_packed_range', expression: 'B[0:3]', expected: 8n },
  { name: 'nonzero_indexed_plus', expression: 'A[5+:4]', expected: 8n },
  { name: 'nonzero_indexed_minus', expression: 'A[8-:4]', expected: 8n },
  { name: 'ascending_indexed_plus', expression: 'B[0+:4]', expected: 8n },
  { name: 'ascending_indexed_minus', expression: 'B[3-:4]', expected: 8n },
  { name: 'implicit_parameter_range', expression: 'PA[7]', expected: 1n },
  { name: 'implicit_ascending_parameter_range', expression: 'PB[0]', expected: 0n }
];
const fourState = [
  { name: 'unknown_literal', expression: 'XZ', expected: 'x1z0' },
  { name: 'nonzero_out_of_bounds', expression: 'A[9]', expected: 'x' },
  { name: 'ascending_out_of_bounds', expression: 'B[8]', expected: 'x' },
  { name: 'implicit_parameter_out_of_bounds', expression: 'PA[8]', expected: 'x' },
  { name: 'partially_out_of_bounds', expression: 'A[9:6]', expected: 'x100' }
];
const source = `module tb;
${declarations}
initial begin
${known.map(vector => `  $display("${vector.name}=%0d", ${vector.expression});`).join('\n')}
${fourState.map(vector => `  $display("${vector.name}=%b", ${vector.expression});`).join('\n')}
  $display("time_bits=%b", T);
  $finish;
end
endmodule`;

function binary(value: VerilogIntegralConstant): string {
  let result = '';
  for (let offset = value.width - 1; offset >= 0; offset--) {
    const bit = 1n << BigInt(offset);
    result += value.xMask & bit ? 'x' : value.zMask & bit ? 'z' : value.bits & bit ? '1' : '0';
  }
  return result;
}

// These are real subprocess checks, deliberately independent of mocked runner tests.
describe.skipIf(!available)('Verilog language semantics against bundled Icarus -g2005', () => {
  let directory: string;
  let output: Map<string, string>;
  const document = TextDocument.create('test://language-semantics.v', 'verilog', 1, source);
  const module = parseModules(document, source)[0];

  function execute(name: string, text: string): Map<string, string> {
    const sourceFile = path.join(directory, `${name}.v`);
    const outputFile = path.join(directory, `${name}.vvp`);
    fs.writeFileSync(sourceFile, text);
    const options = { cwd: directory, encoding: 'utf8' as const, timeout: 10000, env: buildIverilogEnvironment(runtime) };
    const compile = spawnSync(runtime.iverilogPath, [
      ...buildIverilogRuntimeArgs(runtime), '-g2005', '-s', 'tb', '-o', outputFile, sourceFile
    ], options);
    expect(compile.error, `${name} compile error`).toBeUndefined();
    expect(compile.status, `${name}: ${compile.stderr}`).toBe(0);
    const run = spawnSync(runtime.vvpPath, ['-N', outputFile], options);
    expect(run.error, `${name} simulation error`).toBeUndefined();
    expect(run.status, `${name}: ${run.stderr}`).toBe(0);
    return new Map(run.stdout.split(/\r?\n/).flatMap(line => {
      const record = /^([a-z_]+)=(.*)$/.exec(line);
      return record ? [[record[1], record[2].trim()] as [string, string]] : [];
    }));
  }

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'co 常量语义 '));
    output = execute('semantics', source);
  }, 30000);

  afterAll(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('agrees on signedness, declaration sizing and enclosing expression context', () => {
    for (const vector of known) {
      expect(output.get(vector.name), `${vector.name}: Icarus oracle`).toBe(vector.expected.toString());
      expect(evalExpressionConstant(vector.expression, module), `${vector.name}: TypeScript evaluator`).toBe(BigInt(output.get(vector.name)!));
    }
  });

  it('preserves X/Z and produces X for complete and partial out-of-range selects', () => {
    for (const vector of fourState) {
      expect(output.get(vector.name), `${vector.name}: Icarus oracle`).toBe(vector.expected);
      const value = evalExpressionAstTypedConstant(parseVerilogExpression(vector.expression), module);
      expect(value, `${vector.name}: typed value`).toBeDefined();
      expect(binary(value!), `${vector.name}: four-state bits`).toBe(output.get(vector.name));
      expect(evalExpressionConstant(vector.expression, module), `${vector.name}: no two-state numeric value`).toBeUndefined();
    }
  });

  it('retains the complete 64-bit time parameter rather than an integer width', () => {
    const bits = output.get('time_bits')!;
    expect(bits).toHaveLength(64);
    expect(BigInt(`0b${bits}`)).toBe(4294967296n);
    expect(widthOfDecl(module.declarations.get('T')!, module).width).toBe(bits.length);
    expect(binary(evalExpressionAstTypedConstant(parseVerilogExpression('T'), module)!)).toBe(bits);
  });

  it('preserves VVP output when a sized assignment-context constant fold is applied', () => {
    const expression = "4'hf + 4'h1";
    const original = `module tb; wire [7:0] y; assign y=${expression}; initial begin #1; $display("result=%0d", y); $finish; end endmodule`;
    const foldDocument = TextDocument.create('test://language-fold.v', 'verilog', 1, original);
    const foldModule = parseModules(foldDocument, original)[0];
    const width = widthOfDecl(foldModule.declarations.get('y')!, foldModule).width!;
    const value = evalExpressionAstConstant(parseVerilogExpression(expression), foldModule, undefined, undefined, { width });
    expect(value).toBe(16n);
    const replacement = `${width}'h${value!.toString(16)}`;
    expect(replacement).toBe("8'h10");
    const before = execute('before-fold', original);
    const after = execute('after-fold', original.replace(expression, replacement));
    expect(before.get('result')).toBe('16');
    expect(after).toEqual(before);
  }, 30000);
});
