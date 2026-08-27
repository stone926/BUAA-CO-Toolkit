import { describe, expect, it } from 'vitest';
import { CommitEvent, TrapRecord } from '../../mips/core/events/commitEvent';
import { Cp0Snapshot } from '../../mips/core/machine/state';
import { CourseSystemSession, DeviceSchedule } from '../../mips/core/machine/system';
import {
  FixtureOptions,
  RunTrace,
  committedEvents,
  gprWrites,
  haltSequence,
  makeSession,
  op,
  runToCompletion,
  textBase
} from './programFixtures';

/**
 * P7 architectural exception contract: which Req is accepted, what `Cause`/`EPC`/`SR`
 * hold afterwards, and what the victim is forbidden to commit.
 *
 * Every expected value is hand-derived from the frozen course contract ledger in
 * `conformance/mips/contract/contracts.json`, never from the executor:
 *
 * - COURSE-P7-ADDR-002/004: IM is `0x3000..0x6fff` (last word `0x6ffc`); every
 *   exception and interrupt enters the single handler at `0x4180`.
 * - COURSE-P7-CP0-002/003: `SR.IM = 15:10`, `SR.EXL = 1`, `SR.IE = 0`;
 *   `Cause.BD = 31`, `Cause.IP = 15:10`, `Cause.ExcCode = 6:2`.
 * - COURSE-P7-EXC-002: `Int = 0, AdEL = 4, AdES = 5, Syscall = 8, RI = 10, Ov = 12`.
 * - COURSE-P7-EXC-001: entering a Req sets `EXL`; `eret` clears it and jumps to `EPC`.
 * - COURSE-P7-EXC-009: a delay-slot victim sets `Cause.BD` and `EPC = victimPC - 4`,
 *   whether or not the branch was taken.
 * - COURSE-P7-EXC-010/011: a bad new PC makes the mis-fetched instruction the victim,
 *   so `EPC` holds the *bad* PC itself.
 * - COURSE-P7-EXC-012/013/014: alignment, region and Timer-port address errors, plus
 *   the read-only Timer `COUNT` port whose write must be suppressed before commit.
 * - COURSE-P7-EXC-015/016/017: `Ov` on `add/addi/sub`, `Syscall`, and `RI` for an
 *   opcode / R-type funct outside the enabled P7 instruction set.
 * - COURSE-P7-EXC-019: the victim leaves no partial GPR/DM/CP0/device write behind.
 * - COURSE-P7-EXC-020: falling through `0x417c -> 0x4180` is ordinary execution.
 * - COURSE-P7-EXC-022 + COURSE-P7-CP0-001: `mtc0` may retarget `SR`/`EPC`; `Cause` is
 *   never written by the course, so it is not a writable CP0 register.
 * - COURSE-P7-ERET-001: `eret` has no delay slot; the word after it never executes.
 * - COURSE-P7-EXC-024 / COURSE-P7-EXC-PRIORITY-001: one victim keeps the earliest
 *   non-zero stage code, `F > D > E > M`; across victims the oldest one wins.
 *
 * `Cause` values below are written as literals with their derivation, so a change to
 * the field layout has to be argued against the ledger rather than re-recorded.
 */

/** COURSE-P7-ADDR-004: the single exception/interrupt entry point. */
const handlerPc = 0x0000_4180;

/** COURSE-P7-CP0-002: `SR.EXL` is bit 1; it is the only SR bit a Req may set. */
const statusExl = 0x0000_0002;

/** COURSE-P7-EXC-002 exception codes. */
const excCode = { adel: 4, ades: 5, syscall: 8, ri: 10, ov: 12 } as const;

/**
 * `Cause` for a victim outside a delay slot: `ExcCode` sits in bits 6:2 and no other
 * field is set (`BD = 0`, `IP = 0` because no course device drives HWInt here).
 */
const cause = {
  adel: 0x0000_0010, //  4 << 2
  ades: 0x0000_0014, //  5 << 2
  syscall: 0x0000_0020, //  8 << 2
  ri: 0x0000_0028, // 10 << 2
  ov: 0x0000_0030 // 12 << 2
} as const;

/** COURSE-P7-CP0-003: `Cause.BD` is bit 31, set for a delay-slot victim. */
const causeBranchDelay = 0x8000_0000;

/**
 * Handler body used by every trap fixture: the course halt loop, so the run stops
 * cleanly at `0x4180` instead of falling into unloaded IM.
 */
const parkingHandler = haltSequence;

/**
 * Timer transactions only reach the width / COUNT predicates when the timers are
 * enabled. The timeline stays empty: this suite never wants an implicit clock edge,
 * it drives `tickDevices` explicitly where a cycle matters.
 */
