import { describe, expect, it } from 'vitest';
import {
  CourseDeviceBus,
  DeviceAccess,
  isDeviceAccessFault
} from '../../mips/core/devices/deviceBus';
import {
  CourseTimerDevice,
  TimerSnapshot,
  TimerState,
  timerControlBits,
  timerRegisterIndex
} from '../../mips/core/devices/timer';
import { DeviceEvent } from '../../mips/core/events/commitEvent';
import { resolveCourseProfile } from '../../mips/core/profiles/courseProfiles';
import { AccessWidth, DeviceRegionId } from '../../mips/core/profiles/profile';

/**
 * Cycle-level contract of the official P7 timer (`CourseTimerDevice`) and of the
 * timer transaction port (`CourseDeviceBus`).
 *
 * Every expected value below is derived from the normative RTL
 * `cscore/markdown/assets/cscore-assets/P7_standard_timer_2019.v`, transcribed
 * here so a reader can check each row without opening the implementation:
 *
 * ```verilog
 * `define IDLE 2'b00  `define LOAD 2'b01  `define CNT 2'b10  `define INT 2'b11
 * `define ctrl mem[0]  `define preset mem[1]  `define count mem[2]     // lines 2-9
 * assign IRQ  = `ctrl[3] & _IRQ;                                       // line 43
 * assign Dout = mem[Addr[3:2]];                                        // line 45
 * wire [31:0] load = Addr[3:2] == 0 ? {28'h0, Din[3:0]} : Din;         // line 47
 * always @(posedge clk) begin
 *   if(reset) begin state <= 0; mem[0..2] <= 0; _IRQ <= 0; end         // lines 51-55
 *   else if(WE) mem[Addr[3:2]] <= load;                                // lines 56-59
 *   else case(state)
 *     `IDLE: if(`ctrl[0]) begin state <= `LOAD; _IRQ <= 1'b0; end      // lines 62-65
 *     `LOAD: begin `count <= `preset; state <= `CNT; end               // lines 66-69
 *     `CNT : if(`ctrl[0]) begin
 *              if(`count > 1) `count <= `count-1;                      // line 72
 *              else begin `count <= 0; state <= `INT; _IRQ <= 1'b1; end// lines 73-77
 *            end else state <= `IDLE;                                  // line 79
 *     default: begin                                        // `INT, lines 80-84
 *              if(`ctrl[2:1] == 2'b00) `ctrl[0] <= 1'b0; else _IRQ <= 1'b0;
 *              state <= `IDLE; end
 *   endcase
 * end
 * ```
 *
 * Three consequences drive most rows: `else if(WE)` means a register write edge
 * fully suppresses the state machine; `IRQ` is a combinational AND, so clearing
 * `CTRL.IM` retracts a pending request with no clock edge at all; and the `INT`
 * branch always returns to `IDLE`, so a periodic timer still needs
 * `IDLE -> LOAD -> CNT` before `COUNT` is reloaded — there is no same-edge reload.
 *
 * Contract ids pinned here: COURSE-P7-TIMER-003/004/005/006/008 (frozen in
 * `conformance/mips/contract/contracts.json`), COURSE-P7-TIMER-RESTART-001 (the
 * mode-0 restart vector, whose expected snapshots are transcribed verbatim from
 * `conformance/mips/decision-vectors/COURSE-P7-TIMER-RESTART-001.json`, an
 * official-Verilog oracle artifact) and COURSE-P7-TIMER-MODE-001 (Mode 2/3 is
 * undefined and must be reported instead of silently blessed).
 *
 * Address facts come from the P7-2-2 system-bridge table: Timer0 occupies
 * `0x7F00..0x7F0B` and Timer1 `0x7F10..0x7F1B`, both selected by `Addr[3:2]`.
 */

// ---------------------------------------------------------------------------
// Vector-table helpers
// ---------------------------------------------------------------------------

type TimerOp =
  | { readonly kind: 'write'; readonly register: 'ctrl' | 'preset'; readonly value: number }
  | { readonly kind: 'tick' };

/** One clock edge with `WE = 0`: the state machine runs. */
const tick: TimerOp = { kind: 'tick' };

/** Stage a CTRL write; the following `tick` is that write's `WE = 1` edge. */
function writeCtrl(value: number): TimerOp {
  return { kind: 'write', register: 'ctrl', value };
}

/** Stage a PRESET write; the following `tick` is that write's `WE = 1` edge. */
function writePreset(value: number): TimerOp {
  return { kind: 'write', register: 'preset', value };
}

/**
 * Expected `snapshot()` after one operation. Column order mirrors the RTL:
 * `state, ctrl, preset, count, _IRQ, IRQ, <edges so far>, <staged WE edges>`.
 */
function snap(
  state: TimerState,
  ctrl: number,
  preset: number,
  count: number,
  pendingIrq: boolean,
  irq: boolean,
  cycle: number,
  pendingWriteEdges = 0
): TimerSnapshot {
  return { state, ctrl, preset, count, pendingIrq, irq, cycle, pendingWriteEdges };
}

interface CycleVectorStep {
  readonly label: string;
  readonly op: TimerOp;
  readonly after: TimerSnapshot;
}

/** Run a directed cycle vector, checking the full snapshot after every step. */
function runVector(
  device: CourseTimerDevice,
  steps: readonly CycleVectorStep[]
): DeviceEvent[][] {
  const emitted: DeviceEvent[][] = [];
  for (const step of steps) {
    const events = step.op.kind === 'tick'
      ? device.tick()
      : device.write(timerRegisterIndex[step.op.register], step.op.value);
    emitted.push(events);
    expect(device.snapshot(), step.label).toEqual(step.after);
  }
  return emitted;
}

