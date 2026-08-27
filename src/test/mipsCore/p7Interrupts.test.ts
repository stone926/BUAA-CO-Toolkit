import { describe, expect, it } from 'vitest';
import { CommitEvent, StepResult } from '../../mips/core/events/commitEvent';
import {
  aggregateHardwareInterrupts,
  InterruptGeneratorDevice
} from '../../mips/core/devices/interruptController';
import { CourseTimerDevice, timerRegisterIndex } from '../../mips/core/devices/timer';
import { Cp0Registers } from '../../mips/core/machine/state';
import { CourseSystemSession } from '../../mips/core/machine/system';
import { courseExceptionCodes } from '../../mips/core/profiles/profile';
import { resolveCourseProfile } from '../../mips/core/profiles/courseProfiles';
import {
  gprWrites,
  haltSequence,
  makeSession,
  op,
  runToCompletion
} from './programFixtures';

/**
 * P7 interrupt acceptance, trap priority and the external interrupt generator.
 *
 * Every expected value is transcribed from the course contract, never read back
 * from the executor:
 *
 * - Acceptance requires `IE = 1 && EXL = 0 && (IM & HWInt) != 0` (P7-2-3/P7-2-6);
 *   an interrupt beats any architectural exception raised by the same victim.
 * - CP0 layout: SR(12) IM = 15:10, EXL = bit 1, IE = bit 0; Cause(13) BD = bit 31,
 *   IP = 15:10, ExcCode = 6:2; EPC(14). Handler entry is 0x0000_4180.
 * - `Cause.ExcCode` for Int is 0; Ov is 12 (P7-2-3 异常码表).
 * - A delay-slot victim sets `Cause.BD = 1` and `EPC = victimPc - 4`, taken or not.
 * - `eret` clears EXL and resumes at EPC with no delay slot, so the victim of a
 *   trap re-executes.
 * - HWInt wiring: Timer0 -> bit 0, Timer1 -> bit 1, interrupt generator -> bit 2
 *   (P7-2-6 中断规范); the generator lives at 0x7F20..0x7F23, reads as zero and is
 *   acknowledged by any store to it (the official corpus uses `sb $0, 0x7f20($0)`).
 * - The official testbench skips its macroscopic PC comparison while a request is
 *   still pending, so a retried victim cannot consume a second schedule entry.
 */

const p7 = resolveCourseProfile('P7');
const p7Cp0 = p7.exceptions!.cp0;

/** SR.IE (bit 0) and SR.EXL (bit 1). */
const srIe = 0x0000_0001;
const srExl = 0x0000_0002;

/** SR.IM / Cause.IP occupy 15:10, so HWInt line `n` is masked by SR bit `10 + n`. */
function imBit(line: number): number {
  return 1 << (10 + line);
}

/** Handler entry frozen by P7-2-6. */
const handlerPc = 0x0000_4180;

/** `ori $1, $0, status` + `mtc0 $1, $12` — installs `status` into CP0 SR. */
function installStatus(status: number): readonly number[] {
  return [
    op('ori', { rs: 0, rt: 1, immediate: status }),
    op('mtc0', { rt: 1, rd: 12 })
  ];
}

function stepTimes(session: CourseSystemSession, count: number): StepResult[] {
  const results: StepResult[] = [];
  for (let index = 0; index < count; index++) {
    results.push(session.stepInstruction());
  }
  return results;
}

/** The commit event of a step that must have produced one. */
function eventOf(result: StepResult): CommitEvent {
  expect(result.event).toBeDefined();
  return result.event!;
}

function excCodeOf(cause: number): number {
  return (cause & p7Cp0.causeExceptionCodeBits) >>> p7Cp0.causeExceptionCodeShift;
}

/**
 * Drive one course timer until IRQ is asserted. Per `P7_standard_timer_2019.v` a
 * bus write consumes a clock edge (`else if(WE)` suppresses the state machine),
 * then the machine walks IDLE -> LOAD -> CNT -> INT; `IRQ = ctrl[3] & _IRQ`.
 */
