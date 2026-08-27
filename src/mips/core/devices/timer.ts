// @index mips-core — 官方 P7 计时器的周期级 CycleContract 实现（依据 P7_standard_timer_2019.v）
import { DeviceEvent } from '../events/commitEvent';
import { DeviceRegionId } from '../profiles/profile';
import { u32 } from '../values';

/**
 * 本设备按官方 Verilog `P7_standard_timer_2019.v` 的时钟边沿语义重建，而不是翻译
 * MARS 的 Java 计时器（计划第 5.9/10 节）。关键事实来自该 RTL：
 *
 * - `always @(posedge clk)` 内 `reset > WE > 状态机` 三级互斥。**WE 周期完全抑制
 *   状态机**（`else if(WE)`），这就是"所有寄存器写均优先于设备同周期自动更新"。
 * - `IRQ = ctrl[3] & _IRQ` 是组合门控：清 IM 立即撤销可见请求。
 * - `load = Addr[3:2]==0 ? {28'h0, Din[3:0]} : Din`，即 CTRL 只保存低 4 位。
 * - `Dout = mem[Addr[3:2]]` 是组合读，读操作不推进任何状态。
 * - Mode 0（`ctrl[2:1]==2'b00`）在 `INT` 边清 Enable 并保留 pending IRQ；其余 mode
 *   清 pending IRQ。二者都回到 `IDLE`，因此周期模式还要再经历
 *   `IDLE -> LOAD -> CNT` 才重新装载，不存在"到零同边沿立即 reload"。
 *
 * COURSE-P7-TIMER-RESTART-001：定时器 PDF 与官方 RTL 在 Mode 0 重启时的 IRQ 清除
 * 时机上冲突，official-device lane 仲裁为 RTL，本实现照此执行并登记冲突。
 * COURSE-P7-TIMER-MODE-001：Mode 2/3 未定义，实现确定性地按 RTL 走，同时发出
 * `timer-mode-undefined` 事件，使 strict lane 能把该 case 判为 out-of-domain。
 */

export type TimerState = 'idle' | 'load' | 'cnt' | 'int';

/**
 * `CycleContract` revision, matching contract `COURSE-P7-TIMER-004` revision 2.
 * Device evidence buckets are fingerprinted with it and with nothing from the
 * assembler or the instruction executor.
 */
export const timerCycleContractRevision = 2 as const;

/** Register index derived from `Addr[3:2]`: 0 = CTRL, 1 = PRESET, 2 = COUNT. */
export const timerRegisterIndex = { ctrl: 0, preset: 1, count: 2 } as const;

export type TimerRegisterIndex = 0 | 1 | 2;

/** CTRL bit layout: bit3 = IM, bits2:1 = Mode, bit0 = Enable. */
export const timerControlBits = {
  enable: 0b0001,
  modeMask: 0b0110,
  modeShift: 1,
  interruptMask: 0b1000
} as const;

export interface TimerSnapshot {
  readonly state: TimerState;
  readonly ctrl: number;
  readonly preset: number;
  readonly count: number;
  readonly pendingIrq: boolean;
  readonly irq: boolean;
  readonly cycle: number;
  /** Bus writes staged but not yet consumed by a clock edge. */
  readonly pendingWriteEdges: number;
}

export class CourseTimerDevice {
  private state: TimerState = 'idle';
  private ctrl = 0;
  private preset = 0;
  private count = 0;
  private pendingIrq = false;
  private pendingWriteEdges = 0;
  private cycle = 0;

  constructor(readonly id: DeviceRegionId) {}

  reset(): void {
    this.state = 'idle';
    this.ctrl = 0;
    this.preset = 0;
    this.count = 0;
    this.pendingIrq = false;
    this.pendingWriteEdges = 0;
    this.cycle = 0;
  }

  /** `Dout = mem[Addr[3:2]]` — a combinational read that advances nothing. */
  read(register: TimerRegisterIndex): number {
    switch (register) {
      case timerRegisterIndex.ctrl:
        return this.ctrl;
      case timerRegisterIndex.preset:
        return this.preset;
      default:
        return this.count;
    }
  }

