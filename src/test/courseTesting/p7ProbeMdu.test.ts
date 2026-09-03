import { describe, expect, it } from 'vitest';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { ProgramWriter } from '../../courseTesting/builtinAsm/programWriter';
import { P7ProbeCommitExpectation, P7ProbeMetadata, P7ProbeScenario } from '../../courseTesting/builtinAsm/types';
import { emitInterruptMduScenario } from '../../courseTesting/builtinAsm/p7/probeMduScenarios';
import { emitClearTimers, emitStoreImmediate } from '../../courseTesting/builtinAsm/p7/probeAsm';
import {
  p7ProbeKindExternal,
  p7ProbeKindTimer0,
  p7ProbeKindTimer1,
  p7ProbeLogBase,
  p7ProbeMagic,
  p7ProbeRecordWords,
  p7ProbeStateKind,
  p7ProbeStateRecordPtr,
  p7ProbeStateScenarioId
} from '../../courseTesting/builtinAsm/p7/constants';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { Random } from '../../courseTesting/random';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { executeProgramForService } from '../../mips/core/machine/executeService';

type InterruptKind = 'external' | 'timer0' | 'timer1';
const zeroPadding = { setupMax: 0, safeMin: 0, safeMax: 0, postMin: 0, postMax: 0 };
const initialHi = 0x13579bdf;
const initialLo = 0x2468ace0;
const vectors = [
  { operation: 'mult', hi: 0xffffffff, lo: 0xffffffeb },
  { operation: 'multu', hi: 2, lo: 0xffffffeb },
  { operation: 'div', hi: 0xffffffff, lo: 0xfffffffe },
  { operation: 'divu', hi: 0, lo: 0x55555553 },
  { operation: 'mthi', hi: 0xfffffff9, lo: initialLo },
  { operation: 'mtlo', hi: initialHi, lo: 0xfffffff9 }
] as const;
const cases = (['external', 'timer0', 'timer1'] as const)
  .flatMap((kind) => vectors.map((vector) => ({ kind, ...vector })));

