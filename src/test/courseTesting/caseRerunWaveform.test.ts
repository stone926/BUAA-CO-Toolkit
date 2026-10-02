import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { courseRerunWaveformCapture } from '../../courseTesting/caseRerunWaveform';
import { runVerilogSimulation, type VerilogSimulationRunOutput } from '../../verilog/simulationRunner';
import { createTestServices, createTestRunResult } from '../helpers/appServices';
import { parseVcd } from '../../waveform/vcd/vcdReader';
import { loadTraceForVcd } from '../../waveform/host/waveformTraceSource';

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  return createVscodeModuleMock(createVscodeMockState(), vi.fn);
});
vi.mock('../../verilog/simulationRunner', () => ({ runVerilogSimulation: vi.fn() }));

const runtimeRoot = path.resolve(__dirname, '../../../vendor/iverilog', `${process.platform}-${process.arch}`);
const suffix = process.platform === 'win32' ? '.exe' : '';
const compiler = path.join(runtimeRoot, 'bin', `iverilog${suffix}`);
const simulator = path.join(runtimeRoot, 'bin', `vvp${suffix}`);

describe.skipIf(!existsSync(compiler) || !existsSync(simulator))('automatic case VCD capture with bundled Icarus', () => {
  let root: string;
  let dump: vscode.Uri;
  let source: string;
  let beforeCompile: (() => Promise<void>) | undefined;
  const services = createTestServices();
  beforeEach(async () => {
    vi.clearAllMocks();
    beforeCompile = undefined;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'co 重跑 波形-'));
    dump = vscode.Uri.file(path.join(root, 'new-case', 'program.vcd'));
    source = path.join(root, 'design.v');
    await fs.writeFile(source, `\`timescale 1ns/1ps
module cpu #(parameter SIZE=32)(input clk);
reg [31:0] regs [0:SIZE-1];
initial regs[1]=0;
always @(posedge clk) begin
regs[1]<=regs[1]+1;
$display("%d@00003000: $1 <= %h", $time, regs[1]+1);
end
endmodule
module private_course_tb;
reg clk=0;
cpu dut(clk);
always #5 clk=~clk;
initial #100 $finish;
endmodule
`);
    vi.mocked(vscode.workspace.fs.createDirectory).mockImplementation(async (uri) => { await fs.mkdir(uri.fsPath, { recursive: true }); });
    vi.mocked(runVerilogSimulation).mockImplementation(async (_services, options = {}) => {
      const context = {
        folder: { uri: vscode.Uri.file(root), name: 'fixture', index: 0 },
        outDir: vscode.Uri.file(root),
        testbench: { moduleName: 'private_course_tb', sourceUri: vscode.Uri.file(source) },
        sourceFiles: [vscode.Uri.file(source)]
      };
      const tops = await options.generatedTopModules!(context as never);
      for (const top of tops) await fs.writeFile(path.join(root, top.fileName), top.text);
      await beforeCompile?.();
      const compile = spawnSync(compiler, [
        '-B', path.join(runtimeRoot, 'lib', 'ivl'), '-g2005', '-s', 'private_course_tb',
        ...tops.flatMap((top) => ['-s', top.moduleName]), '-o', 'simulation.vvp', source,
        ...tops.map((top) => top.fileName)
      ], { cwd: root, encoding: 'utf8', timeout: 20000 });
      const compileResult = createTestRunResult({ ok: compile.status === 0, exitCode: compile.status, stderr: compile.stderr, stdout: compile.stdout });
      const output = { generated: { outDir: vscode.Uri.file(root) }, compileResult } as VerilogSimulationRunOutput;
      if (compileResult.ok && options.acceptCompileResult!(compileResult)) {
        const run = spawnSync(simulator, ['-N', 'simulation.vvp'], { cwd: root, encoding: 'utf8', timeout: 20000 });
        output.simResult = createTestRunResult({ ok: run.status === 0, exitCode: run.status, stdout: run.stdout, stderr: run.stderr });
        output.simOut = vscode.Uri.file(path.join(path.dirname(dump.fsPath), 'program.sim.out'));
        await fs.writeFile(output.simOut.fsPath, run.stdout);
      }
      return output;
    });
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('dumps the automatic TB and GRF words, preserves budgets/IRQ inputs and pairs its exact trace', async () => {
    const capture = courseRerunWaveformCapture(dump);
    const options = {
      nonInteractive: true,
      simTime: '4195us',
      interruptSchedule: [0x3004],
      p7Probe: { version: 1 as const, logBase: 0x100, recordWords: 8, scenarios: [] },
      simOutputUri: vscode.Uri.file(path.join(root, 'new-case', 'program.sim.out'))
    };
    const run = await capture.runDut(services, options);
    expect(run?.simResult?.ok, run?.simResult?.stderr).toBe(true);
    expect(capture.waveform?.fsPath).toBe(dump.fsPath);
    expect(capture.issue).toBeUndefined();
    expect(vi.mocked(runVerilogSimulation).mock.calls[0][1]).toMatchObject(options);
    const data = parseVcd(await fs.readFile(dump.fsPath));
    expect(data.vars.some((variable) => variable.path === 'private_course_tb.dut.regs[31]')).toBe(true);
    expect((await loadTraceForVcd(dump.fsPath, data.timescale))?.events).toHaveLength(10);
  });

  it('retries only rejected memory dumps while retaining the automatic DUT inputs', async () => {
    const original = await fs.readFile(source, 'utf8');
    // Exercise a design changed between discovery and compilation: the compiler
    // rejects out-of-range dump words, and the normal CPU run can still finish.
    beforeCompile = async () => {
      await fs.writeFile(source, original.replace('SIZE=32', 'SIZE=4'));
      beforeCompile = undefined;
    };
    const capture = courseRerunWaveformCapture(dump);
    const options = { nonInteractive: true, simTime: '4195us', interruptSchedule: [0x3004] };
    const run = await capture.runDut(services, options);
    expect(run?.simResult?.ok).toBe(true);
    expect(runVerilogSimulation).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(runVerilogSimulation).mock.calls) expect(call[1]).toMatchObject(options);
    expect(capture.waveform?.fsPath).toBe(dump.fsPath);
    const data = parseVcd(await fs.readFile(dump.fsPath));
    expect(data.vars.some((variable) => variable.path === 'private_course_tb.clk')).toBe(true);
    expect(data.vars.some((variable) => variable.path.includes('regs['))).toBe(false);
  });

  it('reports missing dump provenance without inventing a waveform path', async () => {
    vi.mocked(runVerilogSimulation).mockResolvedValue({
      generated: { outDir: vscode.Uri.file(root) },
      compileResult: createTestRunResult(), simResult: createTestRunResult({ stdout: 'CPU trace only' })
    } as VerilogSimulationRunOutput);
    const capture = courseRerunWaveformCapture(dump);
    await capture.runDut(services, { nonInteractive: true });
    expect(capture.waveform).toBeUndefined();
    expect(capture.issue).toContain('没有声明打开');
  });

  it('retries compiler errors in the silent automatic lane even when no UI classification hook runs', async () => {
    const original = await fs.readFile(source, 'utf8');
    beforeCompile = async () => {
      await fs.writeFile(source, original.replace(/regs/g, 'bank'));
      beforeCompile = undefined;
    };
    const capture = courseRerunWaveformCapture(dump);
    const run = await capture.runDut(services, { nonInteractive: true, showMessages: false, simTime: '4195us' });
    expect(run?.simResult?.ok).toBe(true);
    expect(runVerilogSimulation).toHaveBeenCalledTimes(2);
    expect(capture.waveform?.fsPath).toBe(dump.fsPath);
    expect((await fs.readFile(dump.fsPath, 'utf8'))).toContain('$enddefinitions');
  });
});
