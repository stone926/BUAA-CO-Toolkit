import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseModules } from '../../language/verilog/parser';
import type { VerilogModule } from '../../language/verilog/model';
import { findDeclaration, findDumpableMemories, resolveHierarchy } from '../../waveform/design/designHierarchy';
import { buildWaveformDumper, dumpFileArgument, waveformDumperModuleName } from '../../waveform/design/waveformDumper';
import { traceFromSimulationOutput } from '../../waveform/host/waveformTraceSource';
import { changeIndexAt } from '../../waveform/model/signalValues';
import { formatTrackValue } from '../../waveform/model/valueFormat';
import { parseVcd } from '../../waveform/vcd/vcdReader';

const design = `\`timescale 1ns/1ps
module grf #(parameter DEPTH = 8) (input clk, input reset, input we, input [4:0] a3, input [31:0] wd);
    reg [31:0] regs [0:DEPTH-1];
    integer i;
    always @(posedge clk) begin
        if (reset) begin
            for (i = 0; i < DEPTH; i = i + 1) regs[i] <= 0;
        end else if (we && a3 != 0) begin
            regs[a3] <= wd;
        end
    end
endmodule

module cpu (input clk, input reset);
    reg [4:0] a3;
    reg [31:0] wd;
    reg we;
    reg [31:0] im [0:4095];
    reg [7:0] fifo [3:0];
    grf #(.DEPTH(32)) GRF (.clk(clk), .reset(reset), .we(we), .a3(a3), .wd(wd));
    always @(posedge clk) begin
        if (reset) begin
            a3 <= 0; wd <= 0; we <= 0;
        end else begin
            we <= 1; a3 <= a3 + 1; wd <= wd + 32'h11;
            fifo[a3[1:0]] <= wd[7:0];
        end
    end
endmodule

module tb;
    reg clk = 0;
    reg reset = 1;
    cpu uut (.clk(clk), .reset(reset));
    always #5 clk = ~clk;
    initial begin
        #12 reset = 0;
        #200 $finish;
    end
    always @(posedge clk) begin
        if (!reset && uut.we && uut.a3 != 0) $display("%d@%h: $%d <= %h", $time, 32'h00003000, uut.a3, uut.wd);
    end
endmodule
`;

function lookupFor(text: string): (name: string) => VerilogModule | undefined {
  const modules = parseModules(TextDocument.create('file:///design.v', 'verilog', 0, text), text);
  return (name) => modules.find((module) => module.name === name);
}

describe('design hierarchy for waveform dumps', () => {
  const lookup = lookupFor(design);

  it('finds small memories below the testbench with parameter overrides', () => {
    expect(findDumpableMemories(lookup('tb')!, lookup)).toEqual([
      { path: 'tb.uut.fifo', first: 0, last: 3 },
      { path: 'tb.uut.GRF.regs', first: 0, last: 31 }
    ]);
    expect(findDumpableMemories(lookup('tb')!, lookup, { maximumWords: 8, maximumInstances: 8, maximumMemories: 8, maximumDepth: 8 }))
      .toEqual([{ path: 'tb.uut.fifo', first: 0, last: 3 }]);
    expect(findDumpableMemories(lookup('tb')!, lookup, { maximumWords: 64, maximumInstances: 8, maximumMemories: 8, maximumDepth: 0 }))
      .toEqual([]);
  });

  it('survives recursive instantiation and unknown modules', () => {
    const recursive = lookupFor('module a; b x(); endmodule\nmodule b; a y(); reg [1:0] m [0:1]; missing z(); endmodule');
    expect(findDumpableMemories(recursive('a')!, recursive)).toEqual([{ path: 'a.x.m', first: 0, last: 1 }]);
  });

  it('resolves VCD scope paths back to declarations', () => {
    const resolved = resolveHierarchy(lookup('tb')!, ['uut', 'GRF'], lookup);
    expect(resolved.module.name).toBe('grf');
    expect(resolved.instance?.instance.instanceName).toBe('GRF');
    expect(findDeclaration(resolved.module, 'regs[3]')?.name).toBe('regs');
    expect(findDeclaration(resolved.module, 'clk')?.name).toBe('clk');
    expect(resolveHierarchy(lookup('tb')!, ['uut', 'genblk1', 'GRF'], lookup).module.name).toBe('grf');
  });

  it('generates a dumper with a stable, collision-resistant module name', () => {
    const name = waveformDumperModuleName('E:/工作区/cpu project');
    expect(name).toMatch(/^__co_iverilog_wave_[0-9a-f]{16}$/);
    expect(waveformDumperModuleName('E:/工作区/cpu project')).toBe(name);
    const text = buildWaveformDumper({ moduleName: name, testbench: 'tb', dumpFile: '../wave/t"b.vcd', memories: [{ path: 'tb.uut.GRF.regs', first: 0, last: 31 }] });
    expect(text).toContain(`module ${name};`);
    expect(text).toContain('$printtimescale(tb);');
    expect(text).toContain('$dumpfile("../wave/t\\"b.vcd");');
    expect(text).toContain('$dumpvars(0, tb);');
    expect(text).toContain('for (__co_word = 0; __co_word <= 31; __co_word = __co_word + 1) $dumpvars(0, tb.uut.GRF.regs[__co_word]);');
    expect(dumpFileArgument(path.join('ws', '.co', 'isim'), path.join('ws', '.co', 'wave', 'tb.vcd'))).toBe('../wave/tb.vcd');
  });
});

