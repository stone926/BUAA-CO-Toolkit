// @index mips-core — 外部中断发生器与 HWInt 聚合（宏观 victim PC + occurrence 计划）
import { DeviceEvent } from '../events/commitEvent';
import { HardwareInterruptWiring } from '../profiles/profile';
import { CourseTimerDevice } from './timer';
import { u32 } from '../values';

/**
 * 中断发生器（IG）没有存储单元：读恒为 0，写只用于应答（P7-2-6 硬件约束）。
 * 官方 tb 在宏观 PC 命中目标时拉高 `interrupt`，并在
 * `|m_int_byteen && (m_int_addr & ~3) == 0x7f20` 时清除。
 *
 * 计划第 6 节要求外部 IRQ 用"宏观 victim PC + occurrence"表达，而不是旧的
 * `p7irq - 4`：schedule 直接指名受害指令，因此架构 anchor 不需要推导流水级到
 * 时钟周期的映射（那属于 DUT scenario property，不属于顺序 oracle）。
 */

export interface ExternalInterruptRequest {
  /** Macroscopic PC of the instruction that must become the interrupt victim. */
  readonly victimPc: number;
  /** 1-based occurrence of that macroscopic PC; the demo tb uses occurrence 1. */
  readonly occurrence: number;
}

export class InterruptGeneratorDevice {
  private asserted = false;
  private readonly observations = new Map<number, number>();

  constructor(private readonly schedule: readonly ExternalInterruptRequest[] = []) {}

  reset(): void {
    this.asserted = false;
    this.observations.clear();
  }

  get irq(): boolean {
    return this.asserted;
  }

  /** IG has no storage: every read returns zero (P7-2-6). */
  read(): number {
    return 0;
  }

  /**
   * Offer the macroscopic PC of the instruction the machine is about to commit.
   *
   * While a request is already pending the official tb skips the PC comparison
   * entirely, so the occurrence counter does not advance either; a retried victim
   * therefore cannot consume a second schedule entry.
   */
  observeMacroPc(pc: number): DeviceEvent[] {
    if (this.asserted || this.schedule.length === 0) {
      return [];
    }
    const address = u32(pc);
    const occurrence = (this.observations.get(address) ?? 0) + 1;
    this.observations.set(address, occurrence);
    const matched = this.schedule.some((entry) =>
      u32(entry.victimPc) === address && entry.occurrence === occurrence);
    if (!matched) {
      return [];
    }
    this.asserted = true;
    return [{
      kind: 'external-interrupt-asserted',
      device: 'interrupt-generator',
      address,
      value: occurrence
    }];
  }

  /** Any store to `0x7f20..0x7f23` with a non-zero byte enable acknowledges. */
  acknowledge(address: number): DeviceEvent[] {
    const wasAsserted = this.asserted;
    this.asserted = false;
    return [{
      kind: 'interrupt-generator-ack',
      device: 'interrupt-generator',
      address: u32(address),
      value: wasAsserted ? 1 : 0
    }];
  }
}

/**
 * HWInt aggregation: Timer0 drives bit 0, Timer1 drives bit 1 and the interrupt
 * generator drives bit 2 (P7-2-6 中断规范). Bits 3..5 exist in `SR.IM`/`Cause.IP`
 * but no course device drives them.
 */
export function aggregateHardwareInterrupts(
  wiring: HardwareInterruptWiring,
  devices: {
    readonly timer0?: CourseTimerDevice;
    readonly timer1?: CourseTimerDevice;
    readonly interruptGenerator?: InterruptGeneratorDevice;
  }
): number {
  let value = 0;
  if (devices.timer0?.irq) {
    value |= 1 << wiring.timer0Bit;
  }
  if (devices.timer1?.irq) {
    value |= 1 << wiring.timer1Bit;
  }
  if (devices.interruptGenerator?.irq) {
    value |= 1 << wiring.interruptGeneratorBit;
  }
  return value & 0x3f;
}