/** CTRL word from its RTL fields: `ctrl[3]` = IM, `ctrl[2:1]` = Mode, `ctrl[0]` = Enable. */
function ctrlWord(mode: number, interruptMask: boolean, enable: boolean): number {
  return (interruptMask ? 0b1000 : 0) | ((mode & 0b11) << 1) | (enable ? 0b0001 : 0);
}

const p7Exceptions = resolveCourseProfile('P7').exceptions!;

/** P7-2-2 system-bridge addresses; `Addr[3:2]` selects the register inside a timer. */
const timerPorts = {
  timer0: { ctrl: 0x0000_7f00, preset: 0x0000_7f04, count: 0x0000_7f08 },
  timer1: { ctrl: 0x0000_7f10, preset: 0x0000_7f14, count: 0x0000_7f18 }
} as const;

const interruptGeneratorPort = 0x0000_7f20;

function storeAccess(
  device: DeviceRegionId,
  address: number,
  value: number,
  width: AccessWidth = 4
): DeviceAccess {
  return { kind: 'store', device, address, width, value };
}

function loadAccess(
  device: DeviceRegionId,
  address: number,
  width: AccessWidth = 4
): DeviceAccess {
  return { kind: 'load', device, address, width };
}

// ---------------------------------------------------------------------------
// 1-2, 10 (device side): reset state and register ports
// ---------------------------------------------------------------------------

describe('P7 timer reset state and register ports', () => {
  it('resets to IDLE with every register and the latched request cleared', () => {
    // RTL lines 51-55: `if(reset) begin state <= 0; mem[i] <= 0; _IRQ <= 0; end`.
    // COURSE-P7-TIMER-003: CTRL/PRESET/COUNT reset 均为 0.
    const timer = new CourseTimerDevice('timer0');
    expect(timer.snapshot(), 'construction').toEqual(snap('idle', 0, 0, 0, false, false, 0));
    expect(timer.irq, 'IRQ out of reset').toBe(false);
    for (const register of [timerRegisterIndex.ctrl, timerRegisterIndex.preset,
      timerRegisterIndex.count] as const) {
      expect(timer.read(register), `Dout[${register}] out of reset`).toBe(0);
    }
  });

  it('maps the register indices and CTRL fields onto the RTL layout', () => {
    // RTL lines 7-9: ctrl = mem[0], preset = mem[1], count = mem[2].
    expect(timerRegisterIndex).toEqual({ ctrl: 0, preset: 1, count: 2 });
    // RTL line 62 (`ctrl[0]`), line 81 (`ctrl[2:1]`), line 43 (`ctrl[3]`).
    expect(timerControlBits.enable).toBe(0b0001);
    expect(timerControlBits.modeMask).toBe(0b0110);
    expect(timerControlBits.modeShift).toBe(1);
    expect(timerControlBits.interruptMask).toBe(0b1000);
    expect(ctrlWord(0, true, true), 'mode 0, IM, EN').toBe(0x9);
    expect(ctrlWord(1, true, true), 'mode 1, IM, EN').toBe(0xb);
    expect(ctrlWord(0, true, false), 'mode 0, IM, stopped').toBe(0x8);
  });

  it('stores only the low four bits of CTRL and all 32 bits of PRESET', () => {
    // RTL line 47: `load = Addr[3:2] == 0 ? {28'h0, Din[3:0]} : Din`.
    const ctrlCases: ReadonlyArray<readonly [number, number]> = [
      [0xffff_ffff, 0xf],
      [0x0000_00f0, 0x0],
      [0x0000_001a, 0xa],
      [0x8000_0009, 0x9]
    ];
    for (const [written, stored] of ctrlCases) {
      const timer = new CourseTimerDevice('timer0');
      const events = timer.write(timerRegisterIndex.ctrl, written);
      const label = `CTRL <= 0x${written.toString(16)}`;
      expect(timer.read(timerRegisterIndex.ctrl), label).toBe(stored);
      expect(events, `${label} event`).toEqual([{
        kind: 'timer-register-write',
        device: 'timer0',
        address: timerRegisterIndex.ctrl,
        value: stored,
        cycle: 0
      }]);
      // A CTRL write addresses mem[0] only; PRESET/COUNT are untouched.
      expect(timer.read(timerRegisterIndex.preset), `${label} keeps PRESET`).toBe(0);
      expect(timer.read(timerRegisterIndex.count), `${label} keeps COUNT`).toBe(0);
    }

    const presetCases: ReadonlyArray<readonly [number, number]> = [
      [0xffff_ffff, 0xffff_ffff],
      [0x8000_0000, 0x8000_0000],
      [0x0000_00f0, 0x0000_00f0],
      [-1, 0xffff_ffff]
    ];
    for (const [written, stored] of presetCases) {
      const timer = new CourseTimerDevice('timer1');
      const events = timer.write(timerRegisterIndex.preset, written);
      const label = `PRESET <= ${written}`;
      expect(timer.read(timerRegisterIndex.preset), label).toBe(stored);
      expect(events, `${label} event`).toEqual([{
        kind: 'timer-register-write',
        device: 'timer1',
        address: timerRegisterIndex.preset,
        value: stored,
        cycle: 0
      }]);
      expect(timer.read(timerRegisterIndex.ctrl), `${label} keeps CTRL`).toBe(0);
    }
  });

  it('refuses a COUNT write at the device port', () => {
    // The RTL exposes mem[2] to `WE`, but P7-2-3 makes a store to COUNT an AdES
    // that must be suppressed before it reaches the device, so reaching this
    // port with a COUNT write is an engine bug rather than device behaviour.
    const timer = new CourseTimerDevice('timer0');
    expect(() => timer.write(timerRegisterIndex.count, 1)).toThrow(/COUNT is read-only/);
    expect(timer.snapshot(), 'rejected COUNT write').toEqual(snap('idle', 0, 0, 0, false, false, 0));
  });
});

