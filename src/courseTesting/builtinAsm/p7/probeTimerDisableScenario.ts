// @index p7-probe-timer-disable — Active, stopped, and reloaded COUNT observations
import { ProgramWriter } from '../programWriter';
import { P7ProbeCommitExpectation, P7ProbeRegisterSample, P7ProbeScenario } from '../types';
import { Random } from '../../random';
import {
  p7ProbeStateDonePc, p7ProbeTimerDisablePreset, p7ProbeTimerReloadPreset,
  p7Timer0Ctrl, p7Timer0Count, p7Timer0Preset, p7Timer1Ctrl, p7Timer1Count, p7Timer1Preset
} from './constants';
import { ProbePaddingProfile, emitEnableInterrupts, emitPadding, emitStoreImmediate } from './probeAsm';
import { expectedExcCode, scenarioWithLocations } from './probeScenarios';

export function emitTimerDisableReloadScenario(
  writer: ProgramWriter,
  id: number,
  kind: 'timer0' | 'timer1',
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  const ctrl = kind === 'timer0' ? p7Timer0Ctrl : p7Timer1Ctrl;
  const preset = kind === 'timer0' ? p7Timer0Preset : p7Timer1Preset;
  const count = kind === 'timer0' ? p7Timer0Count : p7Timer1Count;
  const requiredPreHandlerCommits: P7ProbeCommitExpectation[] = [];

  // These two long periods remain in disjoint COUNT ranges throughout the
  // private watchdog budget, even when the CPU stalls between observations.
  emitStoreImmediate(writer, p7ProbeTimerDisablePreset, preset);
  emitStart(p7ProbeTimerDisablePreset);
  const activeCount1 = read(count, 10);
  const activeCount2 = read(count, 11);

  writer.emit(`sw $0, 0x${ctrl.toString(16)}($0)`);
  expectRead(ctrl, 0);
  const stoppedCount1 = read(count, 12);
  emitStoreImmediate(writer, p7ProbeTimerReloadPreset, preset);
  expectRead(preset, p7ProbeTimerReloadPreset);
  const stoppedCount2 = read(count, 13);

  emitStart(p7ProbeTimerReloadPreset);
  const reloadedCount = read(count, 14);
  writer.emit(`sw $0, 0x${ctrl.toString(16)}($0)`);
  emitEnableInterrupts(writer);

  const donePc = writer.pc() + 3 * 4;
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  const victimPc = writer.pc();
  writer.emit('syscall');
  writer.label(`_co_probe_s${id}_done`);
  writer.emit(`ori $1, $0, ${id}`);
  emitPadding(writer, rng, padding.postMin, padding.postMax);

  return {
    ...scenarioWithLocations(id, kind, victimPc, donePc),
    variant: 'disable-reload',
    expectedIpMask: 0,
    expectedExcCode: expectedExcCode('syscall'),
    expectedBd: false,
    allowedEpc: [victimPc],
    victimPc,
    timerPreset: p7ProbeTimerDisablePreset,
    timerObservation: {
      kind: 'disable-reload',
      activeCount: [activeCount1, activeCount2],
      stoppedCount: [stoppedCount1, stoppedCount2],
      reloadedCount
    },
    requireCompletion: true,
    requiredPreHandlerCommits
  };

  function emitStart(expectedPreset: number): void {
    emitStoreImmediate(writer, 1, ctrl);
    // Two intervening MMIO reads give the Timer its IDLE and LOAD edges.
    expectRead(ctrl, 1);
    expectRead(preset, expectedPreset);
  }

  function read(address: number, register: number): P7ProbeRegisterSample {
    const pc = writer.pc();
    writer.emit(`lw $${register}, 0x${address.toString(16)}($0)`);
    return { pc, register };
  }

  function expectRead(address: number, value: number): void {
    const { pc, register } = read(address, 15);
    requiredPreHandlerCommits.push({ pc, kind: 'grf', target: register, value });
  }
}
