import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { MipsRuntimeManager } from '../../mips/host/runtimeManager';
import { validateScriptInstructionBundle } from '../../mips/host/scriptInstructionBundle';
import type { ProgramImage } from '../../mips/core/api';
import { courseInstructionImageWords, wordsToHexText } from '../../mips/core/assembler/artifacts';
import { buildTestbench, parseModules } from '../../language/verilog/parser';
import { compareTraceIterables } from '../../language/mips/traceCompare';
import { iterCpuTraceEvents } from '../../language/mips/traceParser';
import { runProcessCore } from '../../processCore';
import { resolveIverilogRuntime, buildIverilogEnvironment, buildIverilogRuntimeArgs, buildIverilogIncludeArgs } from '../../verilog/iverilogRuntime';

const originals = process.env.CO_CUSTOM_CPU_ROOT;
describe.runIf(Boolean(originals))('TypeScript instruction definitions against real P5 RTL', () => {
  let directory: string, workerPath: string;
  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'co-script-real-cpu-'));
    workerPath = path.join(directory, 'worker.cjs');
    const built = await build({ entryPoints: [path.resolve('src/mips/host/scriptInstructionWorker.ts')], outfile: workerPath,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', write: false, define: { __dirname: JSON.stringify(path.resolve('out')) } });
    await fs.writeFile(workerPath, built.outputFiles![0].contents);
  });
  afterAll(async () => {
    if (directory && path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('co-script-real-cpu-')) await fs.rm(directory, { recursive: true, force: true });
  });
  it.each([
    ['p5_blztal_1047', 'P5_L3_blztal_2022',
      '.text\nori $2,$0,1\nsub $1,$0,$2\nblztal $1,$2,1\nori $3,$0,0x33\nori $4,$0,0xdead\nsw $31,0($0)\nori $1,$0,1\nblztal $1,$2,1\nori $5,$0,0x55\nori $6,$0,0x66\nsw $6,4($0)\nhalt: beq $0,$0,halt\nnop\n'],
    ['p5_bonall_1046', 'P5_L2_bonall_2022',
      '.text\nori $1,$0,1\nsub $2,$0,$1\nbonall $1,$2,target\nori $3,$0,0x33\nori $4,$0,0xdead\ntarget: sw $31,0($0)\nbonall $1,$1,fail\nori $5,$0,0xbeef\nori $6,$0,0x66\nbeq $0,$0,done\nnop\nfail: ori $7,$0,0xbad\ndone: sw $6,4($0)\nhalt: beq $0,$0,halt\nnop\n']
  ])('compares frozen TS %s assembly/oracle with RTL and detects an isolated writeback mutation', async (cpuName, fixture, text) => {
    const root = path.join(directory, cpuName), scripts = path.join(root, '.co/custom-instructions'), cpu = path.join(root, 'cpu');
    await fs.mkdir(scripts, { recursive: true });
    await fs.mkdir(cpu);
    await fs.copyFile(path.resolve('src/test/fixtures/customInstructions', fixture, 'instruction.ts'), path.join(scripts, 'instruction.ts'));
    const manager = new MipsRuntimeManager({ scriptWorkerPath: workerPath });
    try {
      const captured = await manager.runIsolatedJob({ kind: 'script-capture', payload: { workspaceRoot: root } });
      expect(captured, JSON.stringify(captured)).toMatchObject({ ok: true });
      if (captured.kind !== 'result') throw new Error('Expected captured instruction snapshot');
      const bundle = validateScriptInstructionBundle(captured.payload);
      const assembled = await manager.runScriptJob(bundle, { kind: 'assembler-assemble', payload: { profile: 'P5', sources: [{ id: 'main', text }] } });
      expect(assembled, JSON.stringify(assembled)).toMatchObject({ ok: true, payload: { ok: true } });
      if (assembled.kind !== 'result') throw new Error('Expected assembly result');
      const image = (assembled.payload as { image: ProgramImage }).image;
      const haltPc = image.symbols.find(symbol => symbol.name === 'halt')!.value!;
      const oracle = await manager.runScriptJob(bundle, { kind: 'machine-execute', payload: {
        profile: 'P5', enabledLayers: ['required'], entryPc: '0x00003000', haltPc: `0x${haltPc.toString(16).padStart(8, '0')}`, maxSteps: 1000, collectTrace: true,
        segments: image.segments.filter(segment => segment.words.length).map(segment => ({ name: segment.name, baseAddress: `0x${segment.baseAddress.toString(16).padStart(8, '0')}`,
          words: segment.words.map(word => `0x${word.toString(16).padStart(8, '0')}`) }))
      } });
      expect(oracle, JSON.stringify(oracle)).toMatchObject({ ok: true, payload: { status: 'halted' } });
      if (oracle.kind !== 'result') throw new Error('Expected oracle trace');
      const trace = (oracle.payload as { trace: string[] }).trace.join('\n');
      const original = path.join(originals!, cpuName);
      const files = (await fs.readdir(original)).filter(file => /\.(?:v|vh)$/i.test(file));
      for (const file of files) await fs.copyFile(path.join(original, file), path.join(cpu, file));
      await fs.writeFile(path.join(cpu, 'code.txt'), wordsToHexText(courseInstructionImageWords(image)));
      const topText = await fs.readFile(path.join(cpu, 'mips.v'), 'utf8');
      const top = parseModules(TextDocument.create('file:///mips.v', 'verilog', 1, topText), topText).find(module => module.name === 'mips')!;
      await fs.writeFile(path.join(cpu, 'tb.v'), buildTestbench(top, 'tb', { profile: 'P5', finishDelay: '2000' }));
      const runtime = resolveIverilogRuntime(process.cwd());
      const simulate = async () => {
        const sources = files.filter(file => /\.v$/i.test(file));
        const compiled = await runProcessCore(runtime.iverilogPath, [...buildIverilogRuntimeArgs(runtime), '-g2005',
          ...buildIverilogIncludeArgs(cpu, files.map(file => path.join(cpu, file))), '-s', 'tb', '-o', 'cpu.out', 'tb.v', ...sources],
        { cwd: cpu, env: buildIverilogEnvironment(runtime), timeoutMs: 30000 });
        expect(compiled.ok, compiled.stderr).toBe(true);
        const output = await runProcessCore(runtime.vvpPath, ['-N', 'cpu.out'], { cwd: cpu, env: buildIverilogEnvironment(runtime), timeoutMs: 30000 });
        expect(output.ok, output.stderr).toBe(true);
        return compareTraceIterables(iterCpuTraceEvents(trace), iterCpuTraceEvents(output.stdout), { compareCycles: false });
      };
      const correct = await simulate();
      expect(correct.matched, JSON.stringify(correct.entries.slice(0, 3))).toBe(true);
      const grf = path.join(cpu, 'GRF.v'), originalGrf = await fs.readFile(grf, 'utf8');
      await fs.writeFile(grf, originalGrf.replace(/\$display\(([^;]+)\);/, (_all, args: string) => {
        const changed = args.replace(/([A-Za-z_]\w*)\s*$/, "($1 ^ 32'h1)");
        expect(changed).not.toBe(args);
        return `$display(${changed});`;
      }));
      expect((await simulate()).matched).toBe(false);
      expect(await fs.readFile(path.join(original, 'GRF.v'), 'utf8')).toBe(originalGrf);
    } finally { manager.dispose(); }
  }, 60000);
});