// ---------------------------------------------------------------------------
// 3-5, 7: cycle vectors for the state machine
// ---------------------------------------------------------------------------

describe('P7 timer cycle state machine', () => {
  it('spends one clock edge on a register write without advancing the state', () => {
    // RTL lines 56-59: `else if(WE) ...` sits before the `case(state)`, so the
    // write edge cannot also be an IDLE -> LOAD edge (COURSE-P7-TIMER-006).
    const timer = new CourseTimerDevice('timer0');
    runVector(timer, [
      //                                              state  ctrl preset count _IRQ   IRQ    cyc WE
      { label: 'stage CTRL <= 0x9', op: writeCtrl(0x9), after: snap('idle', 0x9, 0, 0, false, false, 0, 1) },
      { label: 'WE edge: state machine suppressed', op: tick, after: snap('idle', 0x9, 0, 0, false, false, 1) },
      { label: 'first non-WE edge: IDLE -> LOAD', op: tick, after: snap('load', 0x9, 0, 0, false, false, 2) }
    ]);
  });

  it('exposes 0, 0, PRESET when PRESET or CTRL is the colliding third write', () => {
    // This is the architectural observation used by the generated student-DUT probe.
    // Each write is one M-stage WE edge; each following read samples Dout before its
    // non-WE edge advances IDLE -> LOAD -> CNT.
    const timer = new CourseTimerDevice('timer0');
    timer.write(timerRegisterIndex.preset, 0x20);
    timer.tick();
    timer.write(timerRegisterIndex.ctrl, 1);
    timer.tick();
    timer.write(timerRegisterIndex.preset, 0x40);
    timer.tick();

    const observations: number[] = [];
    for (let index = 0; index < 3; index++) {
      observations.push(timer.read(timerRegisterIndex.count));
      timer.tick();
    }

    expect(observations).toEqual([0, 0, 0x40]);
    expect(timer.snapshot()).toEqual(snap('cnt', 1, 0x40, 0x3f, false, false, 6));

    const ctrlTimer = new CourseTimerDevice('timer1');
    ctrlTimer.write(timerRegisterIndex.preset, 0x20);
    ctrlTimer.tick();
    ctrlTimer.write(timerRegisterIndex.ctrl, 1);
    ctrlTimer.tick();
    ctrlTimer.write(timerRegisterIndex.ctrl, 1);
    ctrlTimer.tick();

    const ctrlObservations: number[] = [];
    for (let index = 0; index < 3; index++) {
      ctrlObservations.push(ctrlTimer.read(timerRegisterIndex.count));
      ctrlTimer.tick();
    }

    expect(ctrlObservations).toEqual([0, 0, 0x20]);
    expect(ctrlTimer.snapshot()).toEqual(snap('cnt', 1, 0x20, 0x1f, false, false, 6));
  });

  it('runs a mode-0 one-shot from IDLE through INT back to IDLE', () => {
    // COURSE-P7-TIMER-004/005/008. CTRL = 0x9 -> IM = 1, Mode = 2'b00, EN = 1.
    // PRESET = 3, so CNT takes three edges: 3 -> 2 -> 1 -> (0 and INT), because
    // RTL line 72 decrements only while `count > 1`.
    const timer = new CourseTimerDevice('timer0');
    const events = runVector(timer, [
      //                                                     state  ctrl preset count _IRQ   IRQ    cyc WE
      { label: 'stage PRESET <= 3', op: writePreset(3), after: snap('idle', 0x0, 3, 0, false, false, 0, 1) },
      { label: 'WE edge (PRESET)', op: tick, after: snap('idle', 0x0, 3, 0, false, false, 1) },
      { label: 'stage CTRL <= 0x9', op: writeCtrl(0x9), after: snap('idle', 0x9, 3, 0, false, false, 1, 1) },
      { label: 'WE edge (CTRL)', op: tick, after: snap('idle', 0x9, 3, 0, false, false, 2) },
      { label: 'IDLE -> LOAD (EN = 1)', op: tick, after: snap('load', 0x9, 3, 0, false, false, 3) },
      { label: 'LOAD: COUNT <= PRESET', op: tick, after: snap('cnt', 0x9, 3, 3, false, false, 4) },
      { label: 'CNT: 3 -> 2', op: tick, after: snap('cnt', 0x9, 3, 2, false, false, 5) },
      { label: 'CNT: 2 -> 1', op: tick, after: snap('cnt', 0x9, 3, 1, false, false, 6) },
      { label: 'CNT: 1 -> INT, _IRQ set', op: tick, after: snap('int', 0x9, 3, 0, true, true, 7) },
      { label: 'INT: mode 0 clears EN, keeps _IRQ', op: tick, after: snap('idle', 0x8, 3, 0, true, true, 8) },
      { label: 'IDLE with EN = 0 is a fixed point', op: tick, after: snap('idle', 0x8, 3, 0, true, true, 9) }
    ]);

    // The CNT -> INT edge is the only one that asserts IRQ; the mode-0 INT edge
    // clears `ctrl[0]` but never `_IRQ`, so IRQ stays high across it.
    expect(events[8], 'CNT -> INT edge events').toEqual([
      { kind: 'timer-state-transition', device: 'timer0', cycle: 7, detail: 'cnt -> int' },
      { kind: 'timer-irq-asserted', device: 'timer0', cycle: 7 }
    ]);
    expect(events[9], 'INT -> IDLE edge events').toEqual([
      { kind: 'timer-state-transition', device: 'timer0', cycle: 8, detail: 'int -> idle' }
    ]);
    expect(events[10], 'idle fixed point emits nothing').toEqual([]);
  });

  it('reaches INT after a single CNT edge when PRESET is 0 or 1', () => {
    // RTL line 72 tests `count > 1`, not `count > 0`: PRESET = 1 and PRESET = 0
    // both spend exactly one edge in CNT.
    for (const preset of [0, 1] as const) {
      const timer = new CourseTimerDevice('timer0');
      const ctrl = ctrlWord(0, true, true);
      runVector(timer, [
        { label: `PRESET = ${preset}: stage PRESET`, op: writePreset(preset), after: snap('idle', 0x0, preset, 0, false, false, 0, 1) },
        { label: `PRESET = ${preset}: WE edge (PRESET)`, op: tick, after: snap('idle', 0x0, preset, 0, false, false, 1) },
        { label: `PRESET = ${preset}: stage CTRL`, op: writeCtrl(ctrl), after: snap('idle', ctrl, preset, 0, false, false, 1, 1) },
        { label: `PRESET = ${preset}: WE edge (CTRL)`, op: tick, after: snap('idle', ctrl, preset, 0, false, false, 2) },
        { label: `PRESET = ${preset}: IDLE -> LOAD`, op: tick, after: snap('load', ctrl, preset, 0, false, false, 3) },
        { label: `PRESET = ${preset}: LOAD -> CNT`, op: tick, after: snap('cnt', ctrl, preset, preset, false, false, 4) },
        { label: `PRESET = ${preset}: single CNT edge -> INT`, op: tick, after: snap('int', ctrl, preset, 0, true, true, 5) }
      ]);
    }
  });

  it('reloads a mode-1 period through IDLE and LOAD instead of at the INT edge', () => {
    // COURSE-P7-TIMER-005. CTRL = 0xB -> IM = 1, Mode = 2'b01, EN = 1.
    // The INT branch clears `_IRQ` (mode != 0) and unconditionally returns to
    // IDLE, so the next period costs `1 (IDLE->LOAD) + 1 (LOAD->CNT) + PRESET
    // (CNT edges) + 1 (INT->IDLE)` = PRESET + 3 edges. PRESET = 3 -> 6 edges.
    const timer = new CourseTimerDevice('timer1');
    const events = runVector(timer, [
      //                                                     state  ctrl preset count _IRQ   IRQ    cyc WE
      { label: 'stage PRESET <= 3', op: writePreset(3), after: snap('idle', 0x0, 3, 0, false, false, 0, 1) },
      { label: 'WE edge (PRESET)', op: tick, after: snap('idle', 0x0, 3, 0, false, false, 1) },
      { label: 'stage CTRL <= 0xB', op: writeCtrl(0xb), after: snap('idle', 0xb, 3, 0, false, false, 1, 1) },
      { label: 'WE edge (CTRL)', op: tick, after: snap('idle', 0xb, 3, 0, false, false, 2) },
      { label: 'period 1: IDLE -> LOAD', op: tick, after: snap('load', 0xb, 3, 0, false, false, 3) },
      { label: 'period 1: LOAD -> CNT', op: tick, after: snap('cnt', 0xb, 3, 3, false, false, 4) },
      { label: 'period 1: CNT 3 -> 2', op: tick, after: snap('cnt', 0xb, 3, 2, false, false, 5) },
      { label: 'period 1: CNT 2 -> 1', op: tick, after: snap('cnt', 0xb, 3, 1, false, false, 6) },
      { label: 'period 1: CNT -> INT', op: tick, after: snap('int', 0xb, 3, 0, true, true, 7) },
      { label: 'period 1: INT clears _IRQ, keeps EN', op: tick, after: snap('idle', 0xb, 3, 0, false, false, 8) },
      { label: 'period 2: IDLE -> LOAD, COUNT still stale', op: tick, after: snap('load', 0xb, 3, 0, false, false, 9) },
      { label: 'period 2: LOAD -> CNT reloads PRESET', op: tick, after: snap('cnt', 0xb, 3, 3, false, false, 10) },
      { label: 'period 2: CNT 3 -> 2', op: tick, after: snap('cnt', 0xb, 3, 2, false, false, 11) },
      { label: 'period 2: CNT 2 -> 1', op: tick, after: snap('cnt', 0xb, 3, 1, false, false, 12) },
      { label: 'period 2: CNT -> INT', op: tick, after: snap('int', 0xb, 3, 0, true, true, 13) },
      { label: 'period 2: INT clears _IRQ, keeps EN', op: tick, after: snap('idle', 0xb, 3, 0, false, false, 14) }
    ]);

    // One period measured two independent ways, both PRESET + 3 = 6 edges.
    const loadEdges = [3, 9];
    const intEdges = [7, 13];
    expect(loadEdges[1] - loadEdges[0], 'IDLE -> LOAD period').toBe(3 + 3);
    expect(intEdges[1] - intEdges[0], 'CNT -> INT period').toBe(3 + 3);
    // Mode 1 is a defined mode: no undefined-mode report anywhere in the run.
    expect(events.flat().filter((event) => event.kind === 'timer-mode-undefined'), 'mode 1 reports').toEqual([]);
    expect(events[9], 'mode 1 INT edge events').toEqual([
      { kind: 'timer-state-transition', device: 'timer1', cycle: 8, detail: 'int -> idle' },
      { kind: 'timer-irq-cleared', device: 'timer1', cycle: 8 }
    ]);
  });

  it('stops in CNT when EN is cleared and reloads PRESET when EN returns', () => {
    // COURSE-P7-TIMER-006. RTL line 79: `CNT` with `ctrl[0] == 0` falls back to
    // IDLE and leaves `count` alone; restarting always goes through LOAD, which
    // overwrites COUNT with PRESET (RTL line 67) rather than resuming.
    const timer = new CourseTimerDevice('timer0');
    runVector(timer, [
      //                                                     state  ctrl preset count _IRQ   IRQ    cyc WE
      { label: 'stage PRESET <= 5', op: writePreset(5), after: snap('idle', 0x0, 5, 0, false, false, 0, 1) },
      { label: 'WE edge (PRESET)', op: tick, after: snap('idle', 0x0, 5, 0, false, false, 1) },
      { label: 'stage CTRL <= 0x9', op: writeCtrl(0x9), after: snap('idle', 0x9, 5, 0, false, false, 1, 1) },
      { label: 'WE edge (CTRL)', op: tick, after: snap('idle', 0x9, 5, 0, false, false, 2) },
      { label: 'IDLE -> LOAD', op: tick, after: snap('load', 0x9, 5, 0, false, false, 3) },
      { label: 'LOAD -> CNT', op: tick, after: snap('cnt', 0x9, 5, 5, false, false, 4) },
      { label: 'CNT: 5 -> 4', op: tick, after: snap('cnt', 0x9, 5, 4, false, false, 5) },
      { label: 'CNT: 4 -> 3', op: tick, after: snap('cnt', 0x9, 5, 3, false, false, 6) },
      { label: 'stage CTRL <= 0x8 (EN cleared)', op: writeCtrl(0x8), after: snap('cnt', 0x8, 5, 3, false, false, 6, 1) },
      { label: 'WE edge does not run CNT', op: tick, after: snap('cnt', 0x8, 5, 3, false, false, 7) },
      { label: 'CNT with EN = 0 -> IDLE, COUNT kept', op: tick, after: snap('idle', 0x8, 5, 3, false, false, 8) },
      { label: 'IDLE with EN = 0 holds COUNT', op: tick, after: snap('idle', 0x8, 5, 3, false, false, 9) },
      { label: 'stage CTRL <= 0x9 (EN set again)', op: writeCtrl(0x9), after: snap('idle', 0x9, 5, 3, false, false, 9, 1) },
      { label: 'WE edge (CTRL)', op: tick, after: snap('idle', 0x9, 5, 3, false, false, 10) },
      { label: 'IDLE -> LOAD, COUNT still stale', op: tick, after: snap('load', 0x9, 5, 3, false, false, 11) },
      { label: 'LOAD reloads COUNT from PRESET', op: tick, after: snap('cnt', 0x9, 5, 5, false, false, 12) }
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6, 8, 9: interrupt output, mode-0 restart and undefined modes
// ---------------------------------------------------------------------------

describe('P7 timer interrupt output contract', () => {
  /** Drive a mode-0 one-shot with PRESET = 1 to its post-INT resting state. */
  function armedAndFired(): CourseTimerDevice {
    const timer = new CourseTimerDevice('timer0');
    timer.write(timerRegisterIndex.preset, 1);
    timer.tick();                       // WE edge (PRESET)
    timer.write(timerRegisterIndex.ctrl, ctrlWord(0, true, true));
    timer.tick();                       // WE edge (CTRL)
    timer.tick();                       // IDLE -> LOAD
    timer.tick();                       // LOAD -> CNT, COUNT = 1
    timer.tick();                       // CNT -> INT, _IRQ = 1
    timer.tick();                       // INT: mode 0 clears EN, keeps _IRQ
    // CTRL = 0x8 (IM still set, EN cleared), _IRQ latched, IRQ visible.
    expect(timer.snapshot(), 'fired one-shot resting state')
      .toEqual(snap('idle', 0x8, 1, 0, true, true, 6));
    return timer;
  }

  it('gates the visible request with CTRL.IM without consuming a clock edge', () => {
    // RTL line 43: `assign IRQ = ctrl[3] & _IRQ` — a combinational AND, so
    // clearing IM retracts the request immediately (COURSE-P7-TIMER-003).
    const timer = armedAndFired();

    timer.write(timerRegisterIndex.ctrl, 0x0);
    expect(timer.snapshot(), 'IM cleared, latch kept')
      .toEqual(snap('idle', 0x0, 1, 0, true, false, 6, 1));
    expect(timer.irq, 'IRQ with IM = 0').toBe(false);

    timer.tick();
    expect(timer.snapshot(), 'WE edge after clearing IM')
      .toEqual(snap('idle', 0x0, 1, 0, true, false, 7));
    timer.tick();
    // IDLE only clears `_IRQ` when `ctrl[0]` is set; EN is 0 here, so the latch
    // survives an arbitrary number of idle edges.
    expect(timer.snapshot(), 'idle edge with EN = 0 keeps the latch')
      .toEqual(snap('idle', 0x0, 1, 0, true, false, 8));

    timer.write(timerRegisterIndex.ctrl, 0x8);
    expect(timer.snapshot(), 'IM set again re-asserts IRQ')
      .toEqual(snap('idle', 0x8, 1, 0, true, true, 8, 1));
    expect(timer.irq, 'IRQ with IM = 1 and the latch set').toBe(true);
  });

  it('holds IRQ across the mode-0 restart write and clears it on the first IDLE -> LOAD edge', () => {
    // COURSE-P7-TIMER-RESTART-001 / COURSE-P7-TIMER-008. The RTL wins over the
    // COCO timer PDF here. Rows below are the decision-vector snapshots from
    // conformance/mips/decision-vectors/COURSE-P7-TIMER-RESTART-001.json
    // (state 0/1/2/3 = IDLE/LOAD/CNT/INT, PRESET = 2, CTRL = 0x9):
    //   reset              state 0 ctrl 0 preset 0 count 0 latchedIrq 0 irq 0
    //   write_preset       state 0 ctrl 0 preset 2 count 0 latchedIrq 0 irq 0
    //   write_enable       state 0 ctrl 9 preset 2 count 0 latchedIrq 0 irq 0
    //   initial_load       state 1 ctrl 9 preset 2 count 0 latchedIrq 0 irq 0
    //   initial_count_load state 2 ctrl 9 preset 2 count 2 latchedIrq 0 irq 0
    //   count_one          state 2 ctrl 9 preset 2 count 1 latchedIrq 0 irq 0
    //   irq_set            state 3 ctrl 9 preset 2 count 0 latchedIrq 1 irq 1
    //   mode0_idle         state 0 ctrl 8 preset 2 count 0 latchedIrq 1 irq 1
    //   restart_write      state 0 ctrl 9 preset 2 count 0 latchedIrq 1 irq 1
    //   restart_load       state 1 ctrl 9 preset 2 count 0 latchedIrq 0 irq 0
    //   restart_count_load state 2 ctrl 9 preset 2 count 2 latchedIrq 0 irq 0
    const timer = new CourseTimerDevice('timer0');
    expect(timer.snapshot(), 'reset').toEqual(snap('idle', 0, 0, 0, false, false, 0));
    const events = runVector(timer, [
      //                                                     state  ctrl preset count _IRQ   IRQ    cyc WE
      { label: 'stage PRESET <= 2', op: writePreset(2), after: snap('idle', 0x0, 2, 0, false, false, 0, 1) },
      { label: 'write_preset', op: tick, after: snap('idle', 0x0, 2, 0, false, false, 1) },
      { label: 'stage CTRL <= 0x9', op: writeCtrl(0x9), after: snap('idle', 0x9, 2, 0, false, false, 1, 1) },
      { label: 'write_enable', op: tick, after: snap('idle', 0x9, 2, 0, false, false, 2) },
      { label: 'initial_load', op: tick, after: snap('load', 0x9, 2, 0, false, false, 3) },
      { label: 'initial_count_load', op: tick, after: snap('cnt', 0x9, 2, 2, false, false, 4) },
      { label: 'count_one', op: tick, after: snap('cnt', 0x9, 2, 1, false, false, 5) },
      { label: 'irq_set', op: tick, after: snap('int', 0x9, 2, 0, true, true, 6) },
      { label: 'mode0_idle', op: tick, after: snap('idle', 0x8, 2, 0, true, true, 7) },
      { label: 'stage restart CTRL <= 0x9', op: writeCtrl(0x9), after: snap('idle', 0x9, 2, 0, true, true, 7, 1) },
      { label: 'restart_write', op: tick, after: snap('idle', 0x9, 2, 0, true, true, 8) },
      { label: 'restart_load', op: tick, after: snap('load', 0x9, 2, 0, false, false, 9) },
      { label: 'restart_count_load', op: tick, after: snap('cnt', 0x9, 2, 2, false, false, 10) }
    ]);

    // The restart WE edge is silent; the following IDLE -> LOAD edge is the one
    // that retracts the request (RTL line 64: `_IRQ <= 1'b0`).
    expect(events[10], 'restart_write edge events').toEqual([]);
    expect(events[11], 'restart_load edge events').toEqual([
      { kind: 'timer-state-transition', device: 'timer0', cycle: 9, detail: 'idle -> load' },
      { kind: 'timer-irq-cleared', device: 'timer0', cycle: 9 }
    ]);
  });

  it('reports an undefined mode when CTRL[2:1] is 2 or 3 and reaches INT', () => {
    // COURSE-P7-TIMER-MODE-001. The RTL `default` branch handles every non-zero
    // mode identically (clear `_IRQ`, return to IDLE, leave EN alone), but the
    // course never defines mode 2/3, so the engine must flag the case instead of
    // publishing the RTL result as a strict expectation.
    for (const mode of [2, 3] as const) {
      const ctrl = ctrlWord(mode, true, true);
      const timer = new CourseTimerDevice('timer1');
      timer.write(timerRegisterIndex.preset, 1);
      timer.tick();                     // WE edge (PRESET)
      timer.write(timerRegisterIndex.ctrl, ctrl);
      timer.tick();                     // WE edge (CTRL)
      timer.tick();                     // IDLE -> LOAD
      timer.tick();                     // LOAD -> CNT, COUNT = 1
      const toInt = timer.tick();       // CNT -> INT
      expect(timer.snapshot(), `mode ${mode}: INT entry`)
        .toEqual(snap('int', ctrl, 1, 0, true, true, 5));
      expect(toInt.map((event) => event.kind), `mode ${mode}: CNT -> INT events`)
        .toEqual(['timer-state-transition', 'timer-irq-asserted']);

      const atInt = timer.tick();       // INT -> IDLE
      expect(atInt.map((event) => event.kind), `mode ${mode}: INT edge events`)
        .toEqual(['timer-mode-undefined', 'timer-state-transition', 'timer-irq-cleared']);
      const report = atInt[0];
      expect(report.device, `mode ${mode}: reporting device`).toBe('timer1');
      expect(report.value, `mode ${mode}: reported mode`).toBe(mode);
      expect(report.cycle, `mode ${mode}: reporting cycle`).toBe(6);
      expect(report.detail ?? '', `mode ${mode}: contract id`).toContain('COURSE-P7-TIMER-MODE-001');
      // Only mode 0 clears `ctrl[0]`, so EN survives and the timer re-arms.
      expect(timer.snapshot(), `mode ${mode}: INT -> IDLE`)
        .toEqual(snap('idle', ctrl, 1, 0, false, false, 6));
      timer.tick();
      expect(timer.snapshot(), `mode ${mode}: re-arms because EN survived`)
        .toEqual(snap('load', ctrl, 1, 0, false, false, 7));
    }
  });

  it('never reports an undefined mode for the defined modes 0 and 1', () => {
    for (const mode of [0, 1] as const) {
      const ctrl = ctrlWord(mode, true, true);
      const timer = new CourseTimerDevice('timer0');
      timer.write(timerRegisterIndex.preset, 1);
      timer.tick();
      timer.write(timerRegisterIndex.ctrl, ctrl);
      const events: DeviceEvent[] = [];
      for (let edge = 0; edge < 8; edge++) {
        events.push(...timer.tick());
      }
      expect(events.filter((event) => event.kind === 'timer-mode-undefined'), `mode ${mode}`)
        .toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 10-12: the CourseDeviceBus transaction port
// ---------------------------------------------------------------------------

describe('course device bus timer transaction contract', () => {
  it('selects the timer register from Addr[3:2]', () => {
    // P7-2-2: Timer0 0x7F00..0x7F0B, Timer1 0x7F10..0x7F1B; RTL line 45/47 use
    // `Addr[3:2]` alone, so both timers share the same three offsets.
    const bus = new CourseDeviceBus(p7Exceptions);
    const cases: ReadonlyArray<readonly [DeviceRegionId, number, number]> = [
      ['timer0', timerPorts.timer0.ctrl, timerRegisterIndex.ctrl],
      ['timer0', timerPorts.timer0.preset, timerRegisterIndex.preset],
      ['timer0', timerPorts.timer0.count, timerRegisterIndex.count],
      ['timer1', timerPorts.timer1.ctrl, timerRegisterIndex.ctrl],
      ['timer1', timerPorts.timer1.preset, timerRegisterIndex.preset],
      ['timer1', timerPorts.timer1.count, timerRegisterIndex.count]
    ];
    for (const [device, address, register] of cases) {
      const prepared = bus.prepare(loadAccess(device, address));
      const label = `${device} load 0x${address.toString(16)}`;
      expect(isDeviceAccessFault(prepared), label).toBe(false);
      if (!isDeviceAccessFault(prepared)) {
        expect(prepared.register, `${label} register`).toBe(register);
      }
    }
    // `Addr[3:2] == 3` is past the three-register file and has no port.
    const beyond = bus.prepare(loadAccess('timer0', 0x0000_7f0c));
    expect(isDeviceAccessFault(beyond), 'timer0 load 0x7f0c').toBe(true);
    if (isDeviceAccessFault(beyond)) {
      expect(beyond.fault, 'timer0 load 0x7f0c fault').toBe('unmapped');
    }
  });

  it('rejects a store to COUNT before it reaches the device', () => {
    // COUNT is read-only at the port (P7-2-3 存数异常表): the store must become
    // an AdES and be suppressed, never a silent write of mem[2].
    const bus = new CourseDeviceBus(p7Exceptions);
    for (const [device, address] of [
      ['timer0', timerPorts.timer0.count],
      ['timer1', timerPorts.timer1.count]
    ] as ReadonlyArray<readonly [DeviceRegionId, number]>) {
      const prepared = bus.prepare(storeAccess(device, address, 0x1234));
      const label = `${device} store 0x${address.toString(16)}`;
      expect(isDeviceAccessFault(prepared), label).toBe(true);
      if (isDeviceAccessFault(prepared)) {
        expect(prepared.fault, `${label} fault`).toBe('count-write');
      }
    }
    // The same address is a perfectly legal load: `Dout = mem[Addr[3:2]]`.
    const read = bus.prepare(loadAccess('timer0', timerPorts.timer0.count));
    expect(isDeviceAccessFault(read), 'timer0 load COUNT').toBe(false);
    if (!isDeviceAccessFault(read)) {
      expect(bus.read(read), 'COUNT out of reset').toBe(0);
    }
  });

  it('fails timer transactions closed when no device cycle schedule exists', () => {
    // An architectural anchor declares no mapping from instructions to Timer
    // clock edges, so a timer transaction is out of the comparable domain rather
    // than "one instruction equals one edge".
    const bus = new CourseDeviceBus(p7Exceptions, { timersEnabled: false });
    const accesses: readonly DeviceAccess[] = [
      loadAccess('timer0', timerPorts.timer0.ctrl),
      storeAccess('timer0', timerPorts.timer0.preset, 4),
      loadAccess('timer1', timerPorts.timer1.count),
      storeAccess('timer1', timerPorts.timer1.ctrl, 9)
    ];
    for (const access of accesses) {
      const prepared = bus.prepare(access);
      const label = `${access.device} ${access.kind} 0x${access.address.toString(16)}`;
      expect(isDeviceAccessFault(prepared), label).toBe(true);
      if (isDeviceAccessFault(prepared)) {
        expect(prepared.fault, `${label} fault`).toBe('schedule-missing');
      }
    }
  });

  it('keeps the interrupt generator usable while timers are out of domain', () => {
    // P7-2-6: the generator has no storage (reads are 0) and is driven by the
    // macroscopic victim PC, not by any clock schedule, so it stays in domain.
    const bus = new CourseDeviceBus(p7Exceptions, {
      timersEnabled: false,
      externalInterrupts: [{ victimPc: 0x0000_3004, occurrence: 1 }]
    });
    const prepared = bus.prepare(loadAccess('interrupt-generator', interruptGeneratorPort));
    expect(isDeviceAccessFault(prepared), 'IG load prepare').toBe(false);
    if (isDeviceAccessFault(prepared)) {
      return;
    }
    expect(bus.read(prepared), 'IG read is always zero').toBe(0);

    expect(bus.observeMacroPc(0x0000_3000), 'non-victim PC').toEqual([]);
    expect(bus.observeMacroPc(0x0000_3004), 'victim PC occurrence 1').toEqual([{
      kind: 'external-interrupt-asserted',
      device: 'interrupt-generator',
      address: 0x0000_3004,
      value: 1
    }]);
    // HWInt bit 2 is the generator (P7-2-6 中断规范 wiring).
    expect(bus.sampleInterrupts(), 'HWInt with the generator asserted')
      .toBe(1 << p7Exceptions.wiring.interruptGeneratorBit);
    expect(bus.snapshot().externalInterrupt, 'external interrupt pending').toBe(true);

    // `sb $0, 0x7f20($0)` is the official acknowledge, so a byte store must work.
    const ack = bus.prepare(storeAccess('interrupt-generator', interruptGeneratorPort, 0, 1));
    expect(isDeviceAccessFault(ack), 'IG byte store prepare').toBe(false);
    if (isDeviceAccessFault(ack)) {
      return;
    }
    expect(bus.commit(ack), 'IG acknowledge event').toEqual([{
      kind: 'interrupt-generator-ack',
      device: 'interrupt-generator',
      address: interruptGeneratorPort,
      value: 1
    }]);
    expect(bus.sampleInterrupts(), 'HWInt after acknowledge').toBe(0);
  });

  it('advances exactly the requested number of device edges', () => {
    const bus = new CourseDeviceBus(p7Exceptions);
    const five = bus.tickCycle({ cycles: 5 });
    expect(five.cycles, 'bus cycles after 5 edges').toBe(5);
    expect(bus.snapshot().timer0.cycle, 'timer0 edges').toBe(5);
    expect(bus.snapshot().timer1.cycle, 'timer1 edges').toBe(5);

    // The default is a single edge, and zero edges must be a true no-op.
    bus.tickCycle();
    expect(bus.snapshot().timer0.cycle, 'timer0 after the default edge').toBe(6);
    const none = bus.tickCycle({ cycles: 0 });
    expect(none.events, 'zero-edge events').toEqual([]);
    expect(none.cycles, 'bus cycles after a zero-edge tick').toBe(6);
    expect(bus.snapshot().timer0.cycle, 'timer0 after a zero-edge tick').toBe(6);

    expect(() => bus.tickCycle({ cycles: -1 })).toThrow(/non-negative/);
  });

  it('drives HWInt bit 0 from a Timer0 one-shot committed through the port', () => {
    // End-to-end through prepare/commit/tickCycle: PRESET = 2 then CTRL = 0x9,
    // each store costing one WE edge, then four state-machine edges
    // (IDLE->LOAD, LOAD->CNT, CNT 2->1, CNT->INT) raise the request.
    const bus = new CourseDeviceBus(p7Exceptions);
    for (const [address, value] of [
      [timerPorts.timer0.preset, 2],
      [timerPorts.timer0.ctrl, 0x9]
    ] as ReadonlyArray<readonly [number, number]>) {
      const prepared = bus.prepare(storeAccess('timer0', address, value));
      const label = `store 0x${address.toString(16)} <= ${value}`;
      expect(isDeviceAccessFault(prepared), label).toBe(false);
      if (isDeviceAccessFault(prepared)) {
        return;
      }
      bus.commit(prepared);
      expect(bus.tickCycle({ cycles: 1 }).hardwareInterrupts, `${label} WE edge`).toBe(0);
    }

    const armed = bus.tickCycle({ cycles: 3 });
    expect(armed.hardwareInterrupts, 'HWInt three edges in').toBe(0);
    expect(bus.snapshot().timer0, 'timer0 one edge before INT')
      .toEqual(snap('cnt', 0x9, 2, 1, false, false, 5));

    const fired = bus.tickCycle({ cycles: 1 });
    expect(fired.hardwareInterrupts, 'HWInt at INT')
      .toBe(1 << p7Exceptions.wiring.timer0Bit);
    expect(bus.snapshot().timer0.irq, 'timer0 IRQ').toBe(true);
    expect(bus.snapshot().timer1.irq, 'timer1 IRQ').toBe(false);
    expect(bus.snapshot().hardwareInterrupts, 'aggregated HWInt').toBe(1);

    // A prepared-but-aborted transaction (exception victim) touches nothing.
    const suppressed = bus.prepare(storeAccess('timer0', timerPorts.timer0.ctrl, 0x0));
    expect(isDeviceAccessFault(suppressed), 'suppressed CTRL store').toBe(false);
    if (!isDeviceAccessFault(suppressed)) {
      bus.abort(suppressed);
    }
    expect(bus.snapshot().timer0, 'aborted store leaves the device untouched')
      .toEqual(snap('int', 0x9, 2, 0, true, true, 6));
  });

  it('clears every device back to its reset state on a reset tick', () => {
    // RTL lines 51-55 again, now through the bus-level reset entry point.
    const bus = new CourseDeviceBus(p7Exceptions, {
      externalInterrupts: [{ victimPc: 0x0000_3000, occurrence: 1 }]
    });
    const prepared = bus.prepare(storeAccess('timer0', timerPorts.timer0.ctrl, 0xf));
    expect(isDeviceAccessFault(prepared), 'CTRL store prepare').toBe(false);
    if (isDeviceAccessFault(prepared)) {
      return;
    }
    bus.commit(prepared);
    bus.tickCycle({ cycles: 4 });
    bus.observeMacroPc(0x0000_3000);
    expect(bus.snapshot().externalInterrupt, 'generator asserted before reset').toBe(true);
    expect(bus.snapshot().timer0.cycle, 'edges before reset').toBe(4);

    const cleared = bus.tickCycle({ reset: true });
    expect(cleared, 'reset tick result')
      .toEqual({ hardwareInterrupts: 0, events: [], cycles: 0 });
    expect(bus.snapshot(), 'device snapshot after reset').toEqual({
      timer0: snap('idle', 0, 0, 0, false, false, 0),
      timer1: snap('idle', 0, 0, 0, false, false, 0),
      externalInterrupt: false,
      hardwareInterrupts: 0
    });
  });
});
