import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { P7ProbeMetadata } from '../../courseTesting/builtinAsmGenerator';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { courseTraceSimulationTime, p7ProbeExecutionInstructionBudget } from '../../courseTesting/pipeline/executionBudget';
import { buildTestbench, parseModules } from '../../language/verilog/parser';
import type { CustomInstructionEncodingMask } from '../../language/verilog/moduleUtils';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { buildIverilogCompileArgs, buildIverilogWatchdog, iverilogSimulationDefaults, verilogDurationToPicoseconds } from '../../verilog/iverilogRunner';
import { buildIverilogEnvironment, resolveIverilogRuntime } from '../../verilog/iverilogRuntime';
import { runProcessCore } from '../../processCore';

export interface LiveP7CpuProbeOptions {
  cpuRoot: string;
  machineCodeText: string;
  sourceAsm: string;
  probe: P7ProbeMetadata;
  haltPc: number;
  evidenceDir?: string;
  customInstructionEncodings?: readonly CustomInstructionEncodingMask[];
  /** Test-only public-bus completion observer; the production watchdog remains enabled. */
  observeHalt?: boolean;
}

/** Run production probe observation on an isolated copy of a flat course CPU source directory. */
export async function runLiveP7CpuProbe(options: LiveP7CpuProbeOptions) {
  if (!Number.isSafeInteger(options.haltPc) || options.haltPc < 0x3000 || options.haltPc > 0x6ff8 || options.haltPc % 4) {
    throw new Error('Live P7 probe requires a validated course halt PC');
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'co-live-p7-probe-'));
  try {
    const entries = await fs.readdir(options.cpuRoot, { withFileTypes: true });
    const sourceNames = entries.filter(entry => entry.isFile() && /\.(?:v|vh)$/i.test(entry.name)
      && !/(?:^tb\.|_tb\.|testbench)/i.test(entry.name)).map(entry => entry.name).sort();
    if (!sourceNames.includes('mips.v')) throw new Error('Live P7 CPU directory has no mips.v');
    for (const file of sourceNames) await fs.copyFile(path.join(options.cpuRoot, file), path.join(directory, file));
    await fs.writeFile(path.join(directory, 'program.asm'), options.sourceAsm);
    await fs.writeFile(path.join(directory, 'code.txt'), options.machineCodeText);
    const topText = await fs.readFile(path.join(directory, 'mips.v'), 'utf8');
    const top = parseModules(TextDocument.create('file:///mips.v', 'verilog', 1, topText), topText).find(module => module.name === 'mips');
    if (!top) throw new Error('Live P7 CPU mips.v has no mips module');
    await fs.writeFile(path.join(directory, 'private_tb.v'), buildTestbench(top, 'co_live_p7_tb', {
      profile: 'P7', finishDelay: false, p7Probe: options.probe,
      customInstructionEncodings: options.customInstructionEncodings
    }));
    await fs.writeFile(path.join(directory, 'watchdog.v'), buildIverilogWatchdog('co_live_p7_watchdog'));
    const observeHalt = options.observeHalt !== false;
    if (observeHalt) {
      // Only public TB buses are observed; no CPU internals or fixed pipeline timing.
      await fs.writeFile(path.join(directory, 'finish.v'), `module co_live_p7_finish;
integer visits = 0;
always @(posedge co_live_p7_tb.clk) begin
  if (!co_live_p7_tb.reset && co_live_p7_tb.i_inst_addr === 32'h${options.haltPc.toString(16)}
      && co_live_p7_tb.i_inst_rdata === 32'h1000ffff) begin
    visits = visits + 1;
    if (visits == 16) begin $display("CO_LIVE_PROBE observed_halt_fetches=16"); $finish; end
  end
end
endmodule\n`);
    }
    await fs.writeFile(path.join(directory, 'defaults.f'), iverilogSimulationDefaults);
    const runtime = resolveIverilogRuntime(process.cwd());
    const compiled = await runProcessCore(runtime.iverilogPath, buildIverilogCompileArgs({
      runtime, testbenchModule: 'co_live_p7_tb', watchdogModule: 'co_live_p7_watchdog',
      outputFile: 'cpu.vvp', dependencyFile: 'dependencies.txt', defaultsFile: 'defaults.f', workspaceRoot: directory,
      sourceFiles: [...sourceNames.filter(file => /\.v$/i.test(file)), 'private_tb.v'], watchdogFile: 'watchdog.v',
      ...(observeHalt ? { extraTopModules: [{ moduleName: 'co_live_p7_finish', file: 'finish.v' }] } : {})
    }), { cwd: directory, env: buildIverilogEnvironment(runtime), timeoutMs: 30_000,
      maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 4 * 1024 * 1024 });
    if (!compiled.ok) throw new Error(`Live P7 compile failed: ${compiled.stderr}`);
    const budget = verilogDurationToPicoseconds(courseTraceSimulationTime(p7ProbeExecutionInstructionBudget))!;
    const simulated = await runProcessCore(runtime.vvpPath, ['-N', 'cpu.vvp', `+co_watchdog_limit_ps=${budget}`], {
      cwd: directory, env: buildIverilogEnvironment(runtime), timeoutMs: 30_000,
      maxStdoutBytes: 16 * 1024 * 1024, maxStderrBytes: 2 * 1024 * 1024
    });
    const checked = checkP7Probe(simulated.stdout, parseSimOutput(simulated.stdout), options.probe);
    const observedHalt = simulated.stdout.includes('CO_LIVE_PROBE observed_halt_fetches=16');
    if (options.evidenceDir) {
      await fs.mkdir(options.evidenceDir, { recursive: true });
      const digest = (text: string) => createHash('sha256').update(text).digest('hex');
      await Promise.all([
        ...['program.asm', 'code.txt', 'private_tb.v', 'watchdog.v', ...(observeHalt ? ['finish.v'] : [])]
          .map(file => fs.copyFile(path.join(directory, file), path.join(options.evidenceDir!, file))),
        fs.writeFile(path.join(options.evidenceDir, 'trace.out'), simulated.stdout),
        fs.writeFile(path.join(options.evidenceDir, 'result.json'), JSON.stringify({
          cpuRoot: options.cpuRoot, shard: options.probe.shard, scenarioCount: options.probe.scenarios.length,
          sourceSha256: digest(options.sourceAsm), machineCodeSha256: digest(options.machineCodeText),
          records: checked.records.length, passed: checked.passed, coverage: checked.coverage,
          simulationOk: simulated.ok, timedOut: simulated.timedOut, stopReason: simulated.stopReason,
          observedHalt, failures: checked.failures, diagnostics: checked.diagnostics
        }, null, 2) + '\n')
      ]);
    }
    return { compiled, simulated, checked, observedHalt };
  } finally {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('co-live-p7-probe-')) {
      throw new Error('Invalid live P7 test staging directory');
    }
    await fs.rm(target, { recursive: true, force: true });
  }
}
