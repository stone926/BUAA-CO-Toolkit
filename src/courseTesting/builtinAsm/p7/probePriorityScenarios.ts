// @index course-testing — Deterministic interrupt/exception priority and software-visible Timer synchronization

import { Random } from '../../random';
import { p7RiWordDirective, p7RiWordEntry } from '../../p7RiWords';
import { BuiltinAsmGeneratorError } from '../randomBody';
import { ProgramWriter } from '../programWriter';
import { P7ProbeCommitExpectation, P7ProbeScenario } from '../types';
import {
  p7CauseIpExternalMask,
  p7CauseIpTimer0Mask,
  p7CauseIpTimer1Mask,
  p7ProbeExternalArmAddress,
  p7ProbeFlagResumeInterruptEpc,
  p7ProbeMaskedInterruptMarkerAddress,
  p7ProbePostEretStatusAddress,
  p7ProbeStateDonePc,
  p7ProbeStateFlags,
  p7ProbeTimerCtrlStart,
  p7StatusEnableAllCourseInterrupts,
  p7Timer0Ctrl,
  p7Timer0Preset,
  p7Timer1Ctrl,
  p7Timer1Preset
} from './constants';
import {
  ProbePaddingProfile,
  emitDisableInterrupts,
  emitEnableInterrupts,
  emitLoadImmediate,
  emitPadding,
  emitStoreImmediate
} from './probeAsm';
import { expectedExcCode, scenarioWithLocations } from './probeScenarios';

type PriorityInterruptKind = 'external' | 'timer0' | 'timer1';
type PriorityExceptionKind = 'ri' | 'adel' | 'ades' | 'ov' | 'syscall';

/** ORI/mtc0 for Status and EPC, followed by JAL and its delay slot. */
export const pendingTimerReleaseInstructionCount = 6;

/**
 * Establish a stable Mode-0 request using only Cause.IP. Neither a fixed number
 * of timer ticks nor the location of CP0 in the student's pipeline is assumed.
 * The final store proves that software observed the intended pending source.
 * Clobbers $12/$26; leaves IE disabled and does not modify the scenario flags.
 */
export function emitTimerPendingSetup(
  writer: ProgramWriter,
  id: number,
  kind: 'timer0' | 'timer1'
): { timerPreset: number; requiredPreHandlerCommits: P7ProbeCommitExpectation[] } {
  const ctrl = kind === 'timer0' ? p7Timer0Ctrl : p7Timer1Ctrl;
  const preset = kind === 'timer0' ? p7Timer0Preset : p7Timer1Preset;
  const ipMask = kind === 'timer0' ? p7CauseIpTimer0Mask : p7CauseIpTimer1Mask;
  const timerPreset = 1;
  const pollLabel = `_co_probe_s${id}_pending_timer`;

  emitDisableInterrupts(writer);
  emitStoreImmediate(writer, timerPreset, preset);
  emitStoreImmediate(writer, p7ProbeTimerCtrlStart, ctrl);
  writer.label(pollLabel);
  writer.emit('mfc0 $12, $13');
  writer.emit(`andi $12, $12, 0x${ipMask.toString(16)}`);
  writer.emit(`beq $12, $0, ${pollLabel}`);
  writer.emit('nop');
  const pendingMarkerPc = writer.pc();
  writer.emit(`sw $12, 0x${p7ProbeMaskedInterruptMarkerAddress.toString(16)}($0)`);
  return {
    timerPreset,
    requiredPreHandlerCommits: [{
      pc: pendingMarkerPc,
      kind: 'dm',
      target: p7ProbeMaskedInterruptMarkerAddress,
      value: ipMask
    }]
  };
}

/**
 * Enter the handler's dedicated eret trampoline with EXL set. Eret atomically
 * clears EXL and returns to resumePc, so the pending timer first becomes eligible
 * at that instruction, regardless of mtc0 hazards or the pipeline's CP0 stage.
 */
