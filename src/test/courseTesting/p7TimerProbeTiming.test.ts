import { describe, expect, it } from 'vitest';
import { generateBuiltinAsmTestCase, type P7ProbeMetadata } from '../../courseTesting/builtinAsmGenerator';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { p7ProbeTimerReloadPreset } from '../../courseTesting/builtinAsm/p7/constants';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { formatArchitecturalWrite, projectCommitEvent } from '../../mips/core/events/traceProjection';
import { prepareCourseExecution } from '../../mips/core/machine/executeService';
import type { CourseSystemSession } from '../../mips/core/machine/system';

function runTimerProbe(advance?: (session: CourseSystemSession, metadata: P7ProbeMetadata, pc: number) => void) {
  const generated = generateBuiltinAsmTestCase({
    profile: 'P7', instructionText: '', instructionCount: 1118,
    seed: 'review-p7-timer', p7StressMode: 'probe', probeShard: 'timer',
    probeScenarioCount: 12, interrupt: true, timerInterrupt: true
  });
  const assembled = assembleCourseSource({ id: 'timer-probe-review', text: generated.text }, { profile: 'P7' });
  expect(assembled.ok, assembled.diagnostics.map(item => item.message).join('\n')).toBe(true);
  const image = assembled.image!;
  const metadata = generated.probe!;
  const { session } = prepareCourseExecution({
    profile: 'P7', segments: image.segments, entryPc: image.entryPc,
    haltPc: findCourseHaltPc(image, 'P7'), maxSteps: 6_000,
    deviceSchedule: { kind: 'timeline', entries: [] },
    enabledLayers: ['required', 'commonExtensions', 'marsCompatibility']
  });
  const lines: string[] = [];
  let haltReason: string | undefined;
  for (let step = 0; step <= 6_000 && !session.done; step++) {
    const pc = session.machine.snapshot().pc;
    if (advance) advance(session, metadata, pc);
    else session.tickDevices({ cycles: 1 });
    const result = session.stepInstruction();
    if (result.event) {
      for (const write of projectCommitEvent(result.event, session.profile)) {
        lines.push(formatArchitecturalWrite(write));
      }
    }
    haltReason = result.event?.haltReason ?? haltReason;
  }
  const stdout = lines.join('\n');
  const events = parseSimOutput(stdout);
  return { stdout, events, image, metadata, haltReason, result: checkP7Probe(stdout, events, metadata, image) };
}