function timerAtIrq(id: 'timer0' | 'timer1'): CourseTimerDevice {
  const timer = new CourseTimerDevice(id);
  timer.write(timerRegisterIndex.preset, 1);
  timer.write(timerRegisterIndex.ctrl, 0b1001); // IM | Mode 0 | Enable
  for (let edge = 0; edge < 5; edge++) {
    timer.tick();
  }
  return timer;
}

/** An interrupt generator holding an asserted request. */
function assertedGenerator(): InterruptGeneratorDevice {
  const generator = new InterruptGeneratorDevice([{ victimPc: 0x0000_3000, occurrence: 1 }]);
  generator.observeMacroPc(0x0000_3000);
  return generator;
}

describe('P7 interrupt acceptance predicate', () => {
  it('accepts a request only when IE is set, EXL is clear and the line is unmasked', () => {
    // P7-2-3/P7-2-6: 中断被接受当且仅当 IE=1 且 EXL=0 且 (IM & HWInt) != 0.
    const hardwareInterrupts = 0b000001; // Timer0 drives HWInt bit 0.
    const covering = 0b000001;           // IM bit 0 covers HWInt bit 0.
    const nonCovering = 0b000010;        // IM bit 1 only: HWInt bit 0 stays masked.
    let accepted = 0;
    for (const ie of [false, true]) {
      for (const exl of [false, true]) {
        for (const unmasked of [false, true]) {
          const mask = unmasked ? covering : nonCovering;
          const status = (mask << 10) | (exl ? srExl : 0) | (ie ? srIe : 0);
          const cp0 = new Cp0Registers(p7Cp0, { status, cause: 0, epc: 0 });
          const label = `IE=${ie ? 1 : 0} EXL=${exl ? 1 : 0} masked=${unmasked ? 1 : 0}`;
          const expected = ie && !exl && unmasked;
          expect(cp0.interruptRequested(hardwareInterrupts), label).toBe(expected);
          if (expected) {
            accepted++;
          }
        }
      }
    }
    // Exactly one of the eight rows may accept.
    expect(accepted).toBe(1);
  });

  it('refuses every request when no hardware line is asserted', () => {
    const cp0 = new Cp0Registers(p7Cp0, { status: (0b111111 << 10) | srIe, cause: 0, epc: 0 });
    expect(cp0.interruptRequested(0)).toBe(false);
    // SR.IM is six bits wide (15:10), so nothing above HWInt bit 5 can request.
    expect(cp0.interruptRequested(1 << 6)).toBe(false);
    for (let line = 0; line < 6; line++) {
      expect(cp0.interruptRequested(1 << line), `HWInt line ${line}`).toBe(true);
    }
  });

  it('reads back IE, EXL and IM from the frozen SR bit positions', () => {
    const cp0 = new Cp0Registers(p7Cp0, {
      status: (0b101010 << 10) | srExl | srIe,
      cause: 0,
      epc: 0
    });
    expect(cp0.interruptEnable).toBe(true);
    expect(cp0.exceptionLevel).toBe(true);
    expect(cp0.interruptMask()).toBe(0b101010);
  });
});

