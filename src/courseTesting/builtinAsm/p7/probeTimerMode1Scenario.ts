// @index p7-probe-timer-mode1 — Two natural IRQs and stable stopped-state observations
import { ProgramWriter } from '../programWriter';
import { P7ProbeCommitExpectation, P7ProbeScenario, P7ProbeTimerObservation } from '../types';
import { Random } from '../../random';
import { BuiltinAsmGeneratorError } from '../randomBody';
import {
  p7CauseIpTimer0Mask, p7CauseIpTimer1Mask, p7StatusEnableAllCourseInterrupts,
  p7ProbeFlagRepeatTimerInterrupt, p7ProbeFlagRepeatTimerCaptured,
  p7ProbeFlagRepeatTimerFreshArmed, p7ProbeMaskedInterruptMarkerAddress,
  p7ProbeMode1DeassertMarkerBase, p7ProbeMode1UnobservedMarkerBase,
  p7ProbePostEretStatusAddress, p7ProbeStateDonePc, p7ProbeStateFlags,
  p7Timer0Ctrl, p7Timer0Count, p7Timer0Preset,
  p7Timer1Ctrl, p7Timer1Count, p7Timer1Preset
} from './constants';
import {
  ProbePaddingProfile, emitEnableInterrupts, emitLoadImmediate, emitPadding, emitStoreImmediate
} from './probeAsm';
import { scenarioWithLocations } from './probeScenarios';

