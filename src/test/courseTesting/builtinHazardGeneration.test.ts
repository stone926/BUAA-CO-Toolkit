import { describe, expect, it, vi } from 'vitest';
import { automaticTestPolicy } from '../../courseTesting/automaticTestPolicy';
import { BuiltinAsmGeneratorOptions, BuiltinAsmGeneratorResult, generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { forwardTupleKey, stallTupleKey } from '../../hazardAnalysis/hazardCoverage';
import { decodeHazardInstruction } from '../../hazardAnalysis/hazardInstruction';
import { HazardObservation, HazardPipelineModel } from '../../hazardAnalysis/hazardPipeline';
import { HazardTracker } from '../../courseTesting/builtinAsm/hazard/hazardTracker';
import { predictForwardTuples } from '../../courseTesting/builtinAsm/hazard/hazardTargets';
import { courseDataByteLength, CpuState } from '../../courseTesting/cpuState';
import { p7ExceptionHandlerAddress } from '../../courseTesting/p7Hardware';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { CommitEvent } from '../../mips/core/events/commitEvent';
import { runCourseProgram } from '../../mips/core/machine/execution';
import { prepareCourseExecution } from '../../mips/core/machine/executeService';

function run(model: HazardPipelineModel, program: Array<[string, number?]>): HazardObservation[] {
  let previous = 0;
  return program.map(([text, next]) => {
    const decoded = decodeHazardInstruction(text);
    if (!decoded) throw new Error(`cannot decode ${text}`);
    const observation = model.observe(decoded, { previous, next: next ?? 0, raw: next ?? 0 });
    previous = next ?? previous;
    return observation;
  });
}

describe('course AT hazard model', () => {
  it('decodes operand roles from the canonical instruction formats', () => {
    expect(decodeHazardInstruction('sw $3, -4($7)')).toMatchObject({
      hazardClass: 'store',
      reads: [{ register: '$7', role: 'rs', useStage: 'E' }, { register: '$3', role: 'rt', useStage: 'M' }]
    });
    expect(decodeHazardInstruction('sllv $1, $2, $3')?.reads.map((read) => [read.register, read.role]))
      .toEqual([['$3', 'rs'], ['$2', 'rt']]);
    expect(decodeHazardInstruction('jal _x')?.write).toEqual({ register: '$31', readyStage: 'E' });
    expect(decodeHazardInstruction('lw $0, 0($1)')?.write).toEqual({ register: '$0', readyStage: 'W' });
    expect(decodeHazardInstruction('.word 0xfc000000')).toBeUndefined();
  });

  it('stalls a load-use pair once and forwards the first correct value from W', () => {
    const [, use] = run(new HazardPipelineModel(), [['lw $1, 0($0)', 7], ['add $2, $1, $0', 7]]);
    expect(use.stalls).toEqual([expect.objectContaining({ cause: 'lw', consumer: 'add', interval: 0 })]);
    expect(use.forwards).toEqual([expect.objectContaining({ source: 'W', destination: 'E', valid: true })]);
  });

  it('matches the course D-stage branch stalls for ALU and load producers', () => {
    expect(predictForwardTuples('add', 'beq', 'rs', 0)).toEqual([
      forwardTupleKey('add', 'beq', 'M', 'D'),
      stallTupleKey('beq', 'add', 0)
    ]);
    expect(predictForwardTuples('lw', 'beq', 'rs', 0)).toEqual([
      forwardTupleKey('lw', 'beq', 'W', 'D'),
      stallTupleKey('beq', 'lw', 0),
      stallTupleKey('beq', 'lw', 1)
    ]);
    expect(predictForwardTuples('lui', 'beq', 'rs', 0)).toEqual([forwardTupleKey('lui', 'beq', 'E', 'D')]);
    expect(predictForwardTuples('ori', 'sw', 'rt', 0)).toEqual([forwardTupleKey('ori', 'sw', 'M', 'E')]);
    expect(predictForwardTuples('ori', 'add', 'rs', 2)).toEqual([forwardTupleKey('ori', 'add', 'W', 'D')]);
  });

  it('marks a forward invalid when the register file already holds the same value', () => {
    const model = new HazardPipelineModel();
    const [, use] = run(model, [['ori $1, $0, 0', 0], ['addu $2, $1, $1', 0]]);
    expect(use.forwards.every((forward) => !forward.valid)).toBe(true);
  });

  it('never forwards a discarded $0 write but reports it as an observable hazard', () => {
    const model = new HazardPipelineModel();
    const [, use] = run(model, [['ori $0, $0, 5', 5], ['addu $2, $0, $0', 0]]);
    expect(use.forwards).toEqual([]);
    expect(use.zeroDestinations.length).toBeGreaterThan(0);
    expect(use.zeroDestinations.every((event) => event.valid)).toBe(true);
  });
});

describe('hazard-directed generation', () => {
  const profiles = ['P3', 'P4', 'P5', 'P6', 'P7'] as const;

  it.each(profiles)('matches the %s execution engine on all modeled GPRs and DM', (profile) => {
    for (const seed of ['a', 'b', 'c']) {
      const { generated, events } = expectModeledState({
        ...automaticTestPolicy(profile), profile, instructionText: '', seed: `hazard-model-${seed}`,
        p7StressMode: profile === 'P7' ? 'anchor' : 'off'
      });
      if (profile === 'P7') {
        expect(events.filter((event) => event.kind === 'interrupt')).toHaveLength(1);
        expect(events.some((event) => event.kind === 'exception')).toBe(true);
      }
      if (profile === 'P3' || profile === 'P4') expect(generated.hazardCoverage).toBeUndefined();
      else expect(generated.hazardCoverage?.stallTuples).toBeGreaterThan(0);
    }
  });

  it.each(['sync-only', 'handlerless'] as const)('matches all P7 modeled GPRs and DM in a %s program', (variant) => {
    const syncOnly = variant === 'sync-only';
    const policy = automaticTestPolicy('P7');
    const { generated, events } = expectModeledState({
      ...policy, profile: 'P7', p7StressMode: 'anchor', interrupt: false, seed: `hazard-model-${variant}`,
      instructionText: syncOnly ? '' : 'ori lui add sub addi div mfhi mflo lw sw beq jr jalr',
      exceptionRate: syncOnly ? policy.exceptionRate : 0
    });
    expect(generated.interruptSchedule).toEqual([]);
    expect(events.some((event) => event.pcBefore >= p7ExceptionHandlerAddress)).toBe(syncOnly);
    expect(events.some((event) => event.kind === 'exception')).toBe(syncOnly);
  });

  it('clears in-flight producers across P7 interrupt and synchronous handler returns', () => {
    const { generated, observations } = observeGenerated({
      profile: 'P7', interrupt: true, instructionText: 'ori syscall',
      instructionCount: 256, seed: 'p7-handler-hazard-boundary'
    });
    const { events, haltPc } = executeGenerated(generated);
    const payload = events.filter((event) => event.kind === 'instruction' && event.pcBefore < haltPc);
    expect(observations.map(({ mnemonic }) => mnemonic)).toEqual(payload.map(({ mnemonic }) => mnemonic));
    const traps = events.filter((event) => event.trap);
    expect(new Set(traps.map((event) => event.kind))).toEqual(new Set(['interrupt', 'exception']));
    for (const trap of traps) {
      // Consecutive syscalls can enter the handler again before any payload instruction commits.
      const index = payload.findIndex((event) => event.sequence > trap.sequence);
      expect(index).toBeGreaterThanOrEqual(0);
      const { pending, observation } = observations[index];
      expect(pending, `in-flight writes across ${trap.trap!.name} at 0x${trap.pcBefore.toString(16)}`).toBe(0);
      expect(observation.forwards).toEqual([]);
      expect(observation.stallCauses).toEqual([]);
    }
  });

  it.each([
    { interrupt: true, seed: 'mdubound88', victimPc: 0x3020, consumerPc: 0x3038, register: 25, source: 'M', gap: 1, handlerCount: 9 },
    { interrupt: false, seed: 'mdubound20', victimPc: 0x3238, consumerPc: 0x3248, register: 11, source: 'W', gap: 2, handlerCount: 8 }
  ])('ages DIV while the P7 synchronous handler executes (interrupt=$interrupt)', ({
    interrupt, seed, victimPc, consumerPc, register, source, gap, handlerCount
  }) => {
    const { generated, observations } = observeGenerated({
      profile: 'P7', interrupt, instructionText: 'div syscall mflo jr jalr addi',
      instructionCount: 256, exceptionRate: 0, seed
    });
    const { events, haltPc } = executeGenerated(generated);
    const victimIndex = events.findIndex((event) => event.trap?.name === 'syscall' && event.pcBefore === victimPc);
    expect(victimIndex).toBeGreaterThanOrEqual(2);
    expect(events.slice(victimIndex - 2, victimIndex).map(({ mnemonic }) => mnemonic)).toContain('div');
    const handler = events.slice(victimIndex + 1, victimIndex + 1 + handlerCount);
    expect(handler.every(({ pcBefore }) => pcBefore >= p7ExceptionHandlerAddress)).toBe(true);
    expect(handler.at(-1)).toMatchObject({ mnemonic: 'eret', pcAfter: victimPc + 4 });

    const payload = events.filter((event) => event.kind === 'instruction' && event.pcBefore < haltPc);
    expect(observations.map(({ mnemonic }) => mnemonic)).toEqual(payload.map(({ mnemonic }) => mnemonic));
    const consumerIndex = payload.findIndex((event) => event.pcBefore === consumerPc);
    const producerIndex = consumerIndex - gap - 1;
    expect(producerIndex).toBeGreaterThanOrEqual(0);
    expect(payload[producerIndex]).toMatchObject({
      mnemonic: 'addi', gprWrites: [expect.objectContaining({ register })]
    });
    expect(payload.slice(producerIndex + 1, consumerIndex).map(({ mnemonic }) => mnemonic))
      .toEqual(Array(gap).fill('mflo'));
    expect(observations[consumerIndex].observation.forwards).toContainEqual(expect.objectContaining({
      producer: 'addi', consumer: 'addi', register: `$${register}`, role: 'rs',
      gap, source, destination: 'D', valid: true
    }));
  });

  it('reaches most course forward and stall tuples in one default P6 program', () => {
    const generated = generateBuiltinAsmTestCase({
      ...automaticTestPolicy('P6'), profile: 'P6', instructionText: '', seed: 'hazard-strength'
    });
    // Course Hazard-Calculator upper bounds for P6: 1036 forward, 110 stall tuples.
    expect(generated.hazardCoverage!.forwardTuples).toBeGreaterThan(550);
    expect(generated.hazardCoverage!.stallTuples).toBeGreaterThan(55);
    expect(generated.text).toMatch(/^# hazard_coverage: forward_tuples=\d+ stall_tuples=\d+/m);
  });

  it('does not add hazard metadata to single-cycle profiles', () => {
    const generated = generateBuiltinAsmTestCase({
      ...automaticTestPolicy('P3'), profile: 'P3', instructionText: '', seed: 'single-cycle'
    });
    expect(generated.hazardCoverage).toBeUndefined();
    expect(generated.text).not.toContain('hazard_coverage');
  });
});

function observeGenerated(options: BuiltinAsmGeneratorOptions) {
  const observations: Array<{ mnemonic: string; pending: number; observation: HazardObservation }> = [];
  const record = HazardTracker.prototype.record;
  const observe = HazardPipelineModel.prototype.observe;
  let generatorModel: HazardPipelineModel | undefined;
  const recordSpy = vi.spyOn(HazardTracker.prototype, 'record').mockImplementation(function (this: HazardTracker, ...args) {
    generatorModel = this.model;
    record.apply(this, args);
  });
  const observeSpy = vi.spyOn(HazardPipelineModel.prototype, 'observe').mockImplementation(function (
    this: HazardPipelineModel, instruction, values
  ) {
    const pending = this === generatorModel ? this.pendingProducers().length : 0;
    const observation = observe.call(this, instruction, values);
    if (this === generatorModel) observations.push({ mnemonic: instruction.mnemonic, pending, observation });
    return observation;
  });
  try {
    return { generated: generateBuiltinAsmTestCase(options), observations };
  } finally {
    observeSpy.mockRestore();
    recordSpy.mockRestore();
  }
}

function expectModeledState(options: BuiltinAsmGeneratorOptions) {
  let modelState: CpuState | undefined;
  const original = CpuState.prototype.setRegister;
  const spy = vi.spyOn(CpuState.prototype, 'setRegister').mockImplementation(function (this: CpuState, register, value) {
    modelState ??= this;
    return original.call(this, register, value);
  });
  let generated: BuiltinAsmGeneratorResult;
  try {
    generated = generateBuiltinAsmTestCase(options);
  } finally {
    spy.mockRestore();
  }
  expect(modelState).toBeDefined();
  const { events, snapshot } = executeGenerated(generated);
  const label = `${options.profile}/${options.seed}`;
  for (let register = 0; register < 32; register++) {
    expect(snapshot.gpr[register], `${label} $${register}`).toBe(modelState!.regValue(`$${register}`) >>> 0);
  }
  const expectedDm = [];
  for (let address = 0; address < courseDataByteLength; address += 4) {
    const value = modelState!.wordAt(address) >>> 0;
    if (value !== 0) expectedDm.push({ address, value });
  }
  expect(snapshot.dataWords?.filter(({ address }) => address < courseDataByteLength), `${label} DM`)
    .toEqual(expectedDm);
  return { generated, events };
}

function executeGenerated(generated: BuiltinAsmGeneratorResult) {
  const { profile, text } = generated;
  const assembled = assembleCourseSource({ id: 'hazard', text }, { profile });
  expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
  const image = assembled.image!;
  const haltPc = findCourseHaltPc(image, profile)!;
  const prepared = prepareCourseExecution({
    profile,
    enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
    segments: image.segments,
    entryPc: image.entryPc,
    haltPc,
    maxSteps: 65_536,
    externalInterrupts: generated.interruptSchedule.map((victimPc) => ({ victimPc, occurrence: 1 }))
  });
  const events: CommitEvent[] = [];
  const outcome = runCourseProgram(prepared.session, {
    onEvents: (slice) => events.push(...slice), finalSnapshotLevel: 'full'
  });
  expect(outcome, outcome.diagnostic?.message).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
  return { events, snapshot: outcome.finalSnapshot, haltPc };
}
