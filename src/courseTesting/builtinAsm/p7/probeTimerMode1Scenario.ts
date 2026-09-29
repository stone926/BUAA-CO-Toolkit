// @index p7-probe-timer-mode1 — Mode-1 repeat IRQ protocol and stable stopped-state deassertion
import { ProgramWriter } from '../programWriter';
import { P7ProbeScenario } from '../types';
import { Random } from '../../random';
import { BuiltinAsmGeneratorError } from '../randomBody';
import {
  p7CauseIpTimer0Mask, p7CauseIpTimer1Mask,
  p7ProbeFlagRepeatTimerInterrupt, p7ProbeFlagRepeatTimerCaptured,
  p7ProbeFlagRepeatTimerFreshArmed, p7ProbeMaskedInterruptMarkerAddress,
  p7ProbeMode1DeassertMarkerBase, p7ProbeMode1FailureMarker,
  p7ProbePostEretStatusAddress, p7ProbeStateDonePc, p7ProbeStateFlags,
  p7Timer0Ctrl, p7Timer0Count, p7Timer0Preset,
  p7Timer1Ctrl, p7Timer1Count, p7Timer1Preset
} from './constants';
import {
  ProbePaddingProfile, emitDisableInterrupts, emitEnableInterrupts,
  emitLoadImmediate, emitPadding, emitStoreImmediate
} from './probeAsm';
import { scenarioWithLocations } from './probeScenarios';