describe('P7 interrupt MDU probes', () => {
  it('completes the automatic MDU shard with all 18 source/operation combinations', () => {
    const generated = generateBuiltinAsmTestCase({
      profile: 'P7', instructionText: '', instructionCount: 1118,
      seed: 'mdu-full-shard', p7StressMode: 'probe', probeShard: 'mdu',
      probeScenarioCount: 18, interrupt: true, timerInterrupt: true
    });
    expect(generated.probe!.scenarios.map((scenario) => `${scenario.kind}/${scenario.variant}`).sort())
      .toEqual(cases.map(({ kind, operation }) => `${kind}/mdu-retry-${operation}`).sort());
    expect(0x3000 + generated.instructionCount * 4).toBeLessThanOrEqual(0x4180);
    const assembled = assembleCourseSource({ id: 'mdu-shard', text: generated.text }, { profile: 'P7' });
    expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
    const executed = executeProgramForService({
      profile: 'P7',
      segments: assembled.image!.segments,
      entryPc: assembled.image!.entryPc,
      haltPc: 0x3000 + (generated.instructionCount - 2) * 4,
      maxSteps: 8_000,
      enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
      externalInterrupts: generated.probe!.scenarios.filter((scenario) => scenario.kind === 'external')
        .map((scenario) => ({ victimPc: scenario.victimPc!, occurrence: 1 })),
      deviceSchedule: {
        kind: 'timeline',
        entries: Array.from({ length: 8_000 }, (_, afterInstruction) => ({
          afterInstruction, cycles: [1, 5, 2, 3][afterInstruction % 4]
        }))
      },
      collectTrace: true
    });
    expect(executed).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
    const diagnostics = generated.probe!.scenarios.flatMap(externalDiagnostics);
    const trace = [...diagnostics, ...(executed.trace ?? [])].join('\n');
    const checked = checkP7Probe(trace, parseSimOutput(trace), generated.probe!);
    expect(checked.failures).toEqual([]);
    expect(checked.records).toHaveLength(18);
  });

  it.each(cases)('runs $kind/$operation through interrupt entry and exact EPC retry', ({ kind, operation, hi, lo }) => {
    const { text, haltPc, metadata } = program(kind, operation);
    const assembled = assembleCourseSource({ id: 'mdu-probe', text }, { profile: 'P7' });
    expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
    const scenario = metadata.scenarios[0];
    const executed = executeProgramForService({
      profile: 'P7',
      segments: assembled.image!.segments,
      entryPc: assembled.image!.entryPc,
      haltPc,
      maxSteps: 2_000,
      enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
      ...(kind === 'external' ? {
        externalInterrupts: [{ victimPc: scenario.victimPc!, occurrence: 1 }]
      } : {}),
      deviceSchedule: {
        kind: 'timeline',
        entries: Array.from({ length: 2_000 }, (_, afterInstruction) => ({ afterInstruction, cycles: 1 }))
      },
      collectTrace: true
    });
    expect(executed).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
    expect(executed.finalState.hi).toBe(`0x${hex(hi)}`);
    expect(executed.finalState.lo).toBe(`0x${hex(lo)}`);
    // The software executor supplies the interrupt schedule, while the production
    // testbench supplies these separate arm/raise/ack diagnostics in a DUT run.
    const trace = [...externalDiagnostics(scenario), ...(executed.trace ?? [])].join('\n');
    const checked = checkP7Probe(trace, parseSimOutput(trace), metadata);
    expect(checked.failures).toEqual([]);
    expect(checked.records).toHaveLength(1);
    expect(checked.records[0]).toMatchObject({ epc: scenario.victimPc, aux0: initialHi, aux1: initialLo });
  });

  it.each(cases)('accepts both permitted $kind/$operation entry states, rejecting corruption and failed retry', ({ kind, operation, hi, lo }) => {
    const { metadata } = program(kind, operation);
    const scenario = metadata.scenarios[0];
    for (const pair of [[initialHi, initialLo], [hi, lo]] as Array<[number, number]>) {
      const trace = observationTrace(scenario, pair);
      expect(checkP7Probe(trace, parseSimOutput(trace), metadata).failures).toEqual([]);
    }

    const corrupted = observationTrace(scenario, [0xdeadbeef, 0xbaadf00d]);
    expect(checkP7Probe(corrupted, parseSimOutput(corrupted), metadata).failures
      .some((failure) => failure.message.includes('HI/LO'))).toBe(true);

    // A correct final completion marker must not hide an omitted or wrongly valued
    // mfhi/mflo retry. The full production checker evaluates actual public writes.
    const valid = observationTrace(scenario, [initialHi, initialLo]);
    const hiCommit = commitLine(scenario.requiredCommits![0]);
    for (const broken of [
      valid.replace(hiCommit, ''),
      valid.replace(hiCommit, hiCommit.replace(hex(hi), 'deadbeef'))
    ]) {
      expect(checkP7Probe(broken, parseSimOutput(broken), metadata).failures
        .some((failure) => failure.message.includes('required GRF'))).toBe(true);
    }
  });

  it.each(vectors)('rejects a torn or unexpectedly modified half for $operation', ({ operation, hi, lo }) => {
    const { metadata } = program('external', operation);
    const scenario = metadata.scenarios[0];
    const illegalPair: [number, number] = operation === 'mthi'
      ? [hi, 0]
      : operation === 'mtlo'
        ? [0, lo]
        : [hi, initialLo];
    const trace = observationTrace(scenario, illegalPair);
    expect(checkP7Probe(trace, parseSimOutput(trace), metadata).failures
      .some((failure) => failure.message.includes('HI/LO'))).toBe(true);
  });

  it('rejects extra writes at observed PCs even when the expected retry value also appeared once', () => {
    const { metadata } = program('external', 'multu');
    const scenario = metadata.scenarios[0];
    const valid = observationTrace(scenario, [initialHi, initialLo]);
    const expectedRead = scenario.requiredCommits![0];
    const expectedStore = scenario.requiredCommits![2];
    for (const unexpected of [
      { ...expectedRead, value: 0xdeadbeef },
      { ...expectedRead, target: 12 },
      { ...expectedRead, kind: 'dm' as const, target: 0x0620 },
      { ...expectedStore, value: 0xbaadf00d }
    ]) {
      const broken = `${valid}\n${commitLine(unexpected)}`;
      expect(checkP7Probe(broken, parseSimOutput(broken), metadata).passed).toBe(false);
    }
  });
});

