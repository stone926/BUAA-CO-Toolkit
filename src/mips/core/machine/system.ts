// @index mips-core — CourseSystemSession：组合架构 step 与显式设备周期推进（不伪造时间映射）
import { ProgramImage } from '../api';
import {
  CourseDeviceBus,
  DeviceCycleInput,
  DeviceCycleResult,
  DeviceSnapshot
} from '../devices/deviceBus';
import { ExternalInterruptRequest } from '../devices/interruptController';
import { StepResult } from '../events/commitEvent';
import { InstructionLayer } from '../generated/isaCatalog';
import { CourseExecutionProfile } from '../profiles/profile';
import { UnloadedInstructionPolicy } from './memoryBus';
import {
  MachineSession,
  MachineSnapshot,
  SnapshotLevel,
  StepInput
} from './session';
import { UndefinedBehaviorPolicy } from './transition';

/**
 * `CourseSystemSession` 只负责"组合"（计划第 5.3 节）：架构 step 在指令边界采样
 * IRQ，设备时间域只在显式 `tickDevices` 或 case 提供的 `deviceTimeline` 上推进。
 *
 * 它刻意 **不** 提供"每指令 tick"选项：教程没有定义流水线 commit 与 Timer 时钟的
 * 映射，那属于真实 DUT 的 scenario property，不属于顺序 oracle
 * （计划第 5.5 节与阶段 3 退出标准）。
 */

export interface DeviceTimelineEntry {
  /**
   * Number of instructions that must already have committed before these device
   * cycles run. The boundary is checked before each `stepInstruction`.
   */
  readonly afterInstruction: number;
  readonly cycles: number;
}

export type DeviceSchedule =
  /** Architectural anchor: Timer transactions are out of the comparable domain. */
  | { readonly kind: 'disabled' }
  /** Explicit instruction-boundary cycle advances supplied by the case input. */
  | { readonly kind: 'timeline'; readonly entries: readonly DeviceTimelineEntry[] };

export interface CourseSystemSessionOptions {
  readonly profile: CourseExecutionProfile;
  readonly image: ProgramImage;
  readonly layers?: readonly InstructionLayer[];
  readonly undefinedBehavior?: UndefinedBehaviorPolicy;
  readonly unloadedInstruction?: UnloadedInstructionPolicy;
  readonly maxSteps?: number;
  readonly haltPc?: number;
  readonly externalInterrupts?: readonly ExternalInterruptRequest[];
  /** Defaults to `{ kind: 'disabled' }`. */
  readonly deviceSchedule?: DeviceSchedule;
}

export interface CourseSystemSnapshot extends MachineSnapshot {
  readonly devices?: DeviceSnapshot;
}

export class CourseSystemSession {
  readonly machine: MachineSession;
  readonly devices: CourseDeviceBus | undefined;
  private readonly schedule: DeviceSchedule;
  private timelineIndex = 0;

  constructor(private readonly options: CourseSystemSessionOptions) {
    const { profile } = options;
    this.schedule = options.deviceSchedule ?? { kind: 'disabled' };
    this.devices = profile.exceptions
      ? new CourseDeviceBus(profile.exceptions, {
        externalInterrupts: options.externalInterrupts ?? [],
        timersEnabled: this.schedule.kind !== 'disabled'
      })
      : undefined;
    this.machine = new MachineSession({
      profile,
      image: options.image,
      ...(options.layers ? { layers: options.layers } : {}),
      ...(options.undefinedBehavior ? { undefinedBehavior: options.undefinedBehavior } : {}),
      ...(options.unloadedInstruction ? { unloadedInstruction: options.unloadedInstruction } : {}),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.haltPc === undefined ? {} : { haltPc: options.haltPc }),
      ...(this.devices ? { devices: this.devices } : {})
    });
  }

  /** Run any device cycles the timeline schedules for this boundary, then step once. */
  stepInstruction(input: StepInput = {}): StepResult {
    this.advanceScheduledCycles();
    return this.machine.stepInstruction(input);
  }

  /** Explicitly advance the device clock domain. */
  tickDevices(input: DeviceCycleInput = {}): DeviceCycleResult {
    if (!this.devices) {
      return { hardwareInterrupts: 0, events: [], cycles: 0 };
    }
    return this.devices.tickCycle(input);
  }

  snapshot(level: SnapshotLevel = 'registers'): CourseSystemSnapshot {
    const machine = this.machine.snapshot(level);
    return this.devices ? { ...machine, devices: this.devices.snapshot() } : machine;
  }

  get instructionsExecuted(): number {
    return this.machine.instructionsExecuted;
  }

  get done(): boolean {
    return this.machine.done;
  }

  /** PC of the validated course halt-loop self-branch; see `MachineSession`. */
  get courseHaltPc(): number | undefined {
    return this.machine.courseHaltPc;
  }

  private advanceScheduledCycles(): void {
    if (this.schedule.kind !== 'timeline' || !this.devices) {
      return;
    }
    const executed = this.machine.instructionsExecuted;
    while (this.timelineIndex < this.schedule.entries.length) {
      const entry = this.schedule.entries[this.timelineIndex];
      if (entry.afterInstruction > executed) {
        return;
      }
      this.timelineIndex++;
      if (entry.cycles > 0) {
        this.devices.tickCycle({ cycles: entry.cycles });
      }
    }
  }

  /** Profile this session executes; part of every evidence fingerprint. */
  get profile(): CourseExecutionProfile {
    return this.options.profile;
  }
}