/** Preserve reload observations, then verify deassertion while the Timer is stopped. */
export function emitTimerMode1RepeatScenario(
  writer: ProgramWriter,
  id: number,
  kind: 'timer0' | 'timer1',
  variant: 'mode1-repeat',
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  const ctrl = kind === 'timer0' ? p7Timer0Ctrl : p7Timer1Ctrl;
  const preset = kind === 'timer0' ? p7Timer0Preset : p7Timer1Preset;
  const count = kind === 'timer0' ? p7Timer0Count : p7Timer1Count;
  const ipMask = kind === 'timer0' ? p7CauseIpTimer0Mask : p7CauseIpTimer1Mask;
  const initialWaitLabel = `_co_probe_s${id}_mode1_initial_wait`;
  const followupLabel = `_co_probe_s${id}_mode1_followup`;
  const pollLabel = `_co_probe_s${id}_mode1_poll`;
  const noReloadLabel = `_co_probe_s${id}_mode1_no_reload`;
  const clearIpLabel = `_co_probe_s${id}_mode1_clear_ip`;
  const freshWaitLabel = `_co_probe_s${id}_mode1_fresh_wait`;
  const doneLabel = `_co_probe_s${id}_done`;
  const badLabel = `_co_probe_s${id}_bad_mode1_period`;
  const badLoopLabel = `_co_probe_s${id}_bad_mode1_period_loop`;
  const afterBadLabel = `_co_probe_s${id}_after_bad_mode1_period`;
  const timerPreset = 32;
  const mode1WithInterrupt = 0xb;
  const mode1StoppedMasked = 0x2;
  const mode1StoppedUnmasked = 0xa;
  const deassertMarker = p7ProbeMode1DeassertMarkerBase | id;

  emitStoreImmediate(writer, p7ProbeFlagRepeatTimerInterrupt, p7ProbeStateFlags);
  emitStoreImmediate(writer, timerPreset, preset);
  emitStoreImmediate(writer, mode1WithInterrupt, ctrl);

  // The first interrupt handler redirects EPC past the initial wait loop.
  const followupPc = writer.pc() + 6 * 4;
  emitStoreImmediate(writer, followupPc, p7ProbeStateDonePc);
  const firstEnableStartPc = writer.pc();
  emitEnableInterrupts(writer);
  const initialWaitPc = writer.pc();
  writer.label(initialWaitLabel);
  writer.emit(`beq $0, $0, ${initialWaitLabel}`);
  writer.emit('nop');
  if (writer.pc() !== followupPc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 Mode-1 scenario ${id} follow-up PC was miscalculated.`);
  }

  writer.label(followupLabel);
  emitDisableInterrupts(writer);
  writer.emit(`lw $10, 0x${count.toString(16)}($0)`);
  writer.emit('ori $11, $0, 0');
  writer.emit('ori $14, $0, 2');
  // These two public COUNT increases witness two reloads when observed. A
  // sampling phase can miss real reloads; the watchdog then means this
  // coverage was not established, not that a fixed Timer period was violated.
  writer.label(pollLabel);
  writer.emit(`lw $12, 0x${count.toString(16)}($0)`);
  writer.emit('nop');
  writer.emit('nop');
  writer.emit('sltu $13, $10, $12');
  writer.emit(`beq $13, $0, ${noReloadLabel}`);
  writer.emit('nop');
  const reloadCommitPc = writer.pc();
  writer.emit('addi $11, $11, 1');
  writer.label(noReloadLabel);
  writer.emit('add $10, $12, $0');
  writer.emit(`bne $11, $14, ${pollLabel}`);
  writer.emit('nop');

  // Stopping CNT before zero leaves COUNT frozen at a nonzero value in the
  // official Timer FSM. Requiring COUNT=0 after CTRL=2 would deadlock a legal
  // device. Instead, prove that COUNT is stable with Enable=0 and that Cause.IP
  // clears while no new counting period can start.
  writer.emit(`ori $14, $0, 0x${mode1StoppedMasked.toString(16)}`);
  writer.emit(`sw $14, 0x${ctrl.toString(16)}($0)`);
  writer.emit(`lw $10, 0x${count.toString(16)}($0)`);
  writer.emit('nop');
  writer.emit('nop');
  writer.emit(`lw $12, 0x${count.toString(16)}($0)`);
  writer.emit(`bne $10, $12, ${badLabel}`);
  writer.emit('nop');

  // Device IM alone is restored; Enable stays zero. Polling Cause.IP is safe
  // without a Timer-cycle bound because a stopped Timer cannot create a new IRQ.
  writer.emit(`ori $14, $0, 0x${mode1StoppedUnmasked.toString(16)}`);
  writer.emit(`sw $14, 0x${ctrl.toString(16)}($0)`);
  writer.label(clearIpLabel);
  writer.emit('mfc0 $15, $13');
  writer.emit(`andi $15, $15, 0x${ipMask.toString(16)}`);
  writer.emit(`bne $15, $0, ${clearIpLabel}`);
  writer.emit('nop');
  // A separate observation must still see zero after the polling exit.
  writer.emit('mfc0 $15, $13');
  const causeMaskPc = writer.pc();
  writer.emit(`andi $15, $15, 0x${ipMask.toString(16)}`);
  writer.emit(`bne $15, $0, ${badLabel}`);
  writer.emit('nop');
  emitLoadImmediate(writer, '$15', deassertMarker);
  const deassertMarkerPc = writer.pc();
  writer.emit(`sw $15, 0x${p7ProbeMaskedInterruptMarkerAddress.toString(16)}($0)`);

  // The second entry is accepted only after this explicit fresh-arm state.
  const completionPc = writer.pc() + 10 * 4;
  emitStoreImmediate(writer, completionPc, p7ProbeStateDonePc);
  emitStoreImmediate(
    writer,
    p7ProbeFlagRepeatTimerInterrupt | p7ProbeFlagRepeatTimerCaptured | p7ProbeFlagRepeatTimerFreshArmed,
    p7ProbeStateFlags
  );
  // This write, after the zero marker and fresh-arm flag, starts a new period.
  writer.emit(`ori $14, $0, 0x${mode1WithInterrupt.toString(16)}`);
  writer.emit(`sw $14, 0x${ctrl.toString(16)}($0)`);
  const freshEnableStartPc = writer.pc();
  emitEnableInterrupts(writer);
  const freshWaitPc = writer.pc();
  writer.label(freshWaitLabel);
  writer.emit(`beq $0, $0, ${freshWaitLabel}`);
  writer.emit('nop');
  if (writer.pc() !== completionPc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 Mode-1 scenario ${id} completion PC was miscalculated.`);
  }

  writer.label(doneLabel);
  writer.emit(`ori $1, $0, ${id}`);
  writer.emit(`beq $0, $0, ${afterBadLabel}`);
  writer.emit('nop');
  writer.label(badLabel);
  emitLoadImmediate(writer, '$15', p7ProbeMode1FailureMarker);
  writer.emit(`sw $15, 0x${p7ProbeMaskedInterruptMarkerAddress.toString(16)}($0)`);
  writer.label(badLoopLabel);
  writer.emit(`beq $0, $0, ${badLoopLabel}`);
  writer.emit('nop');
  writer.label(afterBadLabel);
  emitPadding(writer, rng, padding.postMin, padding.postMax);

  const firstAllowedEpcs = pcRange(firstEnableStartPc, initialWaitPc);
  const freshAllowedEpcs = pcRange(freshEnableStartPc, freshWaitPc);
  return {
    ...scenarioWithLocations(id, kind, freshWaitPc, completionPc),
    variant,
    allowedEpc: freshAllowedEpcs,
    timerPreset,
    requireCompletion: true,
    replayStatusAddress: p7ProbePostEretStatusAddress,
    expectedRecords: [
      {
        expectedIpMask: ipMask,
        allowedIpMasks: [0, ipMask],
        expectedExcCode: 0,
        allowedEpc: firstAllowedEpcs,
        allowedBdEpc: [initialWaitPc]
      },
      {
        expectedIpMask: ipMask,
        allowedIpMasks: [0, ipMask],
        expectedExcCode: 0,
        allowedEpc: freshAllowedEpcs,
        allowedBdEpc: [freshWaitPc]
      }
    ],
    requiredPreHandlerCommits: [
      { pc: reloadCommitPc, kind: 'grf', target: 11, value: 1 },
      { pc: reloadCommitPc, kind: 'grf', target: 11, value: 2 },
      { pc: causeMaskPc, kind: 'grf', target: 15, value: 0 },
      { pc: deassertMarkerPc, kind: 'dm', target: p7ProbeMaskedInterruptMarkerAddress, value: deassertMarker }
    ]
  };
}

function pcRange(startPc: number, endPc: number): number[] {
  const result: number[] = [];
  for (let pc = startPc; pc <= endPc; pc += 4) result.push(pc);
  return result;
}