describe('P7 Cause.IP mirroring', () => {
  it('places HWInt at Cause bits 15:10 and reads the same value back', () => {
    const cp0 = new Cp0Registers(p7Cp0, { status: 0, cause: 0, epc: 0 });
    cp0.setInterruptPending(0b101010);
    // IP = 15:10, so 0b101010 lands at 0b101010 << 10 = 0x0000_a800.
    expect(cp0.cause).toBe(0x0000_a800);
    expect(cp0.interruptPending()).toBe(0b101010);

    cp0.setInterruptPending(0);
    expect(cp0.cause).toBe(0);
    expect(cp0.interruptPending()).toBe(0);

    // Only six HWInt lines exist; anything above bit 5 has no IP bit to occupy.
    cp0.setInterruptPending(1 << 6);
    expect(cp0.cause).toBe(0);
    expect(cp0.interruptPending()).toBe(0);
  });

  it('leaves Cause.BD and Cause.ExcCode untouched while refreshing IP', () => {
    const cp0 = new Cp0Registers(p7Cp0, { status: 0, cause: 0, epc: 0 });
    // A delay-slot Ov: BD = 1 and ExcCode = 12 (P7-2-3 异常码表).
    cp0.enterTrap({ code: courseExceptionCodes.ov, branchDelay: true, epc: 0x0000_3000 });
    expect(cp0.cause >>> 31).toBe(1);
    expect(excCodeOf(cp0.cause)).toBe(12);

    cp0.setInterruptPending(0b000100);
    // BD(31) | IP(0b000100 << 10) | ExcCode(12 << 2).
    expect(cp0.cause).toBe(0x8000_1030);
    expect(cp0.cause >>> 31).toBe(1);
    expect(excCodeOf(cp0.cause)).toBe(12);
    expect(cp0.interruptPending()).toBe(0b000100);
  });
});