const timersEnabled: DeviceSchedule = { kind: 'timeline', entries: [] };

interface P7Run {
  readonly session: CourseSystemSession;
  readonly trace: RunTrace;
}

function runP7(words: readonly number[], options: FixtureOptions = {}): P7Run {
  const session = makeSession('P7', words, { kernelWords: parkingHandler, ...options });
  return { session, trace: runToCompletion(session) };
}

function trapEvents(trace: RunTrace): CommitEvent[] {
  return trace.events.filter((event) => event.trap !== undefined);
}

/** The single accepted Req of a run; more than one means the fixture drifted. */
function onlyTrap(trace: RunTrace): { readonly event: CommitEvent; readonly trap: TrapRecord } {
  const events = trapEvents(trace);
  if (events.length !== 1) {
    throw new Error(`expected exactly one accepted Req, got ${events.length}`);
  }
  return { event: events[0], trap: events[0].trap! };
}

function cp0State(session: CourseSystemSession): Cp0Snapshot {
  const state = session.snapshot().cp0;
  if (!state) {
    throw new Error('a P7 session must expose CP0 state');
  }
  return state;
}

function pcSequence(trace: RunTrace): number[] {
  return committedEvents(trace).map((event) => event.pcBefore);
}

describe('P7 arithmetic overflow exceptions', () => {
  /** Two required-layer instructions build the operand, so the victim is always 0x3008. */
  const victimPc = textBase + 0x8;

  const cases = [
    {
      mnemonic: 'add',
      destination: 2,
      words: [
        op('lui', { rt: 1, immediate: 0x7fff }),
        op('ori', { rs: 1, rt: 1, immediate: 0xffff }), // $1 = 0x7fffffff
        op('add', { rd: 2, rs: 1, rt: 1 }) // +2^31 - 1 twice leaves the signed range
      ]
    },
    {
      mnemonic: 'addi',
      destination: 2,
      words: [
        op('lui', { rt: 1, immediate: 0x7fff }),
        op('ori', { rs: 1, rt: 1, immediate: 0xffff }), // $1 = 0x7fffffff
        op('addi', { rs: 1, rt: 2, immediate: 1 }) // 0x7fffffff + 1
      ]
    },
    {
      mnemonic: 'sub',
      destination: 3,
      words: [
        op('lui', { rt: 1, immediate: 0x8000 }), // $1 = 0x80000000 = -2^31
        op('ori', { rs: 0, rt: 2, immediate: 1 }), // $2 = 1
        op('sub', { rd: 3, rs: 1, rt: 2 }) // -2^31 - 1
      ]
    }
  ] as const;

  it('raises Ov with ExcCode 12 and commits no result register', () => {
    for (const testCase of cases) {
      const { session, trace } = runP7(testCase.words);
      const { event, trap } = onlyTrap(trace);
      const label = testCase.mnemonic;

      // COURSE-P7-EXC-015: only add/addi/sub trap, and they trap in the E stage.
      expect(trap.kind, label).toBe('exception');
      expect(trap.name, label).toBe('ov');
      expect(trap.code, label).toBe(excCode.ov);
      expect(trap.stage, label).toBe('execute');
      expect(trap.victimPc, label).toBe(victimPc);
      expect(trap.branchDelay, label).toBe(false);
      expect(trap.epc, label).toBe(victimPc);
      expect(trap.handlerPc, label).toBe(handlerPc);

      expect(event.kind, label).toBe('exception');
      expect(event.mnemonic, label).toBe(testCase.mnemonic);
      expect(event.pcBefore, label).toBe(victimPc);
      expect(event.pcAfter, label).toBe(handlerPc);

      // COURSE-P7-EXC-019: the victim contributes no architectural side effect.
      expect(event.gprWrites, label).toEqual([]);
      expect(event.memoryWrites, label).toEqual([]);

      const state = session.snapshot();
      expect(state.gpr[testCase.destination], label).toBe(0);
      expect(state.pc, label).toBe(handlerPc);

      const cp0 = cp0State(session);
      expect(cp0.cause, label).toBe(cause.ov);
      expect(cp0.epc, label).toBe(victimPc);
      expect(cp0.status, label).toBe(statusExl);
      expect(trace.last.status, label).toBe('halted');
    }
  });
});

