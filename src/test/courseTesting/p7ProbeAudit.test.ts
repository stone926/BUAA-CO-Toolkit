import { describe, expect, it } from 'vitest';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { ProgramWriter } from '../../courseTesting/builtinAsm/programWriter';
import { P7ProbeMetadata } from '../../courseTesting/builtinAsm/types';
import { emitClearTimers, emitStoreImmediate } from '../../courseTesting/builtinAsm/p7/probeAsm';
import { emitTimerPendingWritesScenario } from '../../courseTesting/builtinAsm/p7/probeTimerWriteScenario';
import {
  p7ProbeLogBase, p7ProbeRecordWords, p7ProbeStateRecordPtr,
  p7ProbeStateScenarioId, p7ProbeStateKind
} from '../../courseTesting/p7Hardware';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { Random } from '../../courseTesting/random';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { executeProgramForService } from '../../mips/core/machine/executeService';

function syscallProbe() {
  return generateBuiltinAsmTestCase({
    profile: 'P7', instructionText: '', instructionCount: 1118,
    seed: 'audit-reset-younger-mdu', p7StressMode: 'probe', probeShard: 'core',
    probeScenarioCount: 6, interrupt: false, timerInterrupt: false, exceptionTypes: ['Syscall']
  });
}

function execute(text: string, haltPc: number, cyclesAt: (step: number) => number = () => 1) {
  const assembled = assembleCourseSource({ id: 'audit-probe', text }, { profile: 'P7' });
  expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
  const result = executeProgramForService({
    profile: 'P7', segments: assembled.image!.segments, entryPc: assembled.image!.entryPc,
    haltPc, maxSteps: 4_000, collectTrace: true,
    enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
    deviceSchedule: {
      kind: 'timeline', entries: Array.from({ length: 4_000 }, (_, afterInstruction) => ({
        afterInstruction, cycles: cyclesAt(afterInstruction)
      }))
    }
  });
  expect(result).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
  return parseSimOutput(result.trace!.join('\n'));
}

