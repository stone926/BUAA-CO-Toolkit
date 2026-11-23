import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { generateBuiltinAsmTestCase, type P7ProbeShard } from '../../courseTesting/builtinAsmGenerator';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { courseInstructionImageWords, findCourseHaltPc, wordsToHexText } from '../../mips/core/assembler/artifacts';
import { runLiveP7CpuProbe } from '../helpers/liveP7Cpu';

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  return createVscodeModuleMock(createVscodeMockState(), vi.fn);
});

const cpuRoot = process.env.CO_P7_CPU_ROOT;
const evidenceRoot = process.env.CO_P7_PROBE_EVIDENCE_DIR;
const probes: ReadonlyArray<{ shard: P7ProbeShard; count: number }> = [
  { shard: 'timer', count: 12 }, { shard: 'mmio', count: 26 }, { shard: 'return', count: 2 },
  { shard: 'architecture', count: 18 }, { shard: 'im-boundaries', count: 11 }
];

/** Optional live-RTL evidence. The external oracle is intentionally absent from the DUT-only probe lane. */
describe.runIf(Boolean(cpuRoot))('real P7 CPU retains its Timer and interrupt black-box probe lane', () => {
  it.each(probes)('checks live $shard probe records', async ({ shard, count }) => {
    const generated = generateBuiltinAsmTestCase({
      profile: 'P7', instructionText: '', instructionCount: 1118,
      seed: `live-real-cpu-${shard}-timer-enabled`, p7StressMode: 'probe', probeShard: shard,
      probeScenarioCount: count, probeReturnVariant: 'direct', interrupt: true, timerInterrupt: true
    });
    const metadata = generated.probe!;
    expect(metadata.scenarios).toHaveLength(count);
    if (shard === 'timer') {
      for (const kind of ['timer0', 'timer1']) {
        expect(metadata.scenarios.filter(scenario => scenario.kind === kind).map(scenario => scenario.variant).sort())
          .toEqual(['disable-reload', 'mode0-max', 'mode0-min', 'mode1-repeat', 'mode1-stopped', 'pending-writes']);
      }
    }
    const assembled = assembleCourseSource({ id: 'live-p7-probe', text: generated.text }, { profile: 'P7' });
    expect(assembled.ok, assembled.diagnostics.map(diagnostic => diagnostic.message).join('\n')).toBe(true);
    const haltPc = findCourseHaltPc(assembled.image!, 'P7');
    expect(haltPc).toBeDefined();
    const { simulated, checked, observedHalt } = await runLiveP7CpuProbe({
      cpuRoot: cpuRoot!, machineCodeText: wordsToHexText(courseInstructionImageWords(assembled.image!)),
      programImage: assembled.image,
      sourceAsm: generated.text, probe: metadata, haltPc: haltPc!,
      ...(evidenceRoot ? { evidenceDir: path.join(evidenceRoot, shard) } : {}),
      // Exercise the custom-aware contract while preserving all standard opcodes.
      customInstructionEncodings: [{ mask: 0xfc00003f, value: 0xfc000000 }]
    });
    console.info(JSON.stringify({ cpuRoot, shard, seed: generated.seed, timerInterrupt: true,
      scenarioCount: metadata.scenarios.length, records: checked.records.length,
      passed: checked.passed, simulationOk: simulated.ok, observedHalt, failures: checked.failures }));
    expect(simulated.ok, simulated.stderr || simulated.stdout.slice(-2000)).toBe(true);
    expect(observedHalt).toBe(true);
    expect(checked.failures, JSON.stringify(checked.failures)).toEqual([]);
    expect(checked.coverage?.filter(coverage => !coverage.covered) ?? []).toEqual([]);
    expect(checked.passed).toBe(true);
    expect(checked.records.length).toBeGreaterThanOrEqual(count);
  }, 60_000);
});