  /**
   * Apply one bus write. One clock edge is reserved: the RTL's `else if(WE)`
   * branch suppresses the state machine for that edge.
   *
   * Deliberate deviation from the RTL: the register file updates immediately here,
   * whereas `mem[Addr[3:2]] <= load` lands at the posedge. A read placed between
   * this call and the consuming `tick()` therefore observes the new value where the
   * RTL would still show the old one. That window is unreachable from a course
   * program — the `sw` *is* the WE edge and any load is a later cycle — and keeping
   * it coherent avoids a stale read in the architectural session, which has no
   * cycle domain of its own. Every post-edge state matches the RTL.
   */
  write(register: TimerRegisterIndex, value: number): DeviceEvent[] {
    const word = u32(value);
    switch (register) {
      case timerRegisterIndex.ctrl:
        this.ctrl = word & 0xf;
        break;
      case timerRegisterIndex.preset:
        this.preset = word;
        break;
      default:
        // COUNT is architecturally read-only: the CPU/bridge must raise AdES and
        // suppress the transaction before it reaches this port. Reaching here is
        // an engine bug, not a device behaviour.
        throw new Error(`${this.id}: COUNT is read-only and must be rejected before commit`);
    }
    this.pendingWriteEdges++;
    return [{
      kind: 'timer-register-write',
      device: this.id,
      address: register,
      value: register === timerRegisterIndex.ctrl ? this.ctrl : word,
      cycle: this.cycle
    }];
  }

  /** `IRQ = ctrl[3] & _IRQ`. */
  get irq(): boolean {
    return (this.ctrl & timerControlBits.interruptMask) !== 0 && this.pendingIrq;
  }

  private get enabled(): boolean {
    return (this.ctrl & timerControlBits.enable) !== 0;
  }

  private get mode(): number {
    return (this.ctrl & timerControlBits.modeMask) >>> timerControlBits.modeShift;
  }

  /** Advance exactly one clock edge and return the observable device events. */
  tick(): DeviceEvent[] {
    const irqBefore = this.irq;
    const stateBefore = this.state;
    const events: DeviceEvent[] = [];
    this.cycle++;

    if (this.pendingWriteEdges > 0) {
      // `else if(WE)`: a write edge never runs the state machine.
      this.pendingWriteEdges--;
      this.emitIrqTransition(events, irqBefore);
      return events;
    }

    switch (this.state) {
      case 'idle':
        // `IDLE: if(ctrl[0]) begin state <= LOAD; _IRQ <= 1'b0; end`
        if (this.enabled) {
          this.state = 'load';
          this.pendingIrq = false;
        }
        break;
      case 'load':
        this.count = this.preset;
        this.state = 'cnt';
        break;
      case 'cnt':
        if (this.enabled) {
          if (u32(this.count) > 1) {
            this.count = u32(this.count - 1);
          } else {
            this.count = 0;
            this.state = 'int';
            this.pendingIrq = true;
          }
        } else {
          this.state = 'idle';
        }
        break;
      default: {
        // `INT`: mode 0 clears Enable and keeps the pending request; every other
        // mode clears the pending request instead.
        if (this.mode === 0) {
          this.ctrl = u32(this.ctrl & ~timerControlBits.enable) & 0xf;
        } else {
          this.pendingIrq = false;
          if (this.mode > 1) {
            events.push({
              kind: 'timer-mode-undefined',
              device: this.id,
              value: this.mode,
              cycle: this.cycle,
              detail: 'COURSE-P7-TIMER-MODE-001: Mode 2/3 未定义，结果不得作为严格 expected'
            });
          }
        }
        this.state = 'idle';
        break;
      }
    }

    if (this.state !== stateBefore) {
      events.push({
        kind: 'timer-state-transition',
        device: this.id,
        cycle: this.cycle,
        detail: `${stateBefore} -> ${this.state}`
      });
    }
    this.emitIrqTransition(events, irqBefore);
    return events;
  }

  private emitIrqTransition(events: DeviceEvent[], irqBefore: boolean): void {
    const irqAfter = this.irq;
    if (irqAfter === irqBefore) {
      return;
    }
    events.push({
      kind: irqAfter ? 'timer-irq-asserted' : 'timer-irq-cleared',
      device: this.id,
      cycle: this.cycle
    });
  }

  snapshot(): TimerSnapshot {
    return {
      state: this.state,
      ctrl: this.ctrl,
      preset: this.preset,
      count: this.count,
      pendingIrq: this.pendingIrq,
      irq: this.irq,
      cycle: this.cycle,
      pendingWriteEdges: this.pendingWriteEdges
    };
  }
}