export function emitPendingTimerRelease(writer: ProgramWriter, resumePc: number): void {
  emitLoadImmediate(writer, '$26', p7StatusEnableAllCourseInterrupts | 2);
  writer.emit('mtc0 $26, $12');
  emitLoadImmediate(writer, '$26', resumePc);
  writer.emit('mtc0 $26, $14');
  writer.emit('jal _co_probe_priority_release');
  writer.emit('nop');
}

export function emitInterruptPriorityScenario(
  writer: ProgramWriter,
  id: number,
  kind: PriorityInterruptKind,
  variant: string,
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  const { exceptionKind, delaySlot, taken } = parsePriorityVariant(variant);
  const doneLabel = `_co_probe_s${id}_done`;
  if (exceptionKind === 'ov') {
    emitLoadImmediate(writer, '$8', 0x7fffffff);
  }
  emitStoreImmediate(writer, p7ProbeFlagResumeInterruptEpc, p7ProbeStateFlags);

  const timerSetup = kind === 'external' ? undefined : emitTimerPendingSetup(writer, id, kind);
  const triggerInstructionCount = kind === 'external' ? 4 : pendingTimerReleaseInstructionCount;
  const entryPc = writer.pc() + (2 + triggerInstructionCount) * 4;
  const victimPc = entryPc + (delaySlot ? 4 : 0);
  const donePc = victimPc + 4;
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  if (kind === 'external') {
    emitStoreImmediate(writer, id, p7ProbeExternalArmAddress);
    emitEnableInterrupts(writer);
  } else {
    emitPendingTimerRelease(writer, entryPc);
  }
  if (delaySlot) {
    writer.emit(`${taken ? 'beq' : 'bne'} $0, $0, ${doneLabel}`);
  }
  writer.emit(priorityVictimInstruction(exceptionKind));
  if (writer.pc() !== donePc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 priority probe scenario ${id} return PC was miscalculated.`);
  }
  writer.label(doneLabel);
  writer.emit(`ori $1, $0, ${id}`);
  emitPadding(writer, rng, padding.postMin, padding.postMax);

  const ipMask = kind === 'external'
    ? p7CauseIpExternalMask
    : kind === 'timer0' ? p7CauseIpTimer0Mask : p7CauseIpTimer1Mask;
  // External requests are tied to the exact macroscopic victim PC. The timer
  // delay variants instead interrupt the branch on eret, then test BD on retry;
  // all five direct variants place the fault itself at the release point.
  const interruptBd = kind === 'external' && delaySlot;
  return {
    ...scenarioWithLocations(id, kind, entryPc, donePc),
    expectedBd: interruptBd,
    allowedEpc: [entryPc],
    variant,
    victimPc,
    replayStatusAddress: p7ProbePostEretStatusAddress,
    ...(kind === 'external' ? {
      triggerPc: victimPc,
      waitPc: victimPc,
      armAddress: p7ProbeExternalArmAddress,
      armValue: id,
      externalDelayCycles: 0
    } : timerSetup),
    expectedRecords: [
      { expectedIpMask: ipMask, expectedExcCode: 0, expectedBd: interruptBd, allowedEpc: [entryPc] },
      { expectedIpMask: 0, expectedExcCode: expectedExcCode(exceptionKind), expectedBd: delaySlot, allowedEpc: [entryPc] }
    ],
    requireCompletion: true
  };
}

function parsePriorityVariant(variant: string): {
  exceptionKind: PriorityExceptionKind;
  delaySlot: boolean;
  taken: boolean;
} {
  const match = /^priority-(ri|adel|ades|ov|syscall)(?:-delay-(taken|not-taken))?$/.exec(variant);
  if (!match) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: unsupported P7 priority probe variant ${variant}.`);
  }
  return {
    exceptionKind: match[1] as PriorityExceptionKind,
    delaySlot: match[2] !== undefined,
    taken: match[2] === 'taken'
  };
}

function priorityVictimInstruction(kind: PriorityExceptionKind): string {
  switch (kind) {
    case 'ri': return p7RiWordDirective(p7RiWordEntry(undefined)!);
    case 'adel': return 'lw $8, 1($0)';
    case 'ades': return 'sw $8, 1($0)';
    case 'ov': return 'addi $9, $8, 1';
    case 'syscall': return 'syscall';
  }
}