describe('P7 interrupt commit behaviour', () => {
  it('overwrites a stale Ov code with Int and leaves the victim without any write', () => {
    //  0x3000 ori  $1, $0, IM0|IE      0x4180 ori  $5, $0, 0x3014
    //  0x3004 mtc0 $1, $12             0x4184 mtc0 $5, $14   (EPC <- 0x3014)
    //  0x3008 lui  $2, 0x7fff          0x4188 eret
    //  0x300c ori  $2, $2, 0xffff
    //  0x3010 add  $3, $2, $2   <- Ov, leaves Cause.ExcCode = 12
    //  0x3014 ori  $4, $0, 0x1234  <- interrupt victim
    const words = [
      ...installStatus(imBit(0) | srIe),
      op('lui', { rt: 2, immediate: 0x7fff }),
      op('ori', { rs: 2, rt: 2, immediate: 0xffff }),
      op('add', { rd: 3, rs: 2, rt: 2 }),
      op('ori', { rs: 0, rt: 4, immediate: 0x1234 }),
      ...haltSequence
    ];
    const kernelWords = [
      op('ori', { rs: 0, rt: 5, immediate: 0x3014 }),
      op('mtc0', { rt: 5, rd: 14 }),
      op('eret')
    ];
    const session = makeSession('P7', words, { kernelWords });

    const overflow = eventOf(stepTimes(session, 5).at(-1)!);
    expect(overflow.kind).toBe('exception');
    expect(overflow.trap!.code).toBe(courseExceptionCodes.ov); // 12
    expect(excCodeOf(session.snapshot().cp0!.cause)).toBe(12);

    // Handler patches EPC to the next instruction and returns.
    stepTimes(session, 3);
    expect(session.snapshot().pc).toBe(0x0000_3014);
    expect(session.snapshot().cp0!.status & srExl).toBe(0); // eret cleared EXL
    expect(excCodeOf(session.snapshot().cp0!.cause)).toBe(12); // Ov code still parked

    const result = session.stepInstruction({ hardwareInterrupts: 0b001 });
    const event = eventOf(result);
    expect(event.kind).toBe('interrupt');
    expect(event.trap!.kind).toBe('interrupt');
    expect(event.trap!.name).toBe('int');
    expect(event.trap!.code).toBe(courseExceptionCodes.int); // Int is ExcCode 0
    expect(event.trap!.hardwareInterrupts).toBe(0b001);
    expect(event.trap!.victimPc).toBe(0x0000_3014);
    expect(event.trap!.branchDelay).toBe(false);
    expect(event.trap!.epc).toBe(0x0000_3014); // macroscopic victim PC
    expect(event.trap!.handlerPc).toBe(handlerPc);
    expect(event.pcBefore).toBe(0x0000_3014);
    expect(event.pcAfter).toBe(handlerPc);

    // The Ov code is overwritten, not merged.
    const after = session.snapshot();
    expect(excCodeOf(after.cp0!.cause)).toBe(0);
    expect(after.cp0!.cause >>> 31).toBe(0); // BD cleared for a non-delay victim
    expect(after.cp0!.cause & p7Cp0.causeInterruptPendingBits).toBe(imBit(0)); // IP mirrors HWInt
    expect(after.cp0!.epc).toBe(0x0000_3014);
    expect(after.cp0!.status & srExl).toBe(srExl);
    expect(after.pc).toBe(handlerPc);

    // The victim contributed no architectural side effect at all.
    expect(event.gprWrites).toEqual([]);
    expect(event.hiLoWrites).toEqual([]);
    expect(event.memoryWrites).toEqual([]);
    expect(after.gpr[4]).toBe(0);
  });

  it('prefers the interrupt over an Ov raised by the same victim and re-runs it after eret', () => {
    //  0x3010 add $3, $2, $2 would raise Ov; an eligible interrupt arrives on the
    //  same instruction, so Int (code 0) wins (P7-2-6: 中断优先于同一受害指令的异常).
    const words = [
      ...installStatus(imBit(0) | srIe),
      op('lui', { rt: 2, immediate: 0x7fff }),
      op('ori', { rs: 2, rt: 2, immediate: 0xffff }),
      op('add', { rd: 3, rs: 2, rt: 2 }),
      ...haltSequence
    ];
    const session = makeSession('P7', words, { kernelWords: [op('eret')] });

    stepTimes(session, 4);
    const interrupt = eventOf(session.stepInstruction({ hardwareInterrupts: 0b001 }));
    expect(interrupt.kind).toBe('interrupt');
    expect(interrupt.trap!.name).toBe('int');
    expect(interrupt.trap!.code).toBe(courseExceptionCodes.int); // 0, not 12
    expect(interrupt.trap!.stage).toBeUndefined(); // interrupts arbitrate at commit
    expect(interrupt.trap!.victimPc).toBe(0x0000_3010);
    expect(interrupt.trap!.epc).toBe(0x0000_3010);
    expect(interrupt.gprWrites).toEqual([]);
    expect(session.snapshot().gpr[3]).toBe(0);

    // eret clears EXL and resumes at EPC with no delay slot.
    const eret = eventOf(session.stepInstruction());
    expect(eret.pcBefore).toBe(handlerPc);
    expect(eret.pcAfter).toBe(0x0000_3010);
    expect(session.snapshot().cp0!.status & srExl).toBe(0);

    // The victim re-executes and now takes its own Ov.
    const overflow = eventOf(session.stepInstruction());
    expect(overflow.kind).toBe('exception');
    expect(overflow.trap!.name).toBe('ov');
    expect(overflow.trap!.code).toBe(courseExceptionCodes.ov); // 12
    expect(overflow.trap!.stage).toBe('execute');
    expect(overflow.trap!.victimPc).toBe(0x0000_3010);
    expect(overflow.trap!.epc).toBe(0x0000_3010);
    expect(session.snapshot().gpr[3]).toBe(0);
  });

  it('marks BD and backs EPC up to the branch for a delay-slot victim', () => {
    // COURSE-P7-EXC-BD: 延迟槽受害指令 Cause.BD = 1 且 EPC = victimPc - 4，
    // 与分支是否成立无关。
    const cases = [
      { label: 'taken branch', branch: op('beq', { rs: 0, rt: 0, immediate: 2 }) },
      { label: 'not-taken branch', branch: op('bne', { rs: 0, rt: 0, immediate: 2 }) }
    ];
    for (const { label, branch } of cases) {
      const words = [
        ...installStatus(imBit(0) | srIe),
        branch,                                        // 0x3008
        op('ori', { rs: 0, rt: 4, immediate: 7 }),     // 0x300c delay slot, the victim
        op('ori', { rs: 0, rt: 5, immediate: 9 }),     // 0x3010
        ...haltSequence                                // 0x3014, 0x3018
      ];
      const session = makeSession('P7', words, { kernelWords: [op('eret')] });
      stepTimes(session, 3);
      expect(session.snapshot().pendingBranch, label).toEqual({
        targetPc: label === 'taken branch' ? 0x0000_3014 : 0x0000_3010,
        originPc: 0x0000_3008
      });

      const event = eventOf(session.stepInstruction({ hardwareInterrupts: 0b001 }));
      expect(event.kind, label).toBe('interrupt');
      expect(event.trap!.name, label).toBe('int');
      expect(event.trap!.branchDelay, label).toBe(true);
      expect(event.trap!.victimPc, label).toBe(0x0000_300c);
      expect(event.trap!.epc, label).toBe(0x0000_3008); // victimPc - 4
      expect(event.delaySlot, label).toBe(true);
      expect(event.branchOriginPc, label).toBe(0x0000_3008);
      expect(event.pcAfter, label).toBe(handlerPc);
      expect(event.gprWrites, label).toEqual([]);

      const after = session.snapshot();
      expect(after.cp0!.cause >>> 31, label).toBe(1); // Cause.BD
      expect(excCodeOf(after.cp0!.cause), label).toBe(0);
      expect(after.cp0!.epc, label).toBe(0x0000_3008);
      expect(after.pc, label).toBe(handlerPc);
      // The handler starts outside any delay slot.
      expect(after.pendingBranch, label).toBeUndefined();
      expect(after.gpr[4], label).toBe(0);
    }
  });

  it('commits the instruction normally when the request is masked, disabled or nested', () => {
    const cases = [
      // IM covers HWInt line 1 only, so the asserted line 0 stays masked.
      { label: 'IM clears the asserted line', status: imBit(1) | srIe },
      { label: 'IE = 0', status: imBit(0) },
      { label: 'EXL = 1', status: imBit(0) | srExl | srIe }
    ];
    for (const { label, status } of cases) {
      const words = [
        ...installStatus(status),
        op('ori', { rs: 0, rt: 4, immediate: 0x1234 }), // 0x3008
        ...haltSequence
      ];
      const session = makeSession('P7', words, { kernelWords: [op('eret')] });
      stepTimes(session, 2);
      expect(session.snapshot().cp0!.status, label).toBe(status);

      const result = session.stepInstruction({ hardwareInterrupts: 0b001 });
      const event = eventOf(result);
      expect(result.status, label).toBe('committed');
      expect(event.kind, label).toBe('instruction');
      expect(event.trap, label).toBeUndefined();
      expect(event.gprWrites, label).toEqual([{ register: 4, value: 0x1234 }]);
      expect(event.pcBefore, label).toBe(0x0000_3008);
      expect(event.pcAfter, label).toBe(0x0000_300c);

      const after = session.snapshot();
      expect(after.pc, label).toBe(0x0000_300c);
      expect(after.gpr[4], label).toBe(0x1234);
      // Cause.IP mirrors HWInt every cycle even when the request is not accepted.
      expect(after.cp0!.cause & p7Cp0.causeInterruptPendingBits, label).toBe(imBit(0));
      expect(after.cp0!.epc, label).toBe(0);
    }
  });
});

