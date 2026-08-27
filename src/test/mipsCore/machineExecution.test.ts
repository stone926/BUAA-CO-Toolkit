import { describe, expect, it } from 'vitest';
import { runCourseProgram } from '../../mips/core/machine/execution';
import {
  committedEvents,
  gprWrites,
  haltSequence,
  makeSession,
  memoryWrites,
  op,
  runToCompletion
} from './programFixtures';

/**
 * P3-P6 architectural execution. Expected values are derived from the tutorial
 * contract (reset state, delay-slot rules, link value, halt sequence), never from
 * the executor itself.
 */

describe('P3/P4 single-cycle execution', () => {
  const program = [
    op('ori', { rs: 0, rt: 1, immediate: 5 }),
    op('ori', { rs: 0, rt: 2, immediate: 3 }),
    op('add', { rd: 3, rs: 1, rt: 2 }),
    op('sw', { rs: 0, rt: 3, immediate: 0 }),
    ...haltSequence
  ];

  it('commits arithmetic and stores, then stops on the self-branch without a delay slot', () => {
    const session = makeSession('P3', program);
    const trace = runToCompletion(session);

    expect(gprWrites(trace)).toEqual([[1, 5], [2, 3], [3, 8]]);
    expect(memoryWrites(trace)).toEqual([[0x0000_0000, 8]]);
    expect(trace.last.status).toBe('halted');
    // P3 has no delay slot: the self-branch itself is the last committed word.
    const last = committedEvents(trace).at(-1)!;
    expect(last.pcBefore).toBe(0x0000_3010);
    expect(last.haltReason).toBe('course-halt-loop');
    expect(session.instructionsExecuted).toBe(5);
  });

  it('never records a write to $0 and never lets it change', () => {
    const session = makeSession('P3', [
      op('ori', { rs: 0, rt: 0, immediate: 0x1234 }),
      op('add', { rd: 0, rs: 0, rt: 0 }),
      ...haltSequence
    ]);
    const trace = runToCompletion(session);
    expect(gprWrites(trace)).toEqual([]);
    expect(session.snapshot().gpr[0]).toBe(0);
  });

  it('wraps signed overflow instead of trapping on P3-P6', () => {
    for (const profile of ['P3', 'P4', 'P5', 'P6'] as const) {
      const words = [
        op('lui', { rt: 1, immediate: 0x7fff }),
        op('ori', { rs: 1, rt: 1, immediate: 0xffff }),
        op('add', { rd: 2, rs: 1, rt: 1 }),
        ...haltSequence
      ];
      const trace = runToCompletion(makeSession(profile, words));
      const writes = gprWrites(trace);
      // 0x7fffffff + 0x7fffffff wraps to 0xfffffffe with no exception.
      expect(writes.at(-1), profile).toEqual([2, 0xffff_fffe]);
      expect(trace.last.status, profile).toBe('halted');
    }
  });

  it('links jal to PC+4 and returns through jr without a delay slot on P4', () => {
    //  0x3000 jal 0x3010   -> $31 = 0x3004 (next sequential word)
    //  0x3004 ori $1,$0,1  <- return target, executed after jr
    //  0x3008 beq/nop halt
    //  0x3010 jr $31
    const words = [
      op('jal', { index: 0x3010 >>> 2 }),
      op('ori', { rs: 0, rt: 1, immediate: 1 }),
      ...haltSequence,
      op('jr', { rs: 31 })
    ];
    const trace = runToCompletion(makeSession('P4', words));
    expect(gprWrites(trace)).toEqual([[31, 0x0000_3004], [1, 1]]);
    const sequence = committedEvents(trace).map((event) => event.pcBefore);
    expect(sequence).toEqual([0x3000, 0x3010, 0x3004, 0x3008]);
  });
});