describe('P7 load address errors', () => {
  /** Every load below is the very first instruction, so the victim PC is the entry PC. */
  const victimPc = textBase;

  const cases = [
    {
      label: 'lw at a 2-byte offset',
      mnemonic: 'lw',
      // COURSE-P7-EXC-012: lw must be 4-byte aligned.
      word: op('lw', { rs: 0, rt: 1, immediate: 2 })
    },
    {
      label: 'lh at an odd address',
      mnemonic: 'lh',
      // COURSE-P7-EXC-012: lh must be 2-byte aligned.
      word: op('lh', { rs: 0, rt: 1, immediate: 1 })
    },
    {
      label: 'lw past every mapped region',
      mnemonic: 'lw',
      // 0x7f30 is above the interrupt generator (0x7f20..0x7f23): COURSE-P7-EXC-013.
      word: op('lw', { rs: 0, rt: 1, immediate: 0x7f30 })
    },
    {
      label: 'lw aimed at the instruction segment',
      mnemonic: 'lw',
      // IM is instruction-only; a data load never resolves there (COURSE-P7-EXC-013).
      word: op('lw', { rs: 0, rt: 1, immediate: 0x3000 })
    },
    {
      label: 'lb against the Timer0 CTRL port',
      mnemonic: 'lb',
      // COURSE-P7-EXC-013: Timer registers are word ports; lb/lh against them is AdEL.
      word: op('lb', { rs: 0, rt: 1, immediate: 0x7f00 })
    },
    {
      label: 'lh against the Timer1 CTRL port',
      mnemonic: 'lh',
      word: op('lh', { rs: 0, rt: 1, immediate: 0x7f10 })
    }
  ] as const;

  it('reports AdEL with ExcCode 4 and leaves the destination register untouched', () => {
    for (const testCase of cases) {
      const { session, trace } = runP7([testCase.word], { deviceSchedule: timersEnabled });
      const { event, trap } = onlyTrap(trace);
      const label = testCase.label;

      expect(trap.kind, label).toBe('exception');
      expect(trap.name, label).toBe('adel');
      expect(trap.code, label).toBe(excCode.adel);
      // Data address errors are detected in the M stage, not at fetch.
      expect(trap.stage, label).toBe('memory');
      expect(trap.victimPc, label).toBe(victimPc);
      expect(trap.branchDelay, label).toBe(false);
      expect(trap.epc, label).toBe(victimPc);

      expect(event.mnemonic, label).toBe(testCase.mnemonic);
      expect(event.instructionWord, label).toBe(testCase.word);
      expect(event.pcAfter, label).toBe(handlerPc);
      expect(event.gprWrites, label).toEqual([]);
      expect(event.memoryReads, label).toBeUndefined();

      expect(session.snapshot().gpr[1], label).toBe(0);
      const cp0 = cp0State(session);
      expect(cp0.cause, label).toBe(cause.adel);
      expect(cp0.epc, label).toBe(victimPc);
      expect(cp0.status, label).toBe(statusExl);
    }
  });
});