describe('P7 Timer phase-independent observations', () => {
  it.each([1, 2, 8, 41])('accepts both Timer restart and genuine repeated IRQs with %i clocks across the restart sequences', cycles => {
    const observed = runTimerProbe((session, metadata, pc) => {
      const inDisableReload = metadata.scenarios.some(scenario => {
        const timer = scenario.timerObservation;
        if (timer?.kind !== 'disable-reload') return false;
        const firstCtrlRead = scenario.requiredPreHandlerCommits![0].pc;
        return pc >= firstCtrlRead - 16 && pc <= timer.reloadedCount.pc;
      });
      session.tickDevices({ cycles: inDisableReload ? cycles : 1 });
    });
    expect(observed.haltReason).toBe('course-halt-loop');
    expect(observed.result.failures).toEqual([]);
    expect(observed.result.records).toHaveLength(12);
    expect(observed.result.passed).toBe(true);
  });

  it('completes under the original phase-locked COUNT sampling clock schedule', () => {
    const observed = runTimerProbe((session, _metadata, pc) => {
      const cycles = pc === 0x3170 ? 3 : pc > 0x3170 && pc < 0x3198 ? 4 : 1;
      session.tickDevices({ cycles });
    });
    expect(observed.haltReason).toBe('course-halt-loop');
    expect(observed.result.failures).toEqual([]);
    expect(observed.result.passed).toBe(true);
  });

  it('marks a phase-locked Cause sample as uncovered while rejecting contradictory public evidence', () => {
    const observed = runTimerProbe((session, metadata, pc) => {
      session.tickDevices();
      const scenario = metadata.scenarios.find(item => item.variant === 'mode1-repeat' && item.kind === 'timer0')!;
      const timer = scenario.timerObservation!;
      if (timer.kind !== 'mode1' || pc !== timer.ipSampling!.sample.pc - 4) return;
      const ipMask = scenario.expectedRecords![0].expectedIpMask;
      // Sample only the IRQ edge of each real, independently clocked Timer
      // period. A valid Timer can therefore yield no low Cause sample.
      for (let edges = 0; (session.devices!.sampleInterrupts() & (ipMask >>> 10)) === 0; edges++) {
        expect(edges).toBeLessThan(36);
        session.tickDevices();
      }
    });
    expect(observed.haltReason).toBe('step-limit');
    expect(observed.result).toMatchObject({ passed: false, failures: [], coverage: [{ covered: false }] });
    const scenario = observed.metadata.scenarios.find(item => item.variant === 'mode1-repeat' && item.kind === 'timer0')!;
    const timer = scenario.timerObservation!;
    if (timer.kind !== 'mode1') throw new Error('expected mode1 observation');
    for (const [pc, value] of [[timer.ipSampling!.sample.pc, 0], [timer.firstCapture.epcPc, 0x3000]]) {
      const events = observed.events.map(event => Number.parseInt(event.pc, 16) === pc
        ? { ...event, value: value.toString(16) } : event);
      expect(checkP7Probe(observed.stdout, events, observed.metadata, observed.image).failures).not.toEqual([]);
    }
  });

  it('rejects active, stopped, and reloaded COUNT failures and a second IRQ before CPU IE was enabled', () => {
    const observed = runTimerProbe();
    expect(observed.result.passed).toBe(true);
    for (const scenario of observed.metadata.scenarios) {
      const timer = scenario.timerObservation;
      if (timer?.kind === 'disable-reload') {
        const active = observed.events.find(event => Number.parseInt(event.pc, 16) === timer.activeCount[0].pc)!;
        const stopped = observed.events.find(event => Number.parseInt(event.pc, 16) === timer.stoppedCount[0].pc)!;
        for (const [pc, value, diagnostic] of [
          [timer.activeCount[1].pc, active.value, '未递减'],
          [timer.stoppedCount[1].pc, (Number.parseInt(stopped.value, 16) - 1).toString(16), '停用期间'],
          [timer.reloadedCount.pc, stopped.value, '新 PRESET'],
          [timer.reloadedCount.pc, (p7ProbeTimerReloadPreset + 1).toString(16), '新 PRESET']
        ] as const) {
          const events = observed.events.map(event => Number.parseInt(event.pc, 16) === pc ? { ...event, value } : event);
          expect(checkP7Probe(observed.stdout, events, observed.metadata, observed.image).failures).toContainEqual(
            expect.objectContaining({ scenarioId: scenario.id, observed: true, message: expect.stringContaining(diagnostic) })
          );
        }
        const missing = observed.events.filter(event => Number.parseInt(event.pc, 16) !== timer.reloadedCount.pc);
        const missingFailures = checkP7Probe(observed.stdout, missing, observed.metadata, observed.image).failures;
        expect(missingFailures.some(failure => failure.scenarioId === scenario.id)).toBe(true);
        expect(missingFailures.some(failure => failure.scenarioId === scenario.id && failure.observed)).toBe(false);
      } else if (timer?.kind === 'mode1') {
        const recordAddress = observed.metadata.logBase + (scenario.id - 1) * observed.metadata.recordWords * 4;
        const events = observed.events.map(event => event.kind === 'dm' && Number.parseInt(event.target, 16) === recordAddress + 28
          ? { ...event, value: (scenario.waitPc! - 4).toString(16) } : event);
        expect(checkP7Probe(observed.stdout, events, observed.metadata, observed.image).failures).toContainEqual(
          expect.objectContaining({ scenarioId: scenario.id, message: expect.stringMatching(/记录 2.*EPC/) })
        );
        const wrongCtrl = scenario.requiredPreHandlerCommits!.find(commit => commit.value === 0xb)!;
        const wrongIp = timer.stoppedCount && scenario.requiredPreHandlerCommits!.find(commit => commit.target === 15);
        for (const commit of [wrongCtrl, wrongIp]) {
          if (!commit) continue;
          const events = observed.events.map(event => Number.parseInt(event.pc, 16) === commit.pc
            ? { ...event, value: (commit.value === 0xb ? 0x3 : scenario.expectedRecords![0].expectedIpMask).toString(16) } : event);
          expect(checkP7Probe(observed.stdout, events, observed.metadata, observed.image).failures).toContainEqual(
            expect.objectContaining({ scenarioId: scenario.id, observed: true, message: expect.stringContaining('读回值不符') })
          );
        }
      }
    }
  });
});
