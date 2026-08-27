// @index mips-core — DeviceBusPort：MMIO prepare/read/commit/abort 与显式 tickDevices 周期推进
import { DeviceEvent } from '../events/commitEvent';
import {
  AccessWidth,
  DeviceRegionId,
  ExceptionPolicy,
  HardwareInterruptWiring
} from '../profiles/profile';
import { u32 } from '../values';
import {
  aggregateHardwareInterrupts,
  ExternalInterruptRequest,
  InterruptGeneratorDevice
} from './interruptController';
import { CourseTimerDevice, TimerRegisterIndex, TimerSnapshot, timerRegisterIndex } from './timer';

/**
 * `DeviceBusPort` 把"事务合法性"与"时间推进"彻底分开（计划第 5.3 节）：
 * `prepare/read/commit/abort` 都不推进 Timer，只有显式 `tickDevices` 才推进周期。
 * 这样异常受害指令的设备写可以被 `abort` 抑制，而一次 `lw/sw` 也不会被伪装成
 * 一个流水线周期。
 */

export interface DeviceAccess {
  readonly kind: 'load' | 'store';
  readonly device: DeviceRegionId;
  /** Raw effective address produced by the instruction. */
  readonly address: number;
  readonly width: AccessWidth;
  /** Store payload; absent for loads. */
  readonly value?: number;
}

export interface PreparedDeviceAccess {
  readonly access: DeviceAccess;
  /** Timer register selected by `Addr[3:2]`; absent for the interrupt generator. */
  readonly register?: TimerRegisterIndex;
}

export type DeviceFaultReason =
  | 'count-write'
  | 'unsupported-width'
  | 'unmapped'
  | 'schedule-missing';

export interface DeviceAccessFault {
  readonly fault: DeviceFaultReason;
  readonly message: string;
}

export function isDeviceAccessFault(
  value: PreparedDeviceAccess | DeviceAccessFault
): value is DeviceAccessFault {
  return (value as DeviceAccessFault).fault !== undefined;
}

export interface DeviceCycleInput {
  /** Number of clock edges to advance; defaults to one. */
  readonly cycles?: number;
  readonly reset?: boolean;
}

export interface DeviceCycleResult {
  readonly hardwareInterrupts: number;
  readonly events: readonly DeviceEvent[];
  readonly cycles: number;
}

export interface DeviceSnapshot {
  readonly timer0: TimerSnapshot;
  readonly timer1: TimerSnapshot;
  readonly externalInterrupt: boolean;
  readonly hardwareInterrupts: number;
}

export interface DeviceBusPort {
  prepare(access: DeviceAccess): PreparedDeviceAccess | DeviceAccessFault;
  read(prepared: PreparedDeviceAccess): number;
  commit(prepared: PreparedDeviceAccess): readonly DeviceEvent[];
  abort(prepared: PreparedDeviceAccess): void;
  sampleInterrupts(): number;
  /**
   * Offer the macroscopic PC of the instruction about to commit. Ports without a
   * PC-triggered interrupt source may omit it.
   */
  observeMacroPc?(pc: number): readonly DeviceEvent[];
}

export interface CourseDeviceBusOptions {
  readonly externalInterrupts?: readonly ExternalInterruptRequest[];
  /**
   * `false` for an architectural anchor that declares no device cycle schedule.
   * Timer transactions then fail closed as out-of-domain instead of silently
   * pretending that one instruction equals one Timer clock edge (计划第 5.5 节).
   */
  readonly timersEnabled?: boolean;
}

/** Timer0 + Timer1 + interrupt generator behind the course system bridge. */
export class CourseDeviceBus implements DeviceBusPort {
  readonly timer0 = new CourseTimerDevice('timer0');
  readonly timer1 = new CourseTimerDevice('timer1');
  readonly interruptGenerator: InterruptGeneratorDevice;
  private readonly wiring: HardwareInterruptWiring;
  private readonly timersEnabled: boolean;
  private cycles = 0;

  constructor(policy: ExceptionPolicy, options: CourseDeviceBusOptions = {}) {
    this.wiring = policy.wiring;
    this.timersEnabled = options.timersEnabled ?? true;
    this.interruptGenerator = new InterruptGeneratorDevice(options.externalInterrupts ?? []);
  }