describe('P7 store address errors', () => {
  /** $1 = 0xdeadbeef so a leaked store would be visible in DM; the victim is 0x3008. */
  const prologue = [
    op('lui', { rt: 1, immediate: 0xdead }),
    op('ori', { rs: 1, rt: 1, immediate: 0xbeef })
  ];
  const victimPc = textBase + 0x8;

  const cases = [
    {
      label: 'sw at a 1-byte offset',
      mnemonic: 'sw',
      word: op('sw', { rs: 0, rt: 1, immediate: 1 }) // COURSE-P7-EXC-012
    },
    {
      label: 'sh at an odd address',
      mnemonic: 'sh',
      word: op('sh', { rs: 0, rt: 1, immediate: 3 }) // COURSE-P7-EXC-012
    },
    {
      label: 'sw past every mapped region',
      mnemonic: 'sw',
      word: op('sw', { rs: 0, rt: 1, immediate: 0x7f30 }) // COURSE-P7-EXC-013
    },
    {
      label: 'sw aimed at the instruction segment',
      mnemonic: 'sw',
      word: op('sw', { rs: 0, rt: 1, immediate: 0x3000 })
    },
    {
      label: 'sb against the Timer0 CTRL port',
      mnemonic: 'sb',
      word: op('sb', { rs: 0, rt: 1, immediate: 0x7f00 }) // COURSE-P7-EXC-013
    },
    {
      label: 'sh against the Timer1 CTRL port',
      mnemonic: 'sh',
      word: op('sh', { rs: 0, rt: 1, immediate: 0x7f10 })
    }
  ] as const;

  it('reports AdES with ExcCode 5 and writes nothing to data memory', () => {
    for (const testCase of cases) {
      const { session, trace } = runP7([...prologue, testCase.word], {
        deviceSchedule: timersEnabled
      });
      const { event, trap } = onlyTrap(trace);
      const label = testCase.label;

      expect(trap.kind, label).toBe('exception');
      expect(trap.name, label).toBe('ades');
      expect(trap.code, label).toBe(excCode.ades);
      expect(trap.stage, label).toBe('memory');
      expect(trap.victimPc, label).toBe(victimPc);
      expect(trap.branchDelay, label).toBe(false);
      expect(trap.epc, label).toBe(victimPc);

      expect(event.mnemonic, label).toBe(testCase.mnemonic);
      expect(event.pcAfter, label).toBe(handlerPc);
      expect(event.memoryWrites, label).toEqual([]);

      const state = session.snapshot('full');
      // COURSE-P7-EXC-019: no byte of DM moved, and the source register survived.
      expect(state.dataWords, label).toEqual([]);
      expect(state.gpr[1], label).toBe(0xdead_beef);

      const cp0 = cp0State(session);
      expect(cp0.cause, label).toBe(cause.ades);
      expect(cp0.epc, label).toBe(victimPc);
      expect(cp0.status, label).toBe(statusExl);
    }
  });

  it('raises AdES for a write to the Timer COUNT port without disturbing the device', () => {
    // COURSE-P7-TIMER-001 / COURSE-P7-EXC-014: COUNT (+8) is read-only; the store must
    // be suppressed before the Timer commits it.
    const words = [
      op('ori', { rs: 0, rt: 1, immediate: 20 }), // PRESET value
      op('ori', { rs: 0, rt: 2, immediate: 1 }), // CTRL: IM=0, Mode=0, Enable=1
      op('sw', { rs: 0, rt: 1, immediate: 0x7f04 }), // Timer0 PRESET
      op('sw', { rs: 0, rt: 2, immediate: 0x7f00 }), // Timer0 CTRL
      op('sw', { rs: 0, rt: 0, immediate: 0x7f08 }) // Timer0 COUNT  <- the victim
    ];
    const victimPc = textBase + 0x10;
    const session = makeSession('P7', words, {
      kernelWords: parkingHandler,
      deviceSchedule: timersEnabled
    });

    for (let index = 0; index < 4; index++) {
      expect(session.stepInstruction().status, `setup instruction ${index}`).toBe('committed');
    }

    // COURSE-P7-TIMER-004/006, derived from P7_standard_timer_2019.v: each bus write
    // reserves one clock edge (`else if(WE)` suppresses the state machine), so edges
    // 1-2 are consumed by the PRESET/CTRL writes, edge 3 is IDLE -> LOAD, edge 4 loads
    // COUNT = PRESET = 20 and enters CNT, and edge 5 decrements COUNT to 19.
    session.tickDevices({ cycles: 5 });
    const before = session.devices!.timer0.snapshot();
    expect(before.count, 'COUNT must be loaded for "unchanged" to mean anything').toBe(19);

    const result = session.stepInstruction();
    const after = session.devices!.timer0.snapshot();
    const trap = result.event!.trap!;

    expect(trap.name).toBe('ades');
    expect(trap.code).toBe(excCode.ades);
    expect(trap.stage).toBe('memory');
    expect(trap.victimPc).toBe(victimPc);
    expect(trap.epc).toBe(victimPc);
    expect(result.event!.memoryWrites).toEqual([]);
    expect(result.event!.deviceEvents).toEqual([]);

    // The whole device state, COUNT included, must be exactly what it was: the
    // transaction never reached the Timer port.
    expect(after.count).toBe(before.count);
    expect(after).toEqual(before);

    const cp0 = cp0State(session);
    expect(cp0.cause).toBe(cause.ades);
    expect(cp0.epc).toBe(victimPc);
    expect(cp0.status).toBe(statusExl);
  });
});

describe('P7 instruction-fetch address errors', () => {
  /** `jr` through $1 after two words, so the bad PC is reached from the delay slot. */
  function jumpTo(target: number): readonly number[] {
    return [
      op('ori', { rs: 0, rt: 1, immediate: target }),
      op('jr', { rs: 1 }),
      op('nop') // the delay slot always executes (P5+ delay-slot rule)
    ];
  }

  const cases = [
    {
      label: 'a misaligned PC inside IM',
      // COURSE-P7-EXC-011: an IF address that is not 4-byte aligned is AdEL.
      badPc: 0x0000_3006
    },
    {
      label: 'a PC past the last IM word 0x6ffc',
      // COURSE-P7-ADDR-002 + COURSE-P7-EXC-011: 0x7000 is outside 0x3000..0x6fff.
      badPc: 0x0000_7000
    }
  ] as const;

  it('reports AdEL at the fetch stage and stores the bad new PC in EPC', () => {
    for (const testCase of cases) {
      const { session, trace } = runP7(jumpTo(testCase.badPc));
      const { event, trap } = onlyTrap(trace);
      const label = testCase.label;

      expect(trap.kind, label).toBe('exception');
      expect(trap.name, label).toBe('adel');
      expect(trap.code, label).toBe(excCode.adel);
      expect(trap.stage, label).toBe('fetch');
      // COURSE-P7-EXC-010: the victim is the instruction whose PC is wrong, so both
      // the victim PC and EPC are the bad address itself - not the jr, not jr + 4.
      expect(trap.victimPc, label).toBe(testCase.badPc);
      expect(trap.epc, label).toBe(testCase.badPc);
      expect(trap.branchDelay, label).toBe(false);

      expect(event.pcBefore, label).toBe(testCase.badPc);
      expect(event.pcAfter, label).toBe(handlerPc);
      // Nothing was fetched, so there is no instruction word and no mnemonic.
      expect(event.instructionWord, label).toBeUndefined();
      expect(event.mnemonic, label).toBeUndefined();

      // Only the address setup committed; the jr and its delay slot wrote nothing.
      expect(gprWrites(trace), label).toEqual([[1, testCase.badPc]]);

      const cp0 = cp0State(session);
      expect(cp0.cause, label).toBe(cause.adel);
      expect(cp0.epc, label).toBe(testCase.badPc);
      expect(cp0.status, label).toBe(statusExl);
    }
  });
});

