import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateBuiltinAsmTestCase, type P7ProbeShard } from '../../courseTesting/builtinAsmGenerator';
import type { ProgramImage } from '../../mips/core/api';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { courseInstructionImageWords, findCourseHaltPc, wordsToHexText } from '../../mips/core/assembler/artifacts';
import { MipsRuntimeManager } from '../../mips/host/runtimeManager';
import { inspectScriptInstructions } from '../../mips/host/scriptInstructions';
import { validateScriptInstructionBundle, type ScriptInstructionBundle } from '../../mips/host/scriptInstructionBundle';
import { runLiveP7CpuProbe } from '../helpers/liveP7Cpu';

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  return createVscodeModuleMock(createVscodeMockState(), vi.fn);
});

const cpuRoot = process.env.CO_P7_CPU_ROOT;
const evidenceRoot = process.env.CO_P7_PROBE_EVIDENCE_DIR;
const probes: ReadonlyArray<{ shard: P7ProbeShard; count: number }> = [
  { shard: 'timer', count: 12 }, { shard: 'mmio', count: 26 }, { shard: 'return', count: 2 }
];
const cases = (['js', 'ts'] as const).flatMap(extension => probes.map(probe => ({ extension, ...probe })));

async function assembleScript(runtime: MipsRuntimeManager, bundle: ScriptInstructionBundle, text: string, id: string): Promise<ProgramImage> {
  const result = await runtime.runScriptJob(bundle, { kind: 'assembler-assemble', payload: {
    profile: 'P7', sources: [{ id, text }]
  } });
  expect(result, JSON.stringify(result)).toMatchObject({ kind: 'result', ok: true, payload: { ok: true } });
  if (result.kind !== 'result') throw new Error('Expected script assembly result');
  return (result.payload as { image: ProgramImage }).image;
}

