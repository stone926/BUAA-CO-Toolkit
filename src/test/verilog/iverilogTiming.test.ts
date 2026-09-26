import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildIverilogCompileArgs, buildIverilogWatchdog, iverilogSimulationDefaults } from '../../verilog/iverilogRunner';
import { buildIverilogEnvironment, resolveIverilogRuntime } from '../../verilog/iverilogRuntime';
import { traceFromSimulationOutput } from '../../waveform/host/waveformTraceSource';
import { parseVcd } from '../../waveform/vcd/vcdReader';

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  return createVscodeModuleMock(createVscodeMockState(), vi.fn);
});

const runtime = resolveIverilogRuntime(path.resolve(__dirname, '../../..'));
const available = fs.existsSync(runtime.iverilogPath) && fs.existsSync(runtime.vvpPath);

describe.skipIf(!available)('course simulation time with bundled Icarus', () => {
  const directories: string[] = [];
  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([false, true])('keeps DUT timestamps aligned with VCD (testbench first: %s)', (testbenchFirst) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'co 时间尺度 '));
    directories.push(directory);
    const write = (name: string, text: string) => {
      const file = path.join(directory, name);
      fs.writeFileSync(file, text);
      return file;
    };
    // GRF/DM-like modules without a timescale, including resetall used by headers.
    const dut = write('dut.v', `
module grf(input clk);
  reg [31:0] value = 0;
  always @(posedge clk) begin
    value <= value + 1;
    $display("%d@00003000: $1 <= %h", $time, value + 32'd1);
  end
endmodule
\`resetall
module dm(input clk);
  always @(posedge clk) $display("%d@00003004: *00000000 <= 00000001", $time);
endmodule
`);
    const explicit = write('explicit.v', `\`timescale 10ns/1ns
module explicit_scale;
  initial begin
    #2;
    $display("EXPLICIT_TIME=%0d", $time);
  end
endmodule
`);
    const tb = write('tb.v', `\`timescale 1ns/1ps
module tb;
  reg clk = 0;
  grf g(clk);
  dm d(clk);
  explicit_scale e();
  always #5 clk = ~clk;
  initial begin
    $printtimescale(tb);
    $dumpfile("tb.vcd");
    $dumpvars(0, tb);
  end
endmodule
`);
    const defaultsFile = write('defaults.f', iverilogSimulationDefaults);
    const watchdogFile = write('watchdog.v', buildIverilogWatchdog('__watchdog'));
    const outputFile = path.join(directory, 'simulation.vvp');
    const args = buildIverilogCompileArgs({
      runtime, testbenchModule: 'tb', watchdogModule: '__watchdog', outputFile,
      dependencyFile: path.join(directory, 'dependencies'), defaultsFile,
      workspaceRoot: directory, watchdogFile,
      sourceFiles: testbenchFirst ? [tb, dut, explicit] : [dut, explicit, tb]
    });
    const options = { cwd: directory, encoding: 'utf8' as const, timeout: 20000, env: buildIverilogEnvironment(runtime) };
    const compile = spawnSync(runtime.iverilogPath, args, options);
    expect(compile.error).toBeUndefined();
    expect(compile.status, compile.stderr).toBe(0);
    const run = spawnSync(runtime.vvpPath, ['-N', outputFile, '+co_watchdog_limit_ps=30000'], options);
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('EXPLICIT_TIME=2');
    const data = parseVcd(fs.readFileSync(path.join(directory, 'tb.vcd')));
    expect(data.timescale).toMatchObject({ magnitude: 1, unit: 'ps' });
    expect(data.endTime).toBe(30001); // Watchdog retains its explicit 1ps unit.
    const trace = traceFromSimulationOutput(run.stdout, 'tb.vcd', data.timescale, 'tb.sim.out')!;
    expect(trace.events.filter((event) => event.kind === 'grf').map((event) => event.time))
      .toEqual([5000, 15000, 25000]);
    expect(trace.events.filter((event) => event.kind === 'dm').map((event) => event.time))
      .toEqual([5000, 15000, 25000]);
    const value = data.vars.find((variable) => variable.path === 'tb.g.value')!;
    expect(Array.from(data.tracks.times.subarray(
      data.tracks.changeStart[value.track], data.tracks.changeStart[value.track + 1]
    ))).toEqual([0, 5000, 15000, 25000]);
  });
});