describe('P7 reserved-instruction exceptions', () => {
  const cases = [
    {
      label: 'sll, whose funct 0 encoding lives in the marsCompatibility layer',
      // sll $1, $2, 3 = rt(2) << 16 | rd(1) << 11 | shamt(3) << 6 | funct 0.
      // Non-zero fields keep it distinct from nop (the only enabled funct-0 entry).
      word: 0x0002_08c0
    },
    {
      label: 'an opcode outside the course encoding space',
      // opcode 0b011111 is not used by any course instruction.
      word: 0x7c00_0000
    }
  ] as const;

  it('raises RI with ExcCode 10 at the decode stage', () => {
    // Cross-check that the first raw word really is sll before relying on it.
    expect(op('sll', { rd: 1, rt: 2, shamt: 3 })).toBe(0x0002_08c0);

    for (const testCase of cases) {
      const { session, trace } = runP7([testCase.word]);
      const { event, trap } = onlyTrap(trace);
      const label = testCase.label;

      // COURSE-P7-EXC-017: recognition is by opcode / R-type funct against the
      // enabled P7 instruction set; anything else is RI.
      expect(trap.kind, label).toBe('exception');
      expect(trap.name, label).toBe('ri');
      expect(trap.code, label).toBe(excCode.ri);
      expect(trap.stage, label).toBe('decode');
      expect(trap.victimPc, label).toBe(textBase);
      expect(trap.epc, label).toBe(textBase);
      expect(trap.branchDelay, label).toBe(false);

      expect(event.instructionWord, label).toBe(testCase.word);
      expect(event.mnemonic, label).toBeUndefined();
      expect(event.pcAfter, label).toBe(handlerPc);
      expect(event.gprWrites, label).toEqual([]);

      const cp0 = cp0State(session);
      expect(cp0.cause, label).toBe(cause.ri);
      expect(cp0.epc, label).toBe(textBase);
      expect(cp0.status, label).toBe(statusExl);
    }
  });

  it('executes the same word normally once its layer is enabled', () => {
    // The RI above is a statement about the enabled instruction set, not about the
    // encoding: with marsCompatibility enabled, 0x000208c0 is an ordinary sll.
    const words = [
      op('ori', { rs: 0, rt: 2, immediate: 4 }), // $2 = 4
      0x0002_08c0, // sll $1, $2, 3 -> $1 = 32
      ...haltSequence
    ];
    const { session, trace } = runP7(words, {
      layers: ['required', 'commonExtensions', 'marsCompatibility']
    });

    expect(trapEvents(trace)).toEqual([]);
    expect(gprWrites(trace)).toEqual([[2, 4], [1, 32]]);
    expect(trace.last.status).toBe('halted');
    expect(cp0State(session)).toEqual({ status: 0, cause: 0, epc: 0 });
  });
});

describe('P7 syscall exceptions', () => {
  it('raises Syscall with ExcCode 8 at the decode stage', () => {
    // COURSE-P7-EXC-016: syscall only raises the exception and enters the handler.
    const { session, trace } = runP7([op('syscall')]);
    const { event, trap } = onlyTrap(trace);

    expect(trap.kind).toBe('exception');
    expect(trap.name).toBe('syscall');
    expect(trap.code).toBe(excCode.syscall);
    expect(trap.stage).toBe('decode');
    expect(trap.victimPc).toBe(textBase);
    expect(trap.epc).toBe(textBase);
    expect(trap.branchDelay).toBe(false);
    expect(trap.handlerPc).toBe(handlerPc);

    expect(event.mnemonic).toBe('syscall');
    expect(event.instructionWord).toBe(0x0000_000c); // opcode 0, funct 0x0c
    expect(event.pcAfter).toBe(handlerPc);
    expect(event.gprWrites).toEqual([]);

    const cp0 = cp0State(session);
    expect(cp0.cause).toBe(cause.syscall);
    expect(cp0.epc).toBe(textBase);
    expect(cp0.status).toBe(statusExl);
  });
});