/** Optional DUT-only evidence: no external Timer oracle and no changes to the original RTL. */
describe.runIf(Boolean(cpuRoot))('real P7 probes retain Timer/MMIO/eret after JS/TS custom assembly', () => {
  let directory: string | undefined;
  let runtime: MipsRuntimeManager | undefined;
  const bundles = new Map<'js' | 'ts', ScriptInstructionBundle>();

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'co-script-live-p7-中文 '));
    const workerPath = path.join(directory, 'script-worker.cjs');
    const built = await build({
      entryPoints: [path.resolve('src/mips/host/scriptInstructionWorker.ts')], outfile: workerPath,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', write: false,
      // Keep the production top-level out/ resource anchor without sharing build output.
      define: { __dirname: JSON.stringify(path.resolve('out')) }
    });
    await fs.writeFile(workerPath, built.outputFiles![0].contents);
    runtime = new MipsRuntimeManager({ scriptWorkerPath: workerPath });
    for (const extension of ['js', 'ts'] as const) {
      const root = path.join(directory, extension);
      const instructionDirectory = path.join(root, '.co', 'custom-instructions');
      await fs.mkdir(instructionDirectory, { recursive: true });
      await fs.writeFile(path.join(instructionDirectory, `coori.${extension}`), `
import { defineInstruction } from '@buaa-co/instructions';
const mask${extension === 'ts' ? ': number' : ''} = 0xffff;
export default defineInstruction({
  apiVersion: 1, mnemonic: 'coori', modes: ['P7'], override: true,
  encoding: '001101 rs:5 rt:5 immediate:16',
  operands: [{ kind: 'register', field: 'rt' }, { kind: 'register', field: 'rs' }, { kind: 'immediate', field: 'immediate' }],
  access: { reads: ['rs'], writes: ['rt'] },
  execute(cpu, fields) {
    return { gprWrites: [{ register: fields.rt, value: cpu.readGpr(fields.rs) | (fields.immediate & mask) }] };
  }
});
`, 'utf8');
      const captured = await runtime.runIsolatedJob({ kind: 'script-capture', payload: { workspaceRoot: root } });
      expect(captured, JSON.stringify(captured)).toMatchObject({ kind: 'result', ok: true });
      if (captured.kind !== 'result') throw new Error('Expected captured instruction bundle');
      const bundle = validateScriptInstructionBundle(captured.payload);
      bundles.set(extension, bundle);
      expect(bundle.entries).toEqual([`coori.${extension}`]);
      expect(await inspectScriptInstructions(bundle, runtime, 'P7')).toMatchObject([
        { mnemonic: 'coori', mask: 0xfc000000, value: 0x34000000 }
      ]);
      // Verify the loaded callback as well as the assembler before using a DUT-only lane.
      const smoke = await assembleScript(runtime, bundle, '.text\ncoori $3,$0,0x1234\nhalt:beq $0,$0,halt\nnop\n', `coori-${extension}`);
      const execution = await runtime.runScriptJob(bundle, { kind: 'machine-execute', payload: {
        profile: 'P7', entryPc: '0x00003000', haltPc: '0x00003004', maxSteps: 12, collectTrace: true,
        segments: smoke.segments.filter(segment => segment.words.length).map(segment => ({
          name: segment.name, baseAddress: `0x${segment.baseAddress.toString(16).padStart(8, '0')}`,
          words: segment.words.map(word => `0x${word.toString(16).padStart(8, '0')}`)
        }))
      } });
      expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true, payload: {
        status: 'halted', trace: expect.arrayContaining(['@00003000: $3 <= 00001234'])
      } });
    }
  });

  afterAll(async () => {
    runtime?.dispose();
    if (!directory) return;
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('co-script-live-p7-中文 ')) {
      throw new Error('Invalid custom P7 test staging directory');
    }
    await fs.rm(target, { recursive: true, force: true });
  });

  it.each(cases)('$extension custom assembly preserves all $count live $shard records', async ({ extension, shard, count }) => {
    const bundle = bundles.get(extension)!;
    const generated = generateBuiltinAsmTestCase({
      profile: 'P7', instructionText: '', instructionCount: 1118,
      seed: `live-real-cpu-${shard}-timer-enabled`, p7StressMode: 'probe', probeShard: shard,
      probeScenarioCount: count, probeReturnVariant: 'direct', interrupt: true, timerInterrupt: true
    });
    const metadata = generated.probe!;
    expect(metadata.scenarios).toHaveLength(count);
    // Replace source mnemonics after ordinary generation; the probe remains a native scaffold.
    const customSource = generated.text.replace(/^(\s*)ori(?=\s)/gm, '$1coori');
    const aliasCount = (customSource.match(/^\s*coori\s/gm) ?? []).length;
    expect(aliasCount).toBeGreaterThan(0);
    expect(customSource).not.toBe(generated.text);
    const baseline = assembleCourseSource({ id: 'standard-p7-probe', text: generated.text }, { profile: 'P7' });
    expect(baseline.ok, JSON.stringify(baseline.diagnostics)).toBe(true);
    const image = await assembleScript(runtime!, bundle, customSource, `script-${extension}-${shard}`);
    const machineCodeText = wordsToHexText(courseInstructionImageWords(image));
    expect(machineCodeText).toBe(wordsToHexText(courseInstructionImageWords(baseline.image!)));
    const haltPc = findCourseHaltPc(image, 'P7');
    expect(haltPc).toBe(findCourseHaltPc(baseline.image!, 'P7'));
    expect(haltPc).toBeDefined();
    const customInstructionEncodings = await inspectScriptInstructions(bundle, runtime, 'P7');
    const evidenceDir = evidenceRoot ? path.join(evidenceRoot, 'script-custom', extension, shard) : undefined;
    if (evidenceDir) {
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(path.join(evidenceDir, 'custom-instructions.json'), JSON.stringify(bundle, null, 2) + '\n');
    }
    const { simulated, checked, observedHalt } = await runLiveP7CpuProbe({
      cpuRoot: cpuRoot!, machineCodeText, sourceAsm: customSource, probe: metadata, haltPc: haltPc!,
      customInstructionEncodings, ...(evidenceDir ? { evidenceDir } : {})
    });
    console.info(JSON.stringify({ cpuRoot, extension, shard, seed: generated.seed, bundleDigest: bundle.digest,
      aliasCount, scenarioCount: metadata.scenarios.length, records: checked.records.length,
      passed: checked.passed, simulationOk: simulated.ok, observedHalt, failures: checked.failures }));
    expect(simulated.ok, simulated.stderr || simulated.stdout.slice(-2000)).toBe(true);
    expect(observedHalt).toBe(true);
    expect(checked.failures, JSON.stringify(checked.failures)).toEqual([]);
    expect(checked.coverage?.filter(coverage => !coverage.covered) ?? []).toEqual([]);
    expect(checked.passed).toBe(true);
    expect(checked.records).toHaveLength(count);
  }, 60_000);
});