  prepare(access: DeviceAccess): PreparedDeviceAccess | DeviceAccessFault {
    if (access.device === 'interrupt-generator') {
      return { access };
    }
    if (!this.timersEnabled) {
      return {
        fault: 'schedule-missing',
        message: `${access.device}: 本次运行没有声明设备 cycle schedule，计时器事务不属于可比较域`
      };
    }
    const register = ((u32(access.address) >>> 2) & 0x3) as TimerRegisterIndex | 3;
    if (register === 3) {
      return { fault: 'unmapped', message: `${access.device}: 地址 0x${u32(access.address).toString(16)} 不对应任何计时器寄存器` };
    }
    if (access.kind === 'store' && register === timerRegisterIndex.count) {
      // COUNT is read-only; the transaction must be suppressed before it reaches
      // the device (P7-2-3 存数异常表, 计划第 3.3 节).
      return {
        fault: 'count-write',
        message: `${access.device}: COUNT 寄存器只读，写入必须产生 AdES 并在设备提交前被抑制`
      };
    }
    return { access, register };
  }

  read(prepared: PreparedDeviceAccess): number {
    if (prepared.access.device === 'interrupt-generator') {
      return this.interruptGenerator.read();
    }
    const timer = this.timerFor(prepared.access.device);
    return timer.read(prepared.register ?? timerRegisterIndex.ctrl);
  }

  commit(prepared: PreparedDeviceAccess): readonly DeviceEvent[] {
    const { access } = prepared;
    if (access.kind !== 'store') {
      if (access.device === 'interrupt-generator') {
        return [];
      }
      return [{
        kind: 'timer-register-read',
        device: access.device,
        address: u32(access.address),
        value: this.read(prepared)
      }];
    }
    if (access.device === 'interrupt-generator') {
      return this.interruptGenerator.acknowledge(u32(access.address));
    }
    const timer = this.timerFor(access.device);
    return timer.write(prepared.register ?? timerRegisterIndex.ctrl, access.value ?? 0);
  }

  /** Suppressed transaction: the device observed nothing at all. */
  abort(_prepared: PreparedDeviceAccess): void {
    // Intentionally empty: `prepare` never mutates device state, so aborting a
    // prepared access is a no-op. The method exists so callers cannot forget the
    // suppression path exists.
  }

  sampleInterrupts(): number {
    return aggregateHardwareInterrupts(this.wiring, {
      timer0: this.timer0,
      timer1: this.timer1,
      interruptGenerator: this.interruptGenerator
    });
  }

  /** Advance the device clock domain; the architectural session never does this implicitly. */
  tickCycle(input: DeviceCycleInput = {}): DeviceCycleResult {
    if (input.reset) {
      this.timer0.reset();
      this.timer1.reset();
      this.interruptGenerator.reset();
      this.cycles = 0;
      return { hardwareInterrupts: 0, events: [], cycles: 0 };
    }
    const requested = input.cycles ?? 1;
    if (!Number.isSafeInteger(requested) || requested < 0) {
      throw new Error(`tickCycle: cycles must be a non-negative safe integer, got ${requested}`);
    }
    const events: DeviceEvent[] = [];
    for (let index = 0; index < requested; index++) {
      events.push(...this.timer0.tick(), ...this.timer1.tick());
      this.cycles++;
    }
    return {
      hardwareInterrupts: this.sampleInterrupts(),
      events,
      cycles: this.cycles
    };
  }

  /** Offer the macroscopic PC of the instruction about to commit. */
  observeMacroPc(pc: number): readonly DeviceEvent[] {
    return this.interruptGenerator.observeMacroPc(pc);
  }

  snapshot(): DeviceSnapshot {
    return {
      timer0: this.timer0.snapshot(),
      timer1: this.timer1.snapshot(),
      externalInterrupt: this.interruptGenerator.irq,
      hardwareInterrupts: this.sampleInterrupts()
    };
  }

  private timerFor(device: DeviceRegionId): CourseTimerDevice {
    if (device === 'timer0') {
      return this.timer0;
    }
    if (device === 'timer1') {
      return this.timer1;
    }
    throw new Error(`device ${device} is not a timer`);
  }
}