describe('P7 delay-slot victims', () => {
  const cases = [
    {
      label: 'taken branch',
      branchTaken: true,
      // beq $0, $0, +4 is always taken; its delay slot at 0x3004 is the victim.
      words: [
        op('beq', { rs: 0, rt: 0, immediate: 4 }),
        op('syscall')
      ],
      branchPc: textBase, // 0x3000
      victimPc: textBase + 0x4 // 0x3004
    },
    {
      label: 'not-taken branch',
      branchTaken: false,
      // $1 = 1 makes beq $0, $1 fall through, but the delay slot still executes.
      words: [
        op('ori', { rs: 0, rt: 1, immediate: 1 }),
        op('beq', { rs: 0, rt: 1, immediate: 4 }),
        op('syscall')
      ],
      branchPc: textBase + 0x4, // 0x3004
      victimPc: textBase + 0x8 // 0x3008
    }
  ] as const;

  it('sets Cause.BD and stores victimPC - 4 in EPC regardless of the branch outcome', () => {
    for (const testCase of cases) {
      const { session, trace } = runP7(testCase.words);
      const { event, trap } = onlyTrap(trace);
      const label = testCase.label;

      const branch = committedEvents(trace).find((item) => item.mnemonic === 'beq')!;
      expect(branch.pcBefore, label).toBe(testCase.branchPc);
      expect(branch.branchTaken, label).toBe(testCase.branchTaken);

      // COURSE-P7-EXC-009: BD = 1 and EPC = victimPC - 4, taken or not.
      expect(trap.name, label).toBe('syscall');
      expect(trap.code, label).toBe(excCode.syscall);
      expect(trap.victimPc, label).toBe(testCase.victimPc);
      expect(trap.branchDelay, label).toBe(true);
      expect(trap.epc, label).toBe(testCase.victimPc - 4);
      expect(trap.epc, label).toBe(testCase.branchPc);

      expect(event.delaySlot, label).toBe(true);
      expect(event.branchOriginPc, label).toBe(testCase.branchPc);
      expect(event.pcAfter, label).toBe(handlerPc);

      const cp0 = cp0State(session);
      // Cause = BD(bit 31) | Syscall(8) << 2 = 0x80000020. The `>>> 0` only undoes
      // JavaScript's signed int32 result for `|`; the derivation is unchanged.
      expect(cp0.cause, label).toBe((causeBranchDelay | cause.syscall) >>> 0);
      expect(cp0.cause, label).toBe(0x8000_0020);
      expect((cp0.cause >>> 31) & 1, label).toBe(1);
      expect(cp0.epc, label).toBe(testCase.branchPc);
      expect(cp0.status, label).toBe(statusExl);
    }
  });
});

describe('P7 eret return contract', () => {
  it('clears EXL, resumes at EPC and never executes the word after eret', () => {
    // COURSE-P7-ERET-001/002: eret jumps but has no delay slot; the test data may put
    // a non-nop instruction right after it, and that instruction must not run.
    const kernelWords = [
      op('mfc0', { rt: 8, rd: 14 }), // 0x4180: $8 = EPC = 0x3000
      op('addiu', { rs: 8, rt: 8, immediate: 4 }), // 0x4184: resume after the syscall
      op('mtc0', { rt: 8, rd: 14 }), // 0x4188: EPC = 0x3004
      op('eret'), // 0x418c: PC = 0x3004, EXL cleared
      op('ori', { rs: 0, rt: 9, immediate: 0x5a5 }) // 0x4190: must never execute
    ];
    const words = [
      op('syscall'), // 0x3000
      op('ori', { rs: 0, rt: 10, immediate: 0x11 }), // 0x3004: the resume point
      ...haltSequence // 0x3008 / 0x300c
    ];

    const { session, trace } = runP7(words, { kernelWords });

    expect(pcSequence(trace)).toEqual([
      0x0000_3000, // syscall -> handler
      0x0000_4180, 0x0000_4184, 0x0000_4188, 0x0000_418c, // mfc0, addiu, mtc0, eret
      0x0000_3004, 0x0000_3008, 0x0000_300c // resumed user code and the halt loop
    ]);
    expect(gprWrites(trace)).toEqual([
      [8, 0x0000_3000], // EPC of the syscall victim
      [8, 0x0000_3004], // advanced past the victim
      [10, 0x11]
    ]);
    // The word after eret is the only source of a $9 write; it must be absent.
    expect(gprWrites(trace).some(([register]) => register === 9)).toBe(false);
    expect(session.snapshot().gpr[9]).toBe(0);

    const eret = committedEvents(trace).find((event) => event.mnemonic === 'eret')!;
    expect(eret.pcAfter).toBe(0x0000_3004);
    expect(eret.delaySlot).toBeUndefined();
    // COURSE-P7-EXC-001: eret clears EXL and touches no other SR bit.
    expect(eret.cp0Writes).toEqual([{ register: 12, valueBefore: statusExl, value: 0 }]);

    const cp0 = cp0State(session);
    expect(cp0.status).toBe(0);
    expect(cp0.epc).toBe(0x0000_3004);
    // Cause keeps the Syscall code: eret does not clear it.
    expect(cp0.cause).toBe(cause.syscall);
    expect(trace.last.status).toBe('halted');
  });
});

