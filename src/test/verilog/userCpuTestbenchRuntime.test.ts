// @index test-user-cpu-testbench-runtime — 用户 CPU TB 从 code.txt 读取 P6/P7 用户段和内核段的真实 Icarus 回归
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseModules } from '../../language/verilog/parser';
import { buildUserTestbenchText, userCpuTestbenchProfile } from '../../verilog/userCpuTestbench';
import { buildIverilogEnvironment, buildIverilogRuntimeArgs, resolveIverilogRuntime } from '../../verilog/iverilogRuntime';

const extensionRoot = path.resolve(__dirname, '../../..');
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const runtimeRoot = path.join(extensionRoot, 'vendor', 'iverilog', `${process.platform}-${process.arch}`);
const compiler = path.join(runtimeRoot, 'bin', `iverilog${executableSuffix}`);
const simulator = path.join(runtimeRoot, 'bin', `vvp${executableSuffix}`);
const runtimeAvailable = fs.existsSync(compiler) && fs.existsSync(simulator);
const imageWords = 4096;
const kernelWordIndex = (0x4180 - 0x3000) >>> 2;
const firstWord = '24081234';
const kernelWord = '3c091234';

describe.skipIf(!runtimeAvailable)('generated user CPU testbench with bundled Icarus', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-user-cpu-tb-'));
    const runtime = resolveIverilogRuntime(extensionRoot);
    const environment = buildIverilogEnvironment(runtime);
    for (const profile of ['P6', 'P7'] as const) {
      const dut = syntheticDut(profile);
      const module = parseModules(TextDocument.create(`${profile}.v`, 'verilog', 1, dut), dut)[0];
      const tb = buildUserTestbenchText(module, 'mips_tb', { profile, configuredTop: true, simTime: '1us' });
      expect(userCpuTestbenchProfile(tb)).toBe(profile);
      expect(dut).not.toContain('$readmemh');
      expect(tb).toContain('$readmemh("code.txt", inst);');
      fs.writeFileSync(path.join(workDir, `${profile}-dut.v`), dut);
      fs.writeFileSync(path.join(workDir, `${profile}-tb.v`), tb);
      const result = spawnSync(compiler, [
        ...buildIverilogRuntimeArgs(runtime), '-g2005', '-s', 'mips_tb',
        '-o', `${profile}.vvp`, `${profile}-dut.v`, `${profile}-tb.v`
      ], { cwd: workDir, env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    }
  });

  afterAll(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  for (const profile of ['P6', 'P7'] as const) {
    it(`${profile} reads selected and skipped ASM images through generated memory wiring`, () => {
      const program = Array.from({ length: imageWords }, () => '00000000');
      program[0] = firstWord;
      program[kernelWordIndex] = kernelWord;
      expect(runImage(workDir, profile, program)).toContain(`first=${firstWord} kernel=${kernelWord}`);

      const empty = Array.from({ length: imageWords }, () => '00000000');
      expect(runImage(workDir, profile, empty)).toContain('first=00000000 kernel=00000000');
    });
  }
});

function runImage(workDir: string, profile: 'P6' | 'P7', words: string[]): string {
  fs.writeFileSync(path.join(workDir, 'code.txt'), `${words.join('\n')}\n`);
  const runtime = resolveIverilogRuntime(extensionRoot);
  const result = spawnSync(simulator, ['-N', `${profile}.vvp`], {
    cwd: workDir, env: buildIverilogEnvironment(runtime), encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout.toLowerCase();
}

function syntheticDut(profile: 'P6' | 'P7'): string {
  return `\`timescale 1ns/1ps
module mips(
    input clk, input reset,
    input [31:0] i_inst_rdata, input [31:0] m_data_rdata,
    output reg [31:0] i_inst_addr,
    output [31:0] m_data_addr, output [31:0] m_data_wdata,
    output [3:0] m_data_byteen, output [31:0] m_inst_addr,
    output w_grf_we, output [4:0] w_grf_addr,
    output [31:0] w_grf_wdata, output [31:0] w_inst_addr${profile === 'P7' ? `,
    input interrupt, output [31:0] macroscopic_pc,
    output [31:0] m_int_addr, output [3:0] m_int_byteen` : ''}
);
    assign m_data_addr = 0;
    assign m_data_wdata = 0;
    assign m_data_byteen = 0;
    assign m_inst_addr = 0;
    assign w_grf_we = 0;
    assign w_grf_addr = 0;
    assign w_grf_wdata = 0;
    assign w_inst_addr = 0;
    ${profile === 'P7' ? 'assign macroscopic_pc = 0; assign m_int_addr = 0; assign m_int_byteen = 0;' : ''}
    reg [31:0] first_instruction;
    initial begin
        i_inst_addr = 32'h3000;
        @(negedge reset);
        #1 first_instruction = i_inst_rdata;
        i_inst_addr = 32'h4180;
        #1 $display("FIRST=%08h KERNEL=%08h", first_instruction, i_inst_rdata);
        $finish;
    end
endmodule
`;
}