function program(kind: InterruptKind, operation: string): { text: string; haltPc: number; metadata: P7ProbeMetadata } {
  const writer = new ProgramWriter(0x3000);
  writer.raw('.text');
  writer.label('main');
  writer.emit('mtc0 $0, $12');
  emitClearTimers(writer);
  emitStoreImmediate(writer, p7ProbeLogBase, p7ProbeStateRecordPtr);
  emitStoreImmediate(writer, 1, p7ProbeStateScenarioId);
  emitStoreImmediate(writer, kindCode(kind), p7ProbeStateKind);
  const scenario = emitInterruptMduScenario(writer, 1, kind, `mdu-retry-${operation}`, new Random(1), zeroPadding);
  const haltPc = writer.pc();
  writer.label('_co_test_end');
  writer.emit('beq $0, $0, _co_test_end');
  writer.emit('nop');
  // Use the production handler to verify its flag dispatch, source clearing,
  // HI/LO capture and eret behavior together with the standalone scenario.
  const generated = generateBuiltinAsmTestCase({
    profile: 'P7', instructionText: '', instructionCount: 64,
    seed: 'mdu-handler', p7StressMode: 'probe', probeScenarioCount: 1,
    interrupt: false, timerInterrupt: false, exceptionTypes: ['Syscall']
  });
  const handler = generated.text.slice(generated.text.indexOf('.ktext'));
  return {
    text: `${writer.render().join('\n')}\n${handler}`,
    haltPc,
    metadata: { version: 1, logBase: p7ProbeLogBase, recordWords: p7ProbeRecordWords, scenarios: [scenario] }
  };
}

function observationTrace(scenario: P7ProbeScenario, pair: [number, number]): string {
  const fields = [p7ProbeMagic, scenario.id, kindCode(scenario.kind as InterruptKind),
    0x1c03, scenario.expectedIpMask, scenario.victimPc!, ...pair];
  return [
    ...externalDiagnostics(scenario),
    ...(scenario.requiredPreHandlerCommits ?? []).map(commitLine),
    ...fields.map((value, index) => `20@00004180: *${hex(p7ProbeLogBase + index * 4)} <= ${hex(value)}`),
    ...(scenario.requiredCommits ?? []).map(commitLine),
    `40@${hex(scenario.donePc)}: $1 <= ${hex(scenario.id)}`
  ].join('\n');
}

function externalDiagnostics(scenario: P7ProbeScenario): string[] {
  return scenario.kind === 'external' ? [
    `CO_P7_PROBE external_arm scenario=${scenario.id} addr=000027d0 value=${hex(scenario.id)} time=1`,
    `CO_P7_PROBE external_raise scenario=${scenario.id} pc=${hex(scenario.victimPc!)} time=2`,
    `CO_P7_PROBE external_ack scenario=${scenario.id} time=3`
  ] : [];
}

function kindCode(kind: InterruptKind): number {
  return kind === 'external' ? p7ProbeKindExternal : kind === 'timer0' ? p7ProbeKindTimer0 : p7ProbeKindTimer1;
}

function commitLine(commit: P7ProbeCommitExpectation): string {
  const target = commit.kind === 'grf' ? `$${commit.target}` : `*${hex(commit.target)}`;
  return `30@${hex(commit.pc)}: ${target} <= ${hex(commit.value)}`;
}

function hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