describe('P7 handler entry fall-through', () => {
  it('treats sequential execution from 0x417c into 0x4180 as ordinary execution', () => {
    // COURSE-P7-EXC-020: PC = 0x4180 alone proves nothing; only an accepted Req does.
    const kernelBase = 0x0000_4178;
    const kernelWords = [
      op('ori', { rs: 0, rt: 1, immediate: 1 }), // 0x4178
      op('ori', { rs: 0, rt: 2, immediate: 2 }), // 0x417c
      op('ori', { rs: 0, rt: 3, immediate: 3 }), // 0x4180 - reached by fall-through
      ...haltSequence // 0x4184 / 0x4188
    ];
    const words = [
      op('ori', { rs: 0, rt: 4, immediate: kernelBase }),
      op('jr', { rs: 4 }),
      op('nop')
    ];

    const { session, trace } = runP7(words, { kernelWords, kernelBase });

    expect(trapEvents(trace)).toEqual([]);
    expect(trace.events.every((event) => event.kind === 'instruction')).toBe(true);
    expect(pcSequence(trace)).toEqual([
      0x0000_3000, 0x0000_3004, 0x0000_3008,
      0x0000_4178, 0x0000_417c, 0x0000_4180, 0x0000_4184, 0x0000_4188
    ]);
    expect(gprWrites(trace)).toEqual([[4, kernelBase], [1, 1], [2, 2], [3, 3]]);
    // No Req was accepted, so CP0 is still at its reset value.
    expect(cp0State(session)).toEqual({ status: 0, cause: 0, epc: 0 });
    expect(trace.last.status).toBe('halted');
  });
});

describe('P7 CP0 move instructions', () => {
  it('masks SR to its implemented bits while writing EPC in full', () => {
    // COURSE-P7-CP0-001/002 + COURSE-P7-EXC-022: SR implements IM(15:10), EXL(1) and
    // IE(0) = 0xfc03; every other bit reads zero. EPC is a full 32-bit register.
    const words = [
      op('lui', { rt: 1, immediate: 0xffff }),
      op('ori', { rs: 1, rt: 1, immediate: 0xffff }), // $1 = 0xffffffff
      op('mtc0', { rt: 1, rd: 12 }), // SR  <- 0xffffffff
      op('mfc0', { rt: 2, rd: 12 }), // $2  <- SR
      op('mtc0', { rt: 1, rd: 14 }), // EPC <- 0xffffffff
      op('mfc0', { rt: 3, rd: 14 }), // $3  <- EPC
      ...haltSequence
    ];
    const { session, trace } = runP7(words);

    expect(trapEvents(trace)).toEqual([]);
    expect(gprWrites(trace)).toEqual([
      [1, 0xffff_0000],
      [1, 0xffff_ffff],
      [2, 0x0000_fc03], // only IM | EXL | IE survived
      [3, 0xffff_ffff] // EPC keeps all 32 bits
    ]);

    const statusWrite = committedEvents(trace)
      .flatMap((event) => event.cp0Writes)
      .find((write) => write.register === 12)!;
    expect(statusWrite).toEqual({ register: 12, valueBefore: 0, value: 0x0000_fc03 });

    const cp0 = cp0State(session);
    expect(cp0.status).toBe(0x0000_fc03);
    expect(cp0.epc).toBe(0xffff_ffff);
    expect(cp0.cause).toBe(0);
    expect(trace.last.status).toBe('halted');
  });

  it('reads back SR, Cause and EPC written by an accepted exception', () => {
    const kernelWords = [
      op('mfc0', { rt: 4, rd: 12 }), // SR
      op('mfc0', { rt: 5, rd: 13 }), // Cause
      op('mfc0', { rt: 6, rd: 14 }), // EPC
      ...haltSequence
    ];
    const { trace } = runP7([op('syscall')], { kernelWords });

    expect(gprWrites(trace)).toEqual([
      [4, statusExl], // EXL set on entry (COURSE-P7-EXC-001)
      [5, cause.syscall], // ExcCode 8 in bits 6:2 (COURSE-P7-EXC-002)
      [6, textBase] // the syscall victim PC
    ]);
    expect(trace.last.status).toBe('halted');
  });

  it('refuses an mtc0 that targets Cause instead of silently accepting it', () => {
    // COURSE-P7-EXC-022: the official scenarios never write Cause, so Cause is not a
    // writable CP0 register; such an input leaves the comparable domain.
    // Raw word: opcode 0x10 | rs 4 (mtc0) | rt $1 | rd 13.
    const mtc0Cause = ((0x10 << 26) | (4 << 21) | (1 << 16) | (13 << 11)) >>> 0;
    expect(mtc0Cause).toBe(0x4081_6800);

    const session = makeSession('P7', [mtc0Cause], { kernelWords: parkingHandler });
    const trace = runToCompletion(session);

    expect(trace.last.status).toBe('out-of-domain');
    expect(trace.last.diagnostic?.code).toBe('mips-core.exec.unsupported-instruction');
    expect(trace.last.diagnostic?.contractId).toBe('COURSE-P7-CP0-001');
    expect(trace.last.diagnostic?.pc).toBe(textBase);
    // It is not an architectural Req, and Cause never changed.
    expect(trapEvents(trace)).toEqual([]);
    expect(cp0State(session)).toEqual({ status: 0, cause: 0, epc: 0 });
  });
});