const extensionRoot = path.resolve(__dirname, '../../..');
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const runtimeRoot = path.join(extensionRoot, 'vendor', 'iverilog', `${process.platform}-${process.arch}`);
const compiler = path.join(runtimeRoot, 'bin', `iverilog${executableSuffix}`);
const simulator = path.join(runtimeRoot, 'bin', `vvp${executableSuffix}`);
const runtimeAvailable = fs.existsSync(compiler) && fs.existsSync(simulator);

describe.skipIf(!runtimeAvailable)('waveform dumper with bundled Icarus', () => {
  let workDir: string;
  let stdout = '';

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co 波形 dumper-'));
    fs.mkdirSync(path.join(workDir, 'isim'));
    fs.mkdirSync(path.join(workDir, 'wave'));
    fs.writeFileSync(path.join(workDir, 'design.v'), design);
    const lookup = lookupFor(design);
    const moduleName = waveformDumperModuleName(workDir);
    fs.writeFileSync(path.join(workDir, 'isim', 'dumper.v'), buildWaveformDumper({
      moduleName,
      testbench: 'tb',
      dumpFile: dumpFileArgument(path.join(workDir, 'isim'), path.join(workDir, 'wave', 'tb.vcd')),
      memories: findDumpableMemories(lookup('tb')!, lookup)
    }));
    const compile = spawnSync(compiler, [
      '-B', path.join(runtimeRoot, 'lib', 'ivl'), '-g2005', '-s', 'tb', '-s', moduleName,
      '-o', 'sim.vvp', path.join(workDir, 'design.v'), 'dumper.v'
    ], { cwd: path.join(workDir, 'isim'), encoding: 'utf8', timeout: 20000 });
    expect(compile.error).toBeUndefined();
    expect(compile.status, compile.stderr).toBe(0);
    const run = spawnSync(simulator, ['-N', 'sim.vvp'], { cwd: path.join(workDir, 'isim'), encoding: 'utf8', timeout: 20000 });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    stdout = run.stdout;
  }, 60000);

  afterAll(() => {
    if (workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('records every net plus each register word, and pairs the trace', () => {
    expect(stdout).toContain('Time scale of (tb) is 1ns / 1ps');
    expect(stdout).toContain('VCD info: dumpfile ../wave/tb.vcd opened for output.');
    const data = parseVcd(fs.readFileSync(path.join(workDir, 'wave', 'tb.vcd')));
    expect(data.diagnostics).toEqual([]);
    expect(data.timescale).toMatchObject({ magnitude: 1, unit: 'ps' });
    const paths = new Set(data.vars.map((variable) => variable.path));
    expect(paths.has('tb.clk')).toBe(true);
    expect(paths.has('tb.uut.GRF.wd')).toBe(true);
    expect(paths.has('tb.uut.GRF.regs[31]')).toBe(true);
    expect(paths.has('tb.uut.fifo[3]')).toBe(true);
    expect([...paths].some((path) => path.startsWith('tb.uut.im'))).toBe(false);

    const trace = traceFromSimulationOutput(stdout, 'tb.vcd', data.timescale, 'tb.sim.out')!;
    expect(trace.events.length).toBeGreaterThan(5);
    // Each GRF write shows up in the dumped register word at the traced edge.
    for (const event of trace.events) {
      const variable = data.vars.find((candidate) => candidate.path === `tb.uut.GRF.regs[${Number.parseInt(event.target, 10)}]`)!;
      const index = changeIndexAt(data.tracks, variable.track, event.time);
      expect(formatTrackValue(data.tracks, variable.track, index, 'hex'), `${event.time} $${event.target}`).toBe(event.value);
    }
  });
});