describe('P7 audit regressions', () => {
  it('records raw SR/Cause/EPC before the first mtc0 and detects each reset error despite later overwrites', () => {
    const generated = syscallProbe();
    const metadata = generated.probe!;
    expect(generated.text).toMatch(/main:\s*mfc0 \$8, \$12\s*mfc0 \$9, \$13\s*mfc0 \$10, \$14/);
    expect(Object.keys(metadata.initialCp0!)).toEqual(['status', 'cause', 'epc']);
    const events = execute(generated.text, 0x3000 + (generated.instructionCount - 2) * 4);
    expect(checkP7Probe('', events, metadata).failures).toEqual([]);

    for (const [name, sample] of Object.entries(metadata.initialCp0!)) {
      const original = events.find((event) => Number.parseInt(event.pc, 16) === sample.pc)!;
      expect(original).toBeDefined();
      // The handler/prologue really do later write this same scratch address.
      expect(events.filter((event) => event.kind === 'dm'
        && Number.parseInt(event.target, 16) === sample.target).length).toBeGreaterThan(1);
      const missing = events.filter((event) => event !== original);
      const nonzero = { ...original, value: '00000004' };
      for (const corrupted of [
        events.map((event) => event === original ? nonzero : event),
        missing, [...events, original], [...events, nonzero],
        [...missing, { ...original, lineNumber: events[events.length - 1].lineNumber + 1 }]
      ]) {
        expect(checkP7Probe('', corrupted, metadata).failures.some((failure) =>
          failure.kind === 'cp0-reset' && failure.message.includes(name))).toBe(true);
      }
    }
    // Historical manifests carry no raw-reset observations and stay replayable.
    const { initialCp0: _initialCp0, ...historical } = metadata;
    expect(checkP7Probe('', events, historical).failures).toEqual([]);
  });

  it('accepts complete already-started younger MDU results and rejects torn or corrupt halves', () => {
    const generated = syscallProbe();
    const metadata = generated.probe!;
    const events = execute(generated.text, 0x3000 + (generated.instructionCount - 2) * 4);
    expect(checkP7Probe('', events, metadata).failures).toEqual([]);
    const vectors = [
      ['young-mult', 0, 63], ['young-div', 2, 14],
      ['young-mthi', 7, 0x2468ace0], ['young-mtlo', 0x13579bdf, 9]
    ] as const;
    for (const [variant, hi, lo] of vectors) {
      const scenario = metadata.scenarios.find((item) => item.variant === variant)!;
      const base = metadata.logBase + metadata.scenarios.indexOf(scenario) * metadata.recordWords * 4;
      const withPair = (first: number, second: number) => events.map((event) => {
        if (event.kind !== 'dm') { return event; }
        const address = Number.parseInt(event.target, 16);
        return address === base + 24 ? { ...event, value: first.toString(16) }
          : address === base + 28 ? { ...event, value: second.toString(16) } : event;
      });
      expect(checkP7Probe('', withPair(hi, lo), metadata).failures).toEqual([]);
      const torn = variant === 'young-mtlo' ? [0, lo] : [hi, 0xdeadbeef];
      for (const pair of [torn, [0xdeadbeef, 0xbaadf00d]]) {
        expect(checkP7Probe('', withPair(pair[0], pair[1]), metadata).failures.some((failure) =>
          failure.scenarioId === scenario.id && failure.message.includes('HI/LO'))).toBe(true);
      }
    }
  });

  it.each(['timer0', 'timer1'] as const)('checks stable $0 register writes with different device-clock gaps', (kind) => {
    const writer = new ProgramWriter(0x3000);
    writer.raw('.text');
    writer.label('main');
    writer.emit('mtc0 $0, $12');
    emitClearTimers(writer);
    emitStoreImmediate(writer, p7ProbeLogBase, p7ProbeStateRecordPtr);
    emitStoreImmediate(writer, 1, p7ProbeStateScenarioId);
    emitStoreImmediate(writer, kind === 'timer0' ? 2 : 3, p7ProbeStateKind);
    const scenario = emitTimerPendingWritesScenario(writer, 1, kind, new Random(1), {
      setupMax: 0, safeMin: 0, safeMax: 0, postMin: 0, postMax: 0
    });
    const haltPc = writer.pc();
    writer.label('_co_test_end');
    writer.emit('beq $0, $0, _co_test_end');
    writer.emit('nop');
    const generated = syscallProbe();
    const text = `${writer.render().join('\n')}\n${generated.text.slice(generated.text.indexOf('.ktext'))}`;
    const metadata: P7ProbeMetadata = {
      version: 1, logBase: p7ProbeLogBase, recordWords: p7ProbeRecordWords, scenarios: [scenario]
    };
    for (const cyclesAt of [() => 1, () => 2, () => 3, (step: number) => [1, 7, 2, 11][step % 4]]) {
      const events = execute(text, haltPc, cyclesAt);
      expect(checkP7Probe('', events, metadata).failures).toEqual([]);
      // A stale/cleared pending bit, lost PRESET write, or incorrect CTRL/COUNT
      // must still fail; relaxing cadence does not remove architectural checks.
      for (const commit of scenario.requiredPreHandlerCommits!) {
        const corrupted = events.map((event) => Number.parseInt(event.pc, 16) === commit.pc
          ? { ...event, value: 'deadbeef' } : event);
        expect(checkP7Probe('', corrupted, metadata).passed).toBe(false);
      }
    }
  });

  it('keeps all five automatic shards below the exception vector with reset observations included', () => {
    for (const [shard, count] of [['core', 64], ['mmio', 26], ['timer', 10], ['priority', 14], ['mdu', 18]] as const) {
      const generated = generateBuiltinAsmTestCase({
        profile: 'P7', instructionText: '', instructionCount: 1118,
        seed: 'audit-shard-capacity', p7StressMode: 'probe', probeShard: shard,
        probeScenarioCount: count, interrupt: true, timerInterrupt: true
      });
      expect(0x3000 + generated.instructionCount * 4).toBeLessThanOrEqual(0x4180);
      expect(Object.keys(generated.probe!.initialCp0!)).toHaveLength(3);
      expect(generated.probe!.scenarios).toHaveLength(count);
    }
  });
});