export function emitTimerMode1RepeatScenario(
  writer: ProgramWriter,
  id: number,
  kind: 'timer0' | 'timer1',
  variant: 'mode1-repeat' | 'mode1-stopped',
  rng: Random,
  padding: ProbePaddingProfile,
  firstCapture: Extract<P7ProbeTimerObservation, { kind: 'mode1' }>['firstCapture']
): P7ProbeScenario {
  const ctrl = kind === 'timer0' ? p7Timer0Ctrl : p7Timer1Ctrl;
  const preset = kind === 'timer0' ? p7Timer0Preset : p7Timer1Preset;
  const count = kind === 'timer0' ? p7Timer0Count : p7Timer1Count;
  const ipMask = kind === 'timer0' ? p7CauseIpTimer0Mask : p7CauseIpTimer1Mask;
  const timerPreset = 32;
  const mode1Enabled = 0xb;
  const mode1Stopped = 0xa;
  const stopped = variant === 'mode1-stopped';
  const label = (name: string) => `_co_probe_s${id}_${name}`;
  const requiredPreHandlerCommits: P7ProbeCommitExpectation[] = [];

  emitStoreImmediate(writer, p7ProbeFlagRepeatTimerInterrupt, p7ProbeStateFlags);
  emitStoreImmediate(writer, timerPreset, preset);
  emitStoreImmediate(writer, mode1Enabled, ctrl);
  const initialWaitPc = emitInterruptWait(label('mode1_initial_wait'));

  // The first handler leaves the peripheral untouched and clears CPU IE under EXL.
  // Both COUNT and live Cause.IP can now be observed without taking an interrupt.
  expectRegister('mfc0 $14, $12', 14, p7StatusEnableAllCourseInterrupts & ~1);
  expectRegister(`lw $14, 0x${ctrl.toString(16)}($0)`, 14, mode1Enabled);
  expectRegister(`lw $14, 0x${preset.toString(16)}($0)`, 14, timerPreset);
  if (stopped) {
    emitStoreImmediate(writer, mode1Stopped, ctrl);
    expectRegister(`lw $14, 0x${ctrl.toString(16)}($0)`, 14, mode1Stopped);
    expectRegister(`lw $14, 0x${preset.toString(16)}($0)`, 14, timerPreset);
  }
  // The two stopped MMIO reads also allow the final legal LOAD/INT edge.
  const countSample = { pc: writer.pc(), register: 12 };
  writer.emit(`lw $12, 0x${count.toString(16)}($0)`);

  let stoppedCount;
  let ipSampling;
  if (stopped) {
    expectLowIp();
    stoppedCount = { pc: writer.pc(), register: 13 };
    writer.emit(`lw $13, 0x${count.toString(16)}($0)`);
    expectLowIp();
  } else {
    // A zero sample between the two IRQs proves the second did not come from a
    // continuously asserted request. CPU-side sampling can still miss that
    // phase, so give up explicitly after a bounded number of observations.
    const attempts = 64;
    writer.emit(`ori $10, $0, ${attempts}`);
    writer.label(label('mode1_clear_ip'));
    writer.emit('mfc0 $15, $13');
    const sample = { pc: writer.pc(), register: 15 };
    writer.emit(`andi $15, $15, 0x${ipMask.toString(16)}`);
    writer.emit(`beq $15, $0, ${label('mode1_ip_clear')}`);
    writer.emit('nop');
    writer.emit('addi $10, $10, -1');
    writer.emit(`bne $10, $0, ${label('mode1_clear_ip')}`);
    writer.emit('nop');
    ipSampling = { sample, attempts, exhausted: emitMarker(p7ProbeMode1UnobservedMarkerBase | id) };
    writer.label(label('mode1_ip_unobserved'));
    writer.emit(`beq $0, $0, ${label('mode1_ip_unobserved')}`);
    writer.emit('nop');
    writer.label(label('mode1_ip_clear'));
    expectRegister('add $15, $15, $0', 15, 0);
  }
  requiredPreHandlerCommits.push(emitMarker(p7ProbeMode1DeassertMarkerBase | id));

  emitStoreImmediate(
    writer,
    p7ProbeFlagRepeatTimerInterrupt | p7ProbeFlagRepeatTimerCaptured | p7ProbeFlagRepeatTimerFreshArmed,
    p7ProbeStateFlags
  );
  if (stopped) {
    emitStoreImmediate(writer, mode1Enabled, ctrl);
  }
  const freshWaitPc = emitInterruptWait(label('mode1_fresh_wait'));

  const completionPc = writer.pc();
  writer.label(label('done'));
  writer.emit(`ori $1, $0, ${id}`);
  emitPadding(writer, rng, padding.postMin, padding.postMax);

  return {
    ...scenarioWithLocations(id, kind, freshWaitPc, completionPc),
    variant,
    allowedEpc: [freshWaitPc],
    timerPreset,
    timerObservation: { kind: 'mode1', count: countSample, stoppedCount, ipSampling, firstCapture },
    requireCompletion: true,
    replayStatusAddress: p7ProbePostEretStatusAddress,
    expectedRecords: [initialWaitPc, freshWaitPc].map(waitPc => ({
      expectedIpMask: ipMask,
      allowedIpMasks: [0, ipMask],
      expectedExcCode: 0,
      allowedEpc: [waitPc],
      allowedBdEpc: [waitPc]
    })),
    requiredPreHandlerCommits
  };

  function emitInterruptWait(waitLabel: string): number {
    const returnPc = writer.pc() + 6 * 4;
    emitStoreImmediate(writer, returnPc, p7ProbeStateDonePc);
    emitEnableInterrupts(writer);
    const waitPc = writer.pc();
    writer.label(waitLabel);
    writer.emit(`beq $0, $0, ${waitLabel}`);
    writer.emit('nop');
    if (writer.pc() !== returnPc) {
      throw new BuiltinAsmGeneratorError(`Internal generator error: P7 Mode-1 scenario ${id} return PC was miscalculated.`);
    }
    return waitPc;
  }

  function expectRegister(instruction: string, target: number, value: number): void {
    requiredPreHandlerCommits.push({ pc: writer.pc(), kind: 'grf', target, value });
    writer.emit(instruction);
  }

  function expectLowIp(): void {
    writer.emit('mfc0 $15, $13');
    expectRegister(`andi $15, $15, 0x${ipMask.toString(16)}`, 15, 0);
  }

  function emitMarker(value: number): P7ProbeCommitExpectation {
    emitLoadImmediate(writer, '$15', value);
    const pc = writer.pc();
    writer.emit(`sw $15, 0x${p7ProbeMaskedInterruptMarkerAddress.toString(16)}($0)`);
    return { pc, kind: 'dm', target: p7ProbeMaskedInterruptMarkerAddress, value };
  }
}
