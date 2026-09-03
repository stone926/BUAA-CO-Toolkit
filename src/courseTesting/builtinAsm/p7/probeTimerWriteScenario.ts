// @index p7-probe-timer-writes — Stable software-visible Timer write and pending-request observations
import { ProgramWriter } from '../programWriter';
import { P7ProbeScenario } from '../types';
import { Random } from '../../random';
import {
  p7CauseIpTimer0Mask, p7CauseIpTimer1Mask, p7ProbeStateDonePc,
  p7Timer0Ctrl, p7Timer0Preset, p7Timer0Count,
  p7Timer1Ctrl, p7Timer1Preset, p7Timer1Count
} from './constants';
import { ProbePaddingProfile, emitEnableInterrupts, emitPadding, emitStoreImmediate } from './probeAsm';
import { emitTimerPendingSetup } from './probePriorityScenarios';
import { expectedExcCode, scenarioWithLocations } from './probeScenarios';

/**
 * Mode 0 latches its pending request until a new period starts. Once Cause.IP
 * confirms expiry, disabled CTRL/PRESET writes must preserve COUNT=0 and that
 * request; CTRL.IM only masks its output. These observations remain stable for
 * any number of intervening CPU cycles. Per-edge WE > FSM priority belongs to
 * the Timer device tests: adjacent assembly accesses do not establish it.
 */
export function emitTimerPendingWritesScenario(
  writer: ProgramWriter,
  id: number,
  kind: 'timer0' | 'timer1',
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  const ctrl = kind === 'timer0' ? p7Timer0Ctrl : p7Timer1Ctrl;
  const preset = kind === 'timer0' ? p7Timer0Preset : p7Timer1Preset;
  const count = kind === 'timer0' ? p7Timer0Count : p7Timer1Count;
  const ipMask = kind === 'timer0' ? p7CauseIpTimer0Mask : p7CauseIpTimer1Mask;
  const pending = emitTimerPendingSetup(writer, id, kind);
  const requiredPreHandlerCommits = [...pending.requiredPreHandlerCommits];

  observe(`lw $11, 0x${ctrl.toString(16)}($0)`, 11, 8);
  observe(`lw $12, 0x${count.toString(16)}($0)`, 12, 0);
  emitStoreImmediate(writer, 0x40, preset);
  emitStoreImmediate(writer, 0, ctrl);
  emitStoreImmediate(writer, 0x20, preset);
  observeStoppedTimer(0, 0);

  // Reopen IM while Enable stays zero: the old pending request must reappear,
  // even though CTRL and PRESET have both been written in the meantime.
  emitStoreImmediate(writer, 8, ctrl);
  observeStoppedTimer(8, ipMask);
  emitStoreImmediate(writer, 0, ctrl);
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
    variant: 'pending-writes',
    expectedIpMask: 0,
    expectedExcCode: expectedExcCode('syscall'),
    expectedBd: false,
    allowedEpc: [victimPc],
    victimPc,
    timerPreset: 0x20,
    requireCompletion: true,
    requiredPreHandlerCommits
  };

  function observe(instruction: string, register: number, value: number): void {
    requiredPreHandlerCommits.push({ pc: writer.pc(), kind: 'grf', target: register, value });
    writer.emit(instruction);
  }

  function observeStoppedTimer(expectedCtrl: number, expectedIp: number): void {
    observe(`lw $13, 0x${ctrl.toString(16)}($0)`, 13, expectedCtrl);
    observe(`lw $14, 0x${preset.toString(16)}($0)`, 14, 0x20);
    observe(`lw $15, 0x${count.toString(16)}($0)`, 15, 0);
    writer.emit('mfc0 $16, $13');
    observe(`andi $16, $16, 0x${ipMask.toString(16)}`, 16, expectedIp);
  }
}
