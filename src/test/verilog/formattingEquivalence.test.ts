import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { buildIverilogCompileArgs, buildIverilogWatchdog, iverilogSimulationDefaults } from '../../verilog/iverilogRunner';
import { buildIverilogEnvironment, resolveIverilogRuntime } from '../../verilog/iverilogRuntime';
import { expectStableFormatting } from '../helpers/verilogFormatting';

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  return createVscodeModuleMock(createVscodeMockState(), vi.fn);
});

const runtime = resolveIverilogRuntime(path.resolve(__dirname, '../../..'));
const available = fs.existsSync(runtime.iverilogPath) && fs.existsSync(runtime.vvpPath);
if (!available) console.warn('SKIP formatting equivalence: bundled Icarus compiler or vvp is unavailable');
const body = [
  '`timescale 1ns/1ps',
  '`define STEP(v) \\',
  '  begin \\',
  '    v = v + 1; \\',
  '  end',
  'module tb;',
  'reg [7:0] \\a+b ;',
  'initial begin',
  '\\a+b =0;',
  '`ifdef ALTERNATE',
  '\\a+b =8\'h 2a;',
  '`else',
  '\\a+b =8\'h 10;',
  '`endif',
  '`STEP(\\a+b )',
  '#1e-3;',
  '$display("FIRST=%0d TIME=%0.3f", \\a+b , $realtime);',
  '#2.5e+0;',
  '$display("FINAL=%0d TIME=%0.3f", \\a+b , $realtime);',
  '$finish;',
  'end',
  'endmodule'
];

describe.skipIf(!available)('Verilog formatting real Icarus equivalence', () => {
  it.each([false, true].flatMap(alternate => ['\n', '\r\n'].map(eol => ({ alternate, eol }))))('preserves macro branch $alternate with EOL $eol', ({ alternate, eol }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'co 格式等价 '));
    try {
      const source = `${alternate ? '`define ALTERNATE' + eol : ''}${body.join(eol)}${eol}`;
      const defaultsFile = path.join(directory, 'defaults.f');
      const watchdogFile = path.join(directory, 'watchdog.v');
      fs.writeFileSync(defaultsFile, iverilogSimulationDefaults);
      fs.writeFileSync(watchdogFile, buildIverilogWatchdog('__watchdog'));
      const execute = (name: string, text: string): string => {
        const sourceFile = path.join(directory, `${name}.v`);
        const outputFile = path.join(directory, `${name}.vvp`);
        fs.writeFileSync(sourceFile, text);
        const args = buildIverilogCompileArgs({ runtime, testbenchModule: 'tb', watchdogModule: '__watchdog', outputFile, dependencyFile: path.join(directory, `${name}.d`), defaultsFile, workspaceRoot: directory, watchdogFile, sourceFiles: [sourceFile] });
        const options = { cwd: directory, encoding: 'utf8' as const, timeout: 15000, env: buildIverilogEnvironment(runtime) };
        const compile = spawnSync(runtime.iverilogPath, args, options);
        expect(compile.error, `${name} compile error`).toBeUndefined();
        expect(compile.status, `${name}: ${compile.stderr}`).toBe(0);
        const run = spawnSync(runtime.vvpPath, ['-N', outputFile, '+co_watchdog_limit_ps=10000'], options);
        expect(run.error, `${name} simulation error`).toBeUndefined();
        expect(run.status, `${name}: ${run.stderr}`).toBe(0);
        return run.stdout;
      };
      // 先证明原始样例有效，避免把无效输入误判为格式化错误。
      const original = execute('original', source);
      const value = alternate ? 43 : 17;
      expect(original).toContain(`FIRST=${value} TIME=0.001`);
      expect(original).toContain(`FINAL=${value} TIME=2.501`);
      const formatted = expectStableFormatting(source);
      expect(formatted).not.toBe(source);
      const actual = execute('formatted', formatted);
      // $finish 的文件名与行号会随格式化变化，只比较确定性的仿真记录。
      const records = (output: string) => output.split(/\r?\n/).filter(line => /^(FIRST|FINAL)=/.test(line));
      expect(records(actual)).toEqual(records(original));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 90000);
});