describe('P5/P6 delayed control transfer', () => {
  it('links jal to PC+8 and always executes the delay slot', () => {
    //  0x3000 jal 0x3010
    //  0x3004 ori $2,$0,7   <- delay slot, always executes
    //  0x3008 ori $3,$0,9   <- return target ($31 = 0x3008)
    //  0x300c/0x3010 halt sequence is placed after the callee
    const words = [
      op('jal', { index: 0x3014 >>> 2 }),
      op('ori', { rs: 0, rt: 2, immediate: 7 }),
      op('ori', { rs: 0, rt: 3, immediate: 9 }),
      ...haltSequence,
      op('jr', { rs: 31 }),
      op('nop')
    ];
    const trace = runToCompletion(makeSession('P5', words));
    expect(gprWrites(trace)).toEqual([[31, 0x0000_3008], [2, 7], [3, 9]]);
    const sequence = committedEvents(trace).map((event) => event.pcBefore);
    expect(sequence).toEqual([0x3000, 0x3004, 0x3014, 0x3018, 0x3008, 0x300c, 0x3010]);
  });

  it('runs the delay slot of a not-taken branch and falls through to PC+8', () => {
    const words = [
      op('ori', { rs: 0, rt: 1, immediate: 1 }),
      op('beq', { rs: 0, rt: 1, immediate: 4 }),
      op('ori', { rs: 0, rt: 2, immediate: 2 }),
      op('ori', { rs: 0, rt: 3, immediate: 3 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words));
    expect(gprWrites(trace)).toEqual([[1, 1], [2, 2], [3, 3]]);
    const branch = committedEvents(trace).find((event) => event.mnemonic === 'beq')!;
    expect(branch.branchTaken).toBe(false);
    expect(branch.controlTarget).toBe(0x0000_300c);
  });

  it('marks the delay-slot instruction and its branch origin', () => {
    const words = [
      op('beq', { rs: 0, rt: 0, immediate: 1 }),
      op('ori', { rs: 0, rt: 1, immediate: 1 }),
      op('ori', { rs: 0, rt: 2, immediate: 2 }),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words));
    const slot = committedEvents(trace)[1];
    expect(slot.pcBefore).toBe(0x0000_3004);
    expect(slot.delaySlot).toBe(true);
    expect(slot.branchOriginPc).toBe(0x0000_3000);
    expect(slot.pcAfter).toBe(0x0000_3008);
    // The taken branch skipped 0x3008; the next committed PC proves it.
    expect(committedEvents(trace)[2].pcBefore).toBe(0x0000_3008);
  });

  it('writes the REGIMM link register even when the branch is not taken', () => {
    // MARS-DIV-REGIMM-001: stable MARS omits this write; the course contract does not.
    const words = [
      op('ori', { rs: 0, rt: 1, immediate: 1 }),
      op('bltzal', { rs: 1, immediate: 4 }),
      op('nop'),
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', words, {
      layers: ['required', 'commonExtensions', 'marsCompatibility']
    }));
    expect(gprWrites(trace)).toEqual([[1, 1], [31, 0x0000_300c]]);
    const branch = committedEvents(trace).find((event) => event.mnemonic === 'bltzal')!;
    expect(branch.branchTaken).toBe(false);
  });

  it('requires the delay-slot nop to commit before halting', () => {
    const session = makeSession('P6', [op('ori', { rs: 0, rt: 1, immediate: 1 }), ...haltSequence]);
    const first = session.stepInstruction();
    const branch = session.stepInstruction();
    expect(first.status).toBe('committed');
    // The self-branch alone must not stop the run.
    expect(branch.status).toBe('committed');
    expect(branch.event?.pcBefore).toBe(0x0000_3004);
    const slot = session.stepInstruction();
    expect(slot.status).toBe('halted');
    expect(slot.event?.haltReason).toBe('course-halt-loop');
    expect(slot.event?.pcBefore).toBe(0x0000_3008);
  });
});

describe('execution budget and halt validation', () => {
  it('stops with step-limit when the program never reaches the halt loop', () => {
    // A two-instruction backward loop that is deliberately not the course halt
    // sequence: `beq $0, $0, -2` targets 0x3000, and its word is not 0x1000ffff.
    const session = makeSession('P6', [
      op('nop'),
      op('beq', { rs: 0, rt: 0, immediate: -2 }),
      op('nop')
    ], { maxSteps: 12 });
    const trace = runToCompletion(session);
    expect(trace.last.status).toBe('step-limit');
    expect(trace.last.diagnostic?.code).toBe('mips-core.exec.step-limit');
    expect(session.instructionsExecuted).toBe(12);
  });

  it('refuses to halt at a self-branch other than the validated halt PC', () => {
    const words = [
      op('beq', { rs: 0, rt: 0, immediate: -1 }),
      op('nop'),
      ...haltSequence
    ];
    const session = makeSession('P6', words, { haltPc: 0x0000_3008, maxSteps: 20 });
    const trace = runToCompletion(session);
    expect(trace.last.status).toBe('step-limit');
    expect(session.courseHaltPc).toBeUndefined();
  });

  it('reports the self-branch PC as the course halt PC, not the delay-slot nop', () => {
    // `MachineSessionOptions.haltPc`, `AssembleResult.courseHaltPc` and the legacy
    // MARS halt proof all name the 0x1000ffff self-branch. The commit event that
    // finally stops the run is the delay-slot `nop`, so the two must not be
    // conflated (COURSE-COMMON-HALT-001).
    const session = makeSession('P6', [op('ori', { rs: 0, rt: 1, immediate: 1 }), ...haltSequence]);
    const outcome = runCourseProgram(session, { sliceSize: 4 });
    expect(outcome.status).toBe('halted');
    expect(outcome.haltReason).toBe('course-halt-loop');
    expect(outcome.haltPc).toBe(0x0000_3004);
    expect(session.courseHaltPc).toBe(0x0000_3004);
    expect(outcome.retainedEvents).toEqual([]);
    expect(outcome.instructions).toBe(3);

    // On P3 the branch is the last committed word, so both conventions coincide.
    const p3 = makeSession('P3', [op('ori', { rs: 0, rt: 1, immediate: 1 }), ...haltSequence]);
    expect(runCourseProgram(p3).haltPc).toBe(0x0000_3004);
  });

  it('leaves the course halt PC unset when the run never reaches the halt loop', () => {
    const session = makeSession('P6', [
      op('nop'),
      op('beq', { rs: 0, rt: 0, immediate: -2 }),
      op('nop')
    ], { maxSteps: 6 });
    const outcome = runCourseProgram(session);
    expect(outcome.status).toBe('step-limit');
    expect(outcome.haltPc).toBeUndefined();
    expect(session.courseHaltPc).toBeUndefined();
  });
});