describe('P7 external interrupt generator', () => {
  //  0x3000 ori  $1, $0, IM2|IE     0x4180 lw  $6, 0x7f20($0)   IG reads as zero
  //  0x3004 mtc0 $1, $12            0x4184 sb  $0, 0x7f20($0)   acknowledge
  //  0x3008 nop                     0x4188 eret
  //  0x300c nop
  //  0x3010 ori  $4, $0, 0x1234  <- scheduled victim
  const generatorProgram = [
    ...installStatus(imBit(2) | srIe),
    op('nop'),
    op('nop'),
    op('ori', { rs: 0, rt: 4, immediate: 0x1234 }),
    ...haltSequence
  ];
  const generatorHandler = [
    op('lw', { rs: 0, rt: 6, immediate: 0x7f20 }),
    op('sb', { rs: 0, rt: 0, immediate: 0x7f20 }),
    op('eret')
  ];

  it('fires on the scheduled victim PC and holds the request until the 0x7f20 store', () => {
    const session = makeSession('P7', generatorProgram, {
      kernelWords: generatorHandler,
      externalInterrupts: [{ victimPc: 0x0000_3010, occurrence: 1 }],
      deviceSchedule: { kind: 'timeline', entries: [] }
    });

    stepTimes(session, 4);
    expect(session.snapshot().devices!.externalInterrupt).toBe(false);
    expect(session.snapshot().devices!.hardwareInterrupts).toBe(0);

    const interrupt = eventOf(session.stepInstruction());
    expect(interrupt.kind).toBe('interrupt');
    expect(interrupt.trap!.name).toBe('int');
    expect(interrupt.trap!.code).toBe(courseExceptionCodes.int);
    // The generator drives HWInt bit 2 (P7-2-6 中断规范).
    expect(interrupt.trap!.hardwareInterrupts).toBe(0b100);
    expect(interrupt.trap!.victimPc).toBe(0x0000_3010);
    expect(interrupt.trap!.epc).toBe(0x0000_3010);
    expect(interrupt.pcAfter).toBe(handlerPc);
    expect(interrupt.gprWrites).toEqual([]);
    expect(interrupt.deviceEvents).toEqual([{
      kind: 'external-interrupt-asserted',
      device: 'interrupt-generator',
      address: 0x0000_3010,
      value: 1
    }]);
    expect(session.snapshot().devices!.externalInterrupt).toBe(true);
    expect(session.snapshot().devices!.hardwareInterrupts).toBe(0b100);
    expect(session.snapshot().cp0!.cause & p7Cp0.causeInterruptPendingBits).toBe(imBit(2));

    // The generator has no storage: a read returns zero even while asserted.
    const read = eventOf(session.stepInstruction());
    expect(read.gprWrites).toEqual([{ register: 6, value: 0 }]);
    expect(read.memoryReads![0]).toMatchObject({
      address: 0x0000_7f20,
      region: 'interrupt-generator',
      wordValue: 0,
      value: 0
    });
    expect(read.deviceEvents).toEqual([]);
    // Still asserted: only a store to 0x7f20 clears it.
    expect(session.snapshot().devices!.externalInterrupt).toBe(true);

    const acknowledge = eventOf(session.stepInstruction());
    expect(acknowledge.memoryWrites[0]).toMatchObject({
      address: 0x0000_7f20,
      wordAddress: 0x0000_7f20,
      region: 'interrupt-generator'
    });
    expect(acknowledge.deviceEvents).toEqual([{
      kind: 'interrupt-generator-ack',
      device: 'interrupt-generator',
      address: 0x0000_7f20,
      value: 1
    }]);
    expect(session.snapshot().devices!.externalInterrupt).toBe(false);
    expect(session.snapshot().devices!.hardwareInterrupts).toBe(0);

    // eret resumes the victim, which now commits.
    const eret = eventOf(session.stepInstruction());
    expect(eret.pcAfter).toBe(0x0000_3010);
    const victim = eventOf(session.stepInstruction());
    expect(victim.kind).toBe('instruction');
    expect(victim.pcBefore).toBe(0x0000_3010);
    expect(victim.gprWrites).toEqual([{ register: 4, value: 0x1234 }]);

    const trace = runToCompletion(session);
    expect(trace.last.status).toBe('halted');
    expect(session.snapshot().devices!.externalInterrupt).toBe(false);
  });

  it('skips the PC comparison while a request is pending so a retried victim consumes no second entry', () => {
    // The handler deliberately does not acknowledge, so `eret` returns to the same
    // victim while the request is still asserted. The official tb does not compare
    // the macroscopic PC while `interrupt` is high, so the second schedule entry
    // for 0x3010 (occurrence 2) can never be reached.
    const session = makeSession('P7', generatorProgram, {
      kernelWords: [op('eret')],
      externalInterrupts: [
        { victimPc: 0x0000_3010, occurrence: 1 },
        { victimPc: 0x0000_3010, occurrence: 2 }
      ],
      deviceSchedule: { kind: 'timeline', entries: [] },
      maxSteps: 20
    });
    const trace = runToCompletion(session);

    const asserted = trace.events
      .flatMap((event) => event.deviceEvents)
      .filter((event) => event.kind === 'external-interrupt-asserted');
    expect(asserted).toEqual([{
      kind: 'external-interrupt-asserted',
      device: 'interrupt-generator',
      address: 0x0000_3010,
      value: 1
    }]);

    const interrupts = trace.events.filter((event) => event.kind === 'interrupt');
    // One pending request keeps re-victimising 0x3010 after every eret.
    expect(interrupts.length).toBeGreaterThan(1);
    for (const [index, event] of interrupts.entries()) {
      const label = `interrupt #${index}`;
      expect(event.trap!.victimPc, label).toBe(0x0000_3010);
      expect(event.trap!.epc, label).toBe(0x0000_3010);
      expect(event.trap!.hardwareInterrupts, label).toBe(0b100);
      expect(event.gprWrites, label).toEqual([]);
    }
    // The victim never committed, so its write never appears.
    expect(gprWrites(trace).filter(([register]) => register === 4)).toEqual([]);
    expect(trace.last.status).toBe('step-limit');
    expect(session.snapshot().devices!.externalInterrupt).toBe(true);
  });

  it('maps timer0 to bit 0, timer1 to bit 1 and the generator to bit 2', () => {
    const { wiring } = p7.exceptions!;
    const timer0 = timerAtIrq('timer0');
    const timer1 = timerAtIrq('timer1');
    const generator = assertedGenerator();
    expect(timer0.irq).toBe(true);
    expect(timer1.irq).toBe(true);
    expect(generator.irq).toBe(true);

    expect(aggregateHardwareInterrupts(wiring, {})).toBe(0);
    expect(aggregateHardwareInterrupts(wiring, { timer0 })).toBe(0b001);
    expect(aggregateHardwareInterrupts(wiring, { timer1 })).toBe(0b010);
    expect(aggregateHardwareInterrupts(wiring, { interruptGenerator: generator })).toBe(0b100);
    expect(aggregateHardwareInterrupts(wiring, { timer0, timer1, interruptGenerator: generator }))
      .toBe(0b111);
    // A quiet device drives nothing; bits 3..5 exist in IM/IP but have no source.
    expect(aggregateHardwareInterrupts(wiring, {
      timer0: new CourseTimerDevice('timer0'),
      timer1: new CourseTimerDevice('timer1'),
      interruptGenerator: new InterruptGeneratorDevice([])
    })).toBe(0);
  });

  it('returns zero from every generator read and reports the acknowledged state', () => {
    // P7-2-6: IG 没有存储单元，读恒为 0，写只用于应答。
    const generator = new InterruptGeneratorDevice([{ victimPc: 0x0000_3010, occurrence: 1 }]);
    expect(generator.read()).toBe(0);
    expect(generator.irq).toBe(false);

    expect(generator.observeMacroPc(0x0000_3010)).toEqual([{
      kind: 'external-interrupt-asserted',
      device: 'interrupt-generator',
      address: 0x0000_3010,
      value: 1
    }]);
    expect(generator.irq).toBe(true);
    expect(generator.read()).toBe(0);

    expect(generator.acknowledge(0x0000_7f20)).toEqual([{
      kind: 'interrupt-generator-ack',
      device: 'interrupt-generator',
      address: 0x0000_7f20,
      value: 1
    }]);
    expect(generator.irq).toBe(false);
    // A redundant acknowledge reports that nothing was pending.
    expect(generator.acknowledge(0x0000_7f20)[0].value).toBe(0);
  });
});
