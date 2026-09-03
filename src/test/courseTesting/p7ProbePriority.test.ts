import { describe, expect, it } from 'vitest';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { executeProgramForService } from '../../mips/core/machine/executeService';
import {
  p7ProbeLogBase,
  p7ProbePostEretStatusAddress,
  p7ProbeRecordWords,
  p7UserTextBaseAddress
} from '../../courseTesting/p7Hardware';

const exceptionCodes = { ri: 10, adel: 4, ades: 5, ov: 12, syscall: 8 } as const;
const variants = [
  ...Object.keys(exceptionCodes).map((kind) => `priority-${kind}`),
  'priority-syscall-delay-taken',
  'priority-syscall-delay-not-taken'
];

function timerPriorityProgram() {
  return generateBuiltinAsmTestCase({
    profile: 'P7',
    instructionText: '',
    instructionCount: 1118,
    seed: 'p7-priority-course-contract',
    p7StressMode: 'probe',
    probeShard: 'priority',
    probeScenarioCount: 14,
    timerInterrupt: true,
    interrupt: false
  });
}

function executeProbe(program: ReturnType<typeof generateBuiltinAsmTestCase>, cyclesAt: (step: number) => number) {
  const assembled = assembleCourseSource({ id: 'priority-probe', text: program.text }, { profile: 'P7' });
  expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
  return executeProgramForService({
    profile: 'P7',
    segments: assembled.image!.segments,
    entryPc: assembled.image!.entryPc,
    haltPc: p7UserTextBaseAddress + (program.instructionCount - 2) * 4,
    maxSteps: 6_000,
    enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
    deviceSchedule: {
      kind: 'timeline',
      entries: Array.from({ length: 6_000 }, (_, afterInstruction) => ({
        afterInstruction,
        cycles: cyclesAt(afterInstruction)
      }))
    },
    externalInterrupts: program.probe!.scenarios.filter((scenario) => scenario.kind === 'external')
      .map((scenario) => ({ victimPc: scenario.triggerPc ?? scenario.waitPc!, occurrence: 1 })),
    collectTrace: true
  });
}

describe('P7 deterministic interrupt/exception priority probes', () => {
  it('runs all five exceptions for both pending timers and verifies taken/not-taken BD on retry', () => {
    const program = timerPriorityProgram();
    const metadata = program.probe!;
    for (const kind of ['timer0', 'timer1'] as const) {
      expect(metadata.scenarios.filter((scenario) => scenario.kind === kind).map((scenario) => scenario.variant).sort())
        .toEqual([...variants].sort());
    }
    for (const cyclesAt of [() => 1, (step: number) => [1, 5, 2, 3][step % 4]]) {
      const executed = executeProbe(program, cyclesAt);
      const trace = executed.trace!.join('\n');
      const checked = checkP7Probe(trace, parseSimOutput(trace), metadata);
      expect(executed).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
      expect(checked.failures).toEqual([]);
      expect(checked.records).toHaveLength(14);
      for (const scenario of metadata.scenarios) {
        const record = checked.records.find((item) => item.scenarioId === scenario.id)!;
        const exception = scenario.variant!.split('-')[1] as keyof typeof exceptionCodes;
        const delayed = scenario.variant!.includes('-delay-');
        expect(record.status).toBe(0x1c03);
        expect(record.cause).toBe(scenario.kind === 'timer0' ? 0x400 : 0x800);
        expect(record.epc).toBe(scenario.victimPc! - (delayed ? 4 : 0));
        expect(record.aux0).toBe(((delayed ? 0x80000000 : 0) | (exceptionCodes[exception] << 2)) >>> 0);
        expect(record.aux1).toBe(record.epc);
      }
      expect(executed.finalState.cp0?.status).toBe('0x00001c01');
    }
  });

  it('takes an external interrupt at the RI raw word and retries RI only after acknowledging Int', () => {
    const program = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 1118,
      seed: 'p7-external-priority-ri',
      p7StressMode: 'probe',
      probeShard: 'core',
      probeScenarioCount: 5,
      interrupt: true,
      externalInterruptIntensity: 1,
      timerInterrupt: false,
      exceptionTypes: []
    });
    const scenario = program.probe!.scenarios.find((item) => item.variant === 'priority-ri')!;
    expect(scenario).toBeDefined();
    const executed = executeProbe(program, () => 1);
    expect(executed).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
    // The execution service supplies the architectural trace; the Verilog-only
    // arm/raise/ack observer diagnostics are supplied as a protocol fixture here.
    const diagnostics = program.probe!.scenarios.flatMap((item) => [
      `CO_P7_PROBE external_arm scenario=${item.id}`,
      `CO_P7_PROBE external_raise scenario=${item.id}`,
      `CO_P7_PROBE external_ack scenario=${item.id}`
    ]).join('\n');
    const trace = executed.trace!.join('\n');
    const checked = checkP7Probe(diagnostics, parseSimOutput(trace), program.probe!);
    expect(checked.failures).toEqual([]);
    expect(checked.records.find((item) => item.scenarioId === scenario.id)).toMatchObject({
      cause: 0x1000,
      epc: scenario.victimPc,
      aux0: 10 << 2,
      aux1: scenario.victimPc
    });
  });

  it('rejects wrong priority, stale IP, lost BD/EPC/EXL, premature victim commits and missing completion', () => {
    const program = timerPriorityProgram();
    const executed = executeProbe(program, () => 1);
    const events = parseSimOutput(executed.trace!.join('\n'));
    const metadata = program.probe!;
    const delayed = metadata.scenarios.find((scenario) => scenario.variant === 'priority-syscall-delay-taken')!;
    const index = metadata.scenarios.indexOf(delayed);
    const recordBase = p7ProbeLogBase + index * p7ProbeRecordWords * 4;
    const mutations = [
      { address: recordBase + 16, value: 8 << 2, diagnostic: 'ExcCode differs' },
      { address: recordBase + 24, value: 0x80000420, diagnostic: 'Cause.IP' },
      { address: recordBase + 24, value: 8 << 2, diagnostic: 'Cause.BD differs' },
      { address: recordBase + 28, value: delayed.victimPc!, diagnostic: 'EPC' },
      { address: p7ProbePostEretStatusAddress, value: 0x1c01, diagnostic: 'Status' }
    ];
    for (const mutation of mutations) {
      const modified = events.map((event) => event.kind === 'dm' && Number.parseInt(event.target, 16) === mutation.address
        ? { ...event, value: mutation.value.toString(16).padStart(8, '0') }
        : event);
      const checked = checkP7Probe('', modified, metadata);
      expect(checked.passed, mutation.diagnostic).toBe(false);
      expect(checked.failures.some((failure) => failure.message.includes(mutation.diagnostic)), mutation.diagnostic).toBe(true);
    }
    const missingCompletion = events.filter((event) => Number.parseInt(event.pc, 16) !== delayed.donePc);
    expect(checkP7Probe('', missingCompletion, metadata).failures.some((failure) => failure.message.includes('completion'))).toBe(true);

    const pendingMarker = delayed.requiredPreHandlerCommits![0];
    const missingPendingProof = events.filter((event) => Number.parseInt(event.pc, 16) !== pendingMarker.pc);
    expect(checkP7Probe('', missingPendingProof, metadata).passed).toBe(false);

    const victimCommit = { ...events[0], kind: 'grf' as const, pc: delayed.victimPc!.toString(16), target: '8', value: '00000001' };
    expect(checkP7Probe('', [...events, victimCommit], metadata).failures.some((failure) => failure.message.includes('exception victim PC'))).toBe(true);
  });
});
