import { describe, expect, it } from 'vitest';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { executeProgramForService } from '../../mips/core/machine/executeService';

function hazardProgram(shard: 'hazard' | 'special-hazard', seed = 'p7-hazard-architectural-contract') {
  return generateBuiltinAsmTestCase({
    profile: 'P7', instructionText: '', instructionCount: 1118, seed,
    p7StressMode: 'probe', probeShard: shard, probeScenarioCount: shard === 'hazard' ? 11 : 10,
    interrupt: true, timerInterrupt: true
  });
}

function executeProbe(program: ReturnType<typeof hazardProgram>, cyclesAt: (step: number) => number) {
  const assembled = assembleCourseSource({ id: 'hazard-probe', text: program.text }, { profile: 'P7' });
  expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
  const executed = executeProgramForService({
    profile: 'P7', segments: assembled.image!.segments, entryPc: assembled.image!.entryPc,
    haltPc: 0x3000 + (program.instructionCount - 2) * 4, maxSteps: 6_000, collectTrace: true,
    enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
    deviceSchedule: {
      kind: 'timeline', entries: Array.from({ length: 6_000 }, (_, afterInstruction) => ({
        afterInstruction, cycles: cyclesAt(afterInstruction)
      }))
    },
    externalInterrupts: program.probe!.scenarios.filter((scenario) => scenario.kind === 'external')
      .map((scenario) => ({ victimPc: scenario.triggerPc!, occurrence: 1 }))
  });
  // The engine emits architecture events, while the actual DUT testbench emits
  // these arm/raise/ack protocol diagnostics. This fixture supplies only those.
  const diagnostics = program.probe!.scenarios.filter((scenario) => scenario.kind === 'external').flatMap((scenario) => [
    `CO_P7_PROBE external_arm scenario=${scenario.id}`,
    `CO_P7_PROBE external_raise scenario=${scenario.id}`,
    `CO_P7_PROBE external_ack scenario=${scenario.id}`
  ]).join('\n');
  return { executed, diagnostics, events: parseSimOutput(executed.trace!.join('\n')) };
}

describe.each(['hazard', 'special-hazard'] as const)('P7 hazards through precise exceptions and interrupt replay (%s)', shard => {
  it('executes every registered scenario under different timer cadences with exact older/retry commits', () => {
    const program = hazardProgram(shard);
    const scenarioCount = shard === 'hazard' ? 11 : 10;
    expect(program.probe!.scenarios).toHaveLength(scenarioCount);
    expect(0x3000 + program.instructionCount * 4).toBeLessThanOrEqual(0x4180);
    for (const cyclesAt of [() => 1, () => 3, (step: number) => [1, 7, 2, 11][step % 4]]) {
      const { executed, diagnostics, events } = executeProbe(program, cyclesAt);
      expect(executed).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
      const checked = checkP7Probe(diagnostics, events, program.probe!);
      expect(checked.failures).toEqual([]);
      expect(checked.records).toHaveLength(scenarioCount);
      for (const scenario of program.probe!.scenarios) {
        const record = checked.records.find((item) => item.scenarioId === scenario.id)!;
        expect(record.epc).toBe(scenario.allowedEpc[0]);
        expect((record.cause >>> 31) !== 0).toBe(scenario.expectedBd);
      }
    }
  });

  it('rejects every missing, duplicate, or incorrect older/retried write', () => {
    const program = hazardProgram(shard);
    const { diagnostics, events } = executeProbe(program, () => 1);
    for (const scenario of program.probe!.scenarios) {
      for (const expected of [...scenario.requiredPreHandlerCommits!, ...(scenario.requiredCommits ?? [])]) {
        const original = events.find((event) => Number.parseInt(event.pc, 16) === expected.pc)!;
        expect(original).toBeDefined();
        const without = events.filter((event) => event !== original);
        for (const corrupted of [without, [...events, original], events.map((event) => event === original
          ? { ...event, value: 'deadbeef' } : event)]) {
          expect(checkP7Probe(diagnostics, corrupted, program.probe!).failures.some((failure) =>
            failure.scenarioId === scenario.id && failure.message.includes('提交'))).toBe(true);
        }
      }
    }
  });

  it('rejects younger and wrong-path writes even when a later write repairs memory', () => {
    const program = hazardProgram(shard);
    const { diagnostics, events } = executeProbe(program, () => 1);
    for (const scenario of program.probe!.scenarios) {
      for (const pc of scenario.forbiddenCommitPcs ?? []) {
        const bad = {
          ...events[0], pc: pc.toString(16), kind: 'dm' as const, target: '00000648', value: 'deadbeef'
        };
        const repair = { ...bad, pc: scenario.donePc.toString(16), value: '00000000' };
        const failures = checkP7Probe(diagnostics, [...events, bad, repair], program.probe!).failures;
        expect(failures.some((failure) => failure.scenarioId === scenario.id
          && failure.message.includes('禁止提交的后续指令/错误路径'))).toBe(true);
      }
    }
  });

  it('rejects older writes interleaved with the handler record', () => {
    const program = hazardProgram(shard);
    const { diagnostics, events } = executeProbe(program, () => 1);
    const records = checkP7Probe(diagnostics, events, program.probe!).records;
    for (const scenario of program.probe!.scenarios) {
      const record = records.find((item) => item.scenarioId === scenario.id)!;
      for (const expected of scenario.requiredPreHandlerCommits!) {
        const interleaved = events.map((event) => Number.parseInt(event.pc, 16) === expected.pc
          ? { ...event, lineNumber: record.firstLineNumber + 1 } : event);
        expect(checkP7Probe(diagnostics, interleaved, program.probe!).failures.some((failure) =>
          failure.scenarioId === scenario.id && failure.message.includes('异常前提交'))).toBe(true);
      }
    }
  });

  it('rejects lost delay-slot BD/EPC and victim writes before the handler', () => {
    const program = hazardProgram(shard);
    const { diagnostics, events } = executeProbe(program, () => 1);
    for (const scenario of program.probe!.scenarios.filter((item) => item.expectedBd)) {
      const recordBase = program.probe!.logBase + program.probe!.scenarios.indexOf(scenario) * 32;
      const wrongBd = events.map((event) => event.kind === 'dm' && Number.parseInt(event.target, 16) === recordBase + 16
        ? { ...event, value: (Number.parseInt(event.value, 16) & 0x7fffffff).toString(16) } : event);
      const wrongEpc = events.map((event) => event.kind === 'dm' && Number.parseInt(event.target, 16) === recordBase + 20
        ? { ...event, value: scenario.victimPc!.toString(16) } : event);
      expect(checkP7Probe(diagnostics, wrongBd, program.probe!).failures.some((failure) =>
        failure.scenarioId === scenario.id && failure.message.includes('BD'))).toBe(true);
      expect(checkP7Probe(diagnostics, wrongEpc, program.probe!).failures.some((failure) =>
        failure.scenarioId === scenario.id && failure.message.includes('EPC'))).toBe(true);
    }
    for (const scenario of program.probe!.scenarios.filter((item) => item.requiredCommits?.length)) {
      const pc = scenario.requiredCommits![0].pc;
      const premature = events.map((event) => Number.parseInt(event.pc, 16) === pc
        ? { ...event, lineNumber: 0 } : event);
      expect(checkP7Probe(diagnostics, premature, program.probe!).failures.some((failure) =>
        failure.scenarioId === scenario.id && failure.message.includes('必要的重试提交出现在异常处理程序记录之前'))).toBe(true);
    }
  });
});
