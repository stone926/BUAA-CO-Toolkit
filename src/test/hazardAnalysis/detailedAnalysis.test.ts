import { describe, expect, it, vi } from 'vitest';
import { analyzeHazardProgram } from '../../hazardAnalysis/analyzer';
import { HazardDetailedAccumulator } from '../../hazardAnalysis/detailedStats';
import { hazardInstructionFor } from '../../hazardAnalysis/hazardInstruction';
import { HazardPipelineModel } from '../../hazardAnalysis/hazardPipeline';
import { prepareHazardAssessment } from '../../hazardAnalysis/observability';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import type { CourseProfile } from '../../mips/core/generated/isaCatalog';
import { prepareCourseExecution, projectCourseExecutionOutcome } from '../../mips/core/machine/executeService';
import { runCourseProgram } from '../../mips/core/machine/execution';
import { compareTraces } from '../../language/mips/traceCompare';
import { parseCpuTraceOutput } from '../../language/mips/traceParser';

function assemble(body: string, profile: CourseProfile = 'P5') {
  const result = assembleCourseSource({ id: 'hazard-details', text: body }, { profile });
  expect(result.ok, result.diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toBe(true);
  return result.image!;
}
const halt = '\nhalt: beq $0,$0,halt\nnop';
const analyze = (body: string, profile: 'P5' | 'P6' | 'P7' = 'P5', maxEvents = 1000) =>
  analyzeHazardProgram(assemble(body + halt, profile), { profile, maxEvents, yieldControl: async () => {} });

/** Same actual execution-time operand injection used by existing hazard witness tests. */
function faultRun(body: string, profile: CourseProfile, pc: number, port: 'rs' | 'rt', stale: number, inject: boolean) {
  const image = assemble(body + halt, profile);
  const prepared = prepareCourseExecution({ profile, segments: image.segments, entryPc: image.entryPc,
    haltPc: findCourseHaltPc(image, profile), maxSteps: 256 });
  const state = prepared.session.machine.state;
  const read = state.gpr.read.bind(state.gpr);
  let hits = 0;
  let reads = 0;
  const hook = vi.spyOn(state.gpr, 'read').mockImplementation((register) => {
    if (inject && state.pc === pc && !hits) {
      const role = reads++ === 0 ? 'rs' : 'rt';
      if (role === port) { hits++; return stale; }
    }
    return read(register);
  });
  try {
    const result = projectCourseExecutionOutcome(prepared,
      runCourseProgram(prepared.session, { collectTrace: true, finalSnapshotLevel: 'full' }));
    expect(result.status).toBe('halted');
    return { hits, events: parseCpuTraceOutput(result.trace!.join('\n')) };
  } finally { hook.mockRestore(); }
}

describe('full-stream hazard details and consumer sensitivity', () => {
  it('keeps complete counters and keys when retained examples are capped at zero', async () => {
    const body = '.text\n' + Array.from({ length: 150 }, () =>
      'ori $1,$0,1\nori $1,$0,2\nadd $2,$1,$0\nori $0,$0,9\nadd $3,$0,$0').join('\n');
    const none = await analyze(body, 'P5', 0);
    const some = await analyze(body, 'P5', 20);
    expect(none.events).toEqual([]);
    expect(none.omittedEvents).toBeGreaterThan(500);
    expect(none.detailed).toEqual(some.detailed);
    expect(none.summary).toEqual(some.summary);
    expect(none.detailed!.priority.events).toBeGreaterThanOrEqual(150);
    expect(none.detailed!.zero.events).toBeGreaterThanOrEqual(300);
    expect(none.detailed!.forward.keys.some((key) => key.includes('.rs+'))).toBe(true);
    expect(none.detailed!.priority.keys).toContain('ori>ori>add.rs+0/0');
    expect(none.detailed!.zero.keys).toContain('ori>add.rt+0');
    expect(Buffer.byteLength(JSON.stringify(none))).toBeLessThan(4 * 1024 * 1024);
  });

  it('bounds distinct key retention while counting every observed event', () => {
    const model = new HazardPipelineModel();
    model.observe(hazardInstructionFor('ori', { rs: '$0', rt: '$1' })!, { previous: 0, next: 5 });
    const observation = model.observe(hazardInstructionFor('add', { rd: '$2', rs: '$1', rt: '$1' })!);
    const accumulator = new HazardDetailedAccumulator(1);
    accumulator.record(observation, 'add');
    accumulator.record(observation, 'add');
    const detail = accumulator.result().forward;
    expect(detail.events).toBe(4);
    expect(detail.validEvents).toBe(4);
    expect(detail.keys).toHaveLength(1);
    expect(detail.validKeys).toHaveLength(1);
    expect(detail.keysTruncated).toBe(true);
    expect(detail.validKeysTruncated).toBe(true);
    expect(detail.observability.unknown).toBe(4);
  });

  it('reports both simultaneous blocking ports without double-counting cycles or changing course tuples', async () => {
    const body = '.text\nori $22,$0,1\nsw $22,0($0)\nlw $1,0($0)\nadd $2,$0,$0\nbeq $1,$2,done\nnop\ndone: ori $20,$0,7';
    const first = await analyze(body);
    const second = await analyze(body.replace('beq $1,$2', 'beq $2,$1'));
    expect(first.summary.dataStallCycles).toBe(1);
    expect(second.summary.dataStallCycles).toBe(1);
    expect(first.stallTuples).toEqual(['beq<lw#1']);
    expect(second.stallTuples).toEqual(['beq<add#0']);
    expect(first.detailed!.stallCauses).toMatchObject({ events: 2, keys: ['add>beq.rt+0#0', 'lw>beq.rs+1#1'] });
    expect(second.detailed!.stallCauses).toMatchObject({ events: 2, keys: ['add>beq.rs+0#0', 'lw>beq.rt+1#1'] });
  });

  const cases = [
    { name: 'changed add result', body: '.text\nori $1,$0,5\nuse: add $2,$1,$0', status: 'observable', stale: 0 },
    { name: 'masked ori bits', body: '.text\nori $1,$0,0x1200\nuse: ori $2,$1,0xffff', status: 'masked', stale: 0 },
    { name: 'branch new and old both unequal', body: '.text\nori $1,$0,1\nnop\nnop\nnop\nori $1,$0,2\nuse: beq $1,$0,done\nnop\nori $2,$0,7\ndone: ori $3,$0,8', status: 'masked', stale: 1 },
    { name: 'branch target equals fallthrough', body: '.text\nori $1,$0,1\nuse: beq $1,$0,done\nnop\ndone: ori $2,$0,7', status: 'masked', stale: 0 },
    { name: 'load different RAM address same value', body: '.data\n.word 7,7\n.text\nori $1,$0,4\nuse: lw $2,0($1)', status: 'masked', stale: 0 },
    { name: 'store address changes even with equal data', body: '.text\nori $1,$0,4\nuse: sw $0,0($1)', status: 'observable', stale: 0 },
    { name: 'discarded destination', body: '.text\nori $1,$0,5\nuse: add $0,$1,$0', status: 'masked', stale: 0 }
  ] as const;
  it.each(cases)('separates value validity from $name and matches runtime injection', async ({ body, status, stale }) => {
    const image = assemble(body + halt);
    const pc = image.symbols.find((symbol) => symbol.name === 'use')!.value!;
    const report = await analyze(body);
    const event = report.events.find((item) => item.kind === 'forward' && item.consumerPc === pc && item.role === 'rs')!;
    expect(event).toMatchObject({ valid: true, observability: status });
    const normal = faultRun(body, 'P5', pc, 'rs', stale, false);
    const mutant = faultRun(body, 'P5', pc, 'rs', stale, true);
    expect(mutant.hits).toBe(1);
    expect(compareTraces(normal.events, mutant.events).matched).toBe(status === 'masked');
  });

  it('changes only one port when rs and rt name the same GPR', async () => {
    const body = '.text\nori $1,$0,5\nuse: sub $2,$1,$1';
    const image = assemble(body + halt);
    const pc = image.symbols.find((symbol) => symbol.name === 'use')!.value!;
    const report = await analyze(body);
    expect(report.events.filter((event) => event.consumerPc === pc && event.kind === 'forward').map((event) => event.observability))
      .toEqual(['observable', 'observable']);
    const normal = faultRun(body, 'P5', pc, 'rs', 0, false);
    for (const role of ['rs', 'rt'] as const) {
      const mutant = faultRun(body, 'P5', pc, role, 0, true);
      expect(mutant.hits).toBe(1);
      expect(compareTraces(normal.events, mutant.events).matched).toBe(false);
    }
  });

  it('compares selected store lanes rather than unused raw bits', async () => {
    const body = '.text\nori $1,$0,0x100\nuse: sb $1,0($0)';
    const report = await analyze(body, 'P6');
    const event = report.events.find((item) => item.kind === 'forward' && item.consumer === 'sb')!;
    expect(event).toMatchObject({ valid: true, observability: 'masked' });
    const pc = assemble(body + halt, 'P6').symbols.find((symbol) => symbol.name === 'use')!.value!;
    const normal = faultRun(body, 'P6', pc, 'rt', 0, false);
    const mutant = faultRun(body, 'P6', pc, 'rt', 0, true);
    expect(mutant.hits).toBe(1);
    expect(compareTraces(normal.events, mutant.events).matched).toBe(true);
  });

  it('keeps undefined old HI unknown and evaluates a previously defined half', async () => {
    const first = await analyze('.text\nori $1,$0,5\nmthi $1\nmfhi $2', 'P6');
    expect(first.events.find((event) => event.kind === 'hilo')).toMatchObject({ valid: true, observability: 'unknown' });
    const defined = await analyze('.text\nori $1,$0,5\nmthi $1\nori $1,$0,7\nmthi $1\nmfhi $2', 'P6');
    expect(defined.events.find((event) => event.kind === 'hilo')).toMatchObject({ valid: true, observability: 'observable' });
    expect(defined.detailed!.hiLo.observability.observable).toBe(1);
    const capped = await analyze('.text\nori $1,$0,5\nmthi $1\nori $1,$0,7\nmthi $1\nmfhi $2', 'P6', 0);
    expect(capped.events).toEqual([]);
    expect(capped.detailed!.hiLo).toEqual(defined.detailed!.hiLo);
  });

  it('preserves discarded raw values for core instructions outside the assessment whitelist', async () => {
    const report = await analyze('.text\nori $1,$0,1\nclz $0,$1\nadd $2,$0,$0\nmovn $0,$1,$1\nadd $2,$0,$0', 'P6');
    for (const producer of ['clz', 'movn']) {
      expect(report.events.some((event) => event.kind === 'zero' && event.producer === producer && event.valid)).toBe(true);
    }
    const cp0 = await analyze('.text\nori $1,$0,1\nmtc0 $1,$12\nmfc0 $0,$12\nadd $2,$0,$0', 'P7');
    expect(cp0.events.some((event) => event.kind === 'zero' && event.producer === 'mfc0' && event.valid)).toBe(true);
  });

  it('does not mutate RAM, registers, or PC while preparing store assessments', () => {
    const image = assemble('.data\n.word 7\n.text\nsw $1,0($0)');
    const prepared = prepareCourseExecution({ profile: 'P5', segments: image.segments });
    const session = prepared.session;
    session.machine.state.gpr.write(1, 5);
    const commit = vi.spyOn(session.machine.memory, 'commit');
    const before = session.snapshot('full');
    const assess = prepareHazardAssessment(session.profile, session.machine.state, session.machine.memory,
      image.segments.find((segment) => segment.name === 'text')!.words[0], 'sw', [{ role: 'rt', value: 0 }]);
    expect(assess({ role: 'rt', value: 0 })).toBe('observable');
    expect(session.snapshot('full')).toEqual(before);
    expect(commit).not.toHaveBeenCalled();
    commit.mockRestore();
  });

  it('does not prepare/read real device transactions or classify unsupported/undefined alternatives', () => {
    const image = assemble('.text\nlw $2,0($1)', 'P7');
    const prepared = prepareCourseExecution({ profile: 'P7', segments: image.segments });
    const session = prepared.session;
    session.machine.state.gpr.write(1, 0x7f00);
    const devicePrepare = vi.spyOn(session.devices!, 'prepare');
    const assess = prepareHazardAssessment(session.profile, session.machine.state, session.machine.memory,
      image.segments[0].words[0], 'lw', [{ role: 'rs', value: 0 }]);
    expect(assess({ role: 'rs', value: 0 })).toBe('unknown');
    expect(devicePrepare).not.toHaveBeenCalled();
    devicePrepare.mockRestore();
    session.machine.state.gpr.write(1, 0);
    const unsupported = prepareHazardAssessment(session.profile, session.machine.state, session.machine.memory,
      0x40026000, 'mfc0', [{ role: 'rs', value: 0 }]);
    expect(unsupported({ role: 'rs', value: 0 })).toBe('unknown');
    const p5 = prepareCourseExecution({ profile: 'P5', segments: image.segments });
    const invalid = prepareHazardAssessment(p5.session.profile, p5.session.machine.state, p5.session.machine.memory,
      image.segments[0].words[0], 'lw', [{ role: 'rs', value: 1 }]);
    expect(invalid({ role: 'rs', value: 1 })).toBe('unknown');
  });

  it('uses an explicit P7 IRQ schedule and reports the execution context', async () => {
    const program = assemble('.text\nori $1,$0,0x1001\nmtc0 $1,$12\nvictim: ori $2,$0,7' + halt +
      '\n.ktext 0x4180\nsb $0,0x7f20($0)\nori $3,$0,9\neret', 'P7');
    const victimPc = program.symbols.find((symbol) => symbol.name === 'victim')!.value!;
    const plain = await analyzeHazardProgram(program, { profile: 'P7', yieldControl: async () => {} });
    const scheduled = await analyzeHazardProgram(program, { profile: 'P7', executionSource: 'case', caseId: 'verified-case',
      externalInterrupts: [{ victimPc, occurrence: 1 }], yieldControl: async () => {} });
    expect(plain.execution).toEqual({ source: 'standalone', externalInterrupts: [] });
    expect(scheduled.execution).toEqual({ source: 'case', caseId: 'verified-case', externalInterrupts: [{ victimPc, occurrence: 1 }] });
    expect(scheduled.stopReason).toBe('course-halt-loop');
    expect(scheduled.summary.instructions).toBe(plain.summary.instructions + 3);
    expect(scheduled.warnings.some((warning) => warning.includes('中断'))).toBe(true);
  });

  it('rejects unsupported/malformed IRQ context before executing and snapshots valid requests', async () => {
    const image = assemble('.text\nori $1,$0,1\nori $2,$0,2' + halt);
    for (const [profile, externalInterrupts] of [
      ['P5', [{ victimPc: 0x3000, occurrence: 1 }]],
      ['P7', [{ victimPc: 0x3001, occurrence: 1 }]],
      ['P7', [{ victimPc: 0x3000, occurrence: 0 }]],
      ['P7', Array.from({ length: 4097 }, () => ({ victimPc: 0x3000, occurrence: 1 }))]
    ] as const) {
      await expect(analyzeHazardProgram(image, { profile, externalInterrupts })).rejects.toThrow(RangeError);
    }
    const requests = [{ victimPc: 0x3004, occurrence: 1 }];
    await expect(analyzeHazardProgram(image, { profile: 'P5', caseId: 'x'.repeat(129) })).rejects.toThrow('caseId');
    const report = await analyzeHazardProgram(image, { profile: 'P7', externalInterrupts: requests, sliceSize: 1,
      yieldControl: async () => { requests[0].victimPc = 0x3010; } });
    expect(report.execution!.externalInterrupts).toEqual([{ victimPc: 0x3004, occurrence: 1 }]);
  });
});