describe('P7 same-victim exception stage priority', () => {
  const cases = [
    {
      label: 'a syscall word behind a misaligned PC',
      // Decision vector bad-pc-syscall-word: F:AdEL(4) beats D:Syscall(8).
      bodyWord: op('syscall'),
      losingCode: excCode.syscall
    },
    {
      label: 'a reserved-instruction word behind a misaligned PC',
      // Decision vector bad-pc-illegal-word: F:AdEL(4) beats D:RI(10).
      bodyWord: 0x7c00_0000,
      losingCode: excCode.ri
    }
  ] as const;

  it('keeps the fetch-stage AdEL and never decodes the mis-fetched word', () => {
    // 0x300e is the misaligned PC; the aligned word holding it is at 0x300c.
    const badPc = 0x0000_300e;
    for (const testCase of cases) {
      const words = [
        op('ori', { rs: 0, rt: 1, immediate: badPc }),
        op('jr', { rs: 1 }),
        op('nop'),
        testCase.bodyWord // 0x300c: what a decode would have seen
      ];
      const { session, trace } = runP7(words);
      const { event, trap } = onlyTrap(trace);
      const label = testCase.label;

      // COURSE-P7-EXC-PRIORITY-001: F > D > E > M for one victim.
      expect(trap.stage, label).toBe('fetch');
      expect(trap.name, label).toBe('adel');
      expect(trap.code, label).toBe(excCode.adel);
      expect(trap.code, label).not.toBe(testCase.losingCode);
      expect(trap.victimPc, label).toBe(badPc);
      expect(trap.epc, label).toBe(badPc);
      // Nothing was decoded: no word, no mnemonic, no register or memory effect.
      expect(event.instructionWord, label).toBeUndefined();
      expect(event.mnemonic, label).toBeUndefined();
      expect(event.gprWrites, label).toEqual([]);
      expect(event.memoryWrites, label).toEqual([]);
      expect(cp0State(session).cause, label).toBe(cause.adel);
    }
  });

  it('accepts the older victim when a younger instruction would also fault', () => {
    // Decision vector older-store-before-younger-ri: an M-stage AdES on the older
    // instruction wins over a D-stage RI on the younger one, which never runs.
    const words = [
      op('sw', { rs: 0, rt: 0, immediate: 1 }), // 0x3000: misaligned store -> AdES
      0x7c00_0000 // 0x3004: RI, never reached
    ];
    const { session, trace } = runP7(words);
    const { trap } = onlyTrap(trace);

    expect(trap.name).toBe('ades');
    expect(trap.code).toBe(excCode.ades);
    expect(trap.stage).toBe('memory');
    expect(trap.victimPc).toBe(textBase);
    expect(trap.epc).toBe(textBase);
    expect(cp0State(session).cause).toBe(cause.ades);
    // The younger word never became a victim: exactly one Req in the whole run.
    expect(trapEvents(trace)).toHaveLength(1);
    expect(pcSequence(trace).includes(textBase + 4)).toBe(false);
  });
});
