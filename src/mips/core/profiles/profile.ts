// @index mips-core — 课程执行 profile 契约：地址空间、延迟槽/link、溢出、异常与 trace 投影策略
import { CourseProfile, InstructionLayer } from '../generated/isaCatalog';

/**
 * `CourseExecutionProfile` 是执行核心唯一的 profile 参数化入口（计划第 5.5 节）。
 *
 * P3/P4/P5/P6/P7 不得通过散落的 `if (profile === ...)` 修改状态机：状态机只读
 * 本文件的数据。每个字段都直接对应一条可追溯的课程条款，便于 mutation 测试
 * 逐字段验证（例如 link 偏移差 4、延迟槽开关、溢出策略互换）。
 */

/** Inclusive address range in the flat course address space. */
export interface AddressRange {
  /** First byte address (inclusive). */
  readonly start: number;
  /** Last byte address (inclusive). */
  readonly endInclusive: number;
}

/** Stable ids of the architectural memory regions. */
export type MemoryRegionId = 'text' | 'data';

/** Stable ids of the P7 memory-mapped devices. */
export type DeviceRegionId = 'timer0' | 'timer1' | 'interrupt-generator';

/** Any addressable region the machine can classify an effective address into. */
export type RegionId = MemoryRegionId | DeviceRegionId;

/** Access widths in bytes accepted by a region; anything else is an address error. */
export type AccessWidth = 1 | 2 | 4;

export interface MemoryRegion {
  readonly id: MemoryRegionId;
  readonly range: AddressRange;
  readonly acceptedWidths: readonly AccessWidth[];
  /** `true` for the instruction segment: data accesses never resolve here. */
  readonly instructionOnly: boolean;
}

export interface DeviceRegion {
  readonly id: DeviceRegionId;
  readonly range: AddressRange;
  /**
   * Timer/IG registers are word ports: `lb/lh/sb/sh` against them is an address
   * error even when the byte address itself is inside the range (P7-2-3 表 4/5).
   */
  readonly acceptedWidths: readonly AccessWidth[];
}

/** Architectural state right after reset, before the first fetch. */
export interface ResetState {
  readonly pc: number;
  /** 32 GPR reset values; `$0` is always zero and never written. */
  readonly gpr: readonly number[];
  readonly hi: number;
  readonly lo: number;
  /**
   * `false` when HI/LO hold no architecturally defined value yet. Reading them
   * before a defining write is UNPREDICTABLE, so strict comparison excludes the
   * result instead of blessing one implementation's reset value.
   */
  readonly hiLoDefined: boolean;
  readonly cp0Status: number;
  readonly cp0Cause: number;
  readonly cp0Epc: number;
}

/** `add/addi/sub` behaviour on signed 32-bit overflow. */
export type OverflowPolicy = 'wrap' | 'trap';

/** Course exception codes written into `Cause.ExcCode` (P7-2-3, P7-2-6). */
export const courseExceptionCodes = {
  int: 0,
  adel: 4,
  ades: 5,
  syscall: 8,
  ri: 10,
  ov: 12
} as const;

export type CourseExceptionName = keyof typeof courseExceptionCodes;

/** CP0 register numbers implemented by the course contract. */
export const cp0RegisterNumbers = { status: 12, cause: 13, epc: 14 } as const;

export interface Cp0Policy {
  /** Common entry point for every exception and interrupt (P7-2-6). */
  readonly handlerPc: number;
  /** Bits of SR that `mtc0` may change; all other bits stay zero. */
  readonly statusWritableMask: number;
  /** Bits of Cause that `mtc0` may change; the course never writes Cause. */
  readonly causeWritableMask: number;
  /** Bits of EPC that `mtc0` may change. */
  readonly epcWritableMask: number;
  /** SR.IM field mask (bits 15:10). */
  readonly statusInterruptMaskBits: number;
  /** SR.EXL bit (bit 1). */
  readonly statusExceptionLevelBit: number;
  /** SR.IE bit (bit 0). */
  readonly statusInterruptEnableBit: number;
  /** Cause.BD bit (bit 31). */
  readonly causeBranchDelayBit: number;
  /** Cause.IP field mask (bits 15:10), rewritten from HWInt every cycle. */
  readonly causeInterruptPendingBits: number;
  /** Cause.ExcCode field mask (bits 6:2). */
  readonly causeExceptionCodeBits: number;
  /** Bit position of the low ExcCode bit inside Cause. */
  readonly causeExceptionCodeShift: number;
  /** CP0 registers `mfc0` may read. */
  readonly readableRegisters: readonly number[];
  /** CP0 registers `mtc0` may write. */
  readonly writableRegisters: readonly number[];
}

/** Which HWInt line each device drives (P7-2-6 中断规范). */
export interface HardwareInterruptWiring {
  readonly timer0Bit: number;
  readonly timer1Bit: number;
  readonly interruptGeneratorBit: number;
}

export interface ExceptionPolicy {
  readonly cp0: Cp0Policy;
  readonly wiring: HardwareInterruptWiring;
  /**
   * Instruction-fetch address errors, RI, Ov and address errors all arbitrate at
   * one commit point; the earliest non-zero stage code for one victim wins
   * (`F > D > E > M`, COURSE-P7-EXC-PRIORITY-001).
   */
  readonly stagePriority: readonly ExceptionStage[];
  /** `eret` clears EXL and jumps to EPC without executing a delay slot. */
  readonly eretHasDelaySlot: false;
}

/** Detection stage of one architectural exception, ordered oldest-first. */
export type ExceptionStage = 'fetch' | 'decode' | 'execute' | 'memory';

/**
 * Course trace projection (P3-4 `@%h: ...`, P5-7 `%d@%h: ...`).
 *
 * The oracle has no cycle domain, so it never fabricates the `$time` prefix; the
 * DUT side emits it and comparison ignores it. `wordAlignedStores` mirrors the
 * official testbench, which logs `m_data_addr & ~3` together with the byte-enable
 * merged word rather than the raw `sb/sh` address and value.
 */
export interface TraceProjectionPolicy {
  /** `true` when the DUT trace carries a leading `<time>@` prefix (P5 and later). */
  readonly dutCyclePrefix: boolean;
  /** Store events are projected onto the aligned word address and merged word. */
  readonly wordAlignedStores: boolean;
  /** Writes to `$0` are never logged by the course GRF module. */
  readonly suppressZeroRegisterWrites: true;
}

/**
 * Standard course completion: a self-targeting `beq` (`0x1000ffff`) plus, on
 * delay-slot profiles, its delay-slot `nop` (COURSE-P56-DOMAIN-001). The detector
 * only stops after the whole sequence committed; seeing the branch PC alone is
 * not sufficient.
 */
export interface HaltPolicy {
  readonly selfBranchWord: number;
  readonly delaySlotWord: number;
  /** `true` when the delay-slot `nop` must commit before the run stops. */
  readonly requireDelaySlotCommit: boolean;
}

export interface CourseExecutionProfile {
  readonly id: CourseProfile;
  /** Instruction layers recognised at runtime; drives P7 RI classification. */
  readonly defaultLayers: readonly InstructionLayer[];
  /** Exactly one delay slot for every control transfer, or none at all. */
  readonly delaySlot: boolean;
  /**
   * Value written by `jal/jalr/bltzal/bgezal`. Without a delay slot the return
   * address is `pc + 4`; with one it is `pc + 8` (P5-2, COURSE-P3-DELAY-001).
   */
  readonly linkOffset: 4 | 8;
  readonly overflow: OverflowPolicy;
  readonly reset: ResetState;
  readonly memoryRegions: readonly MemoryRegion[];
  readonly deviceRegions: readonly DeviceRegion[];
  /** Present exactly when the profile models architectural exceptions (P7). */
  readonly exceptions?: ExceptionPolicy;
  readonly trace: TraceProjectionPolicy;
  readonly halt: HaltPolicy;
}

/** Locate the region owning `address`, or `undefined` when it is unmapped. */
export function regionForAddress(
  profile: CourseExecutionProfile,
  address: number
): MemoryRegion | DeviceRegion | undefined {
  const value = address >>> 0;
  for (const region of profile.memoryRegions) {
    if (value >= region.range.start && value <= region.range.endInclusive) {
      return region;
    }
  }
  for (const region of profile.deviceRegions) {
    if (value >= region.range.start && value <= region.range.endInclusive) {
      return region;
    }
  }
  return undefined;
}

/** True when the region is a memory-mapped device rather than DM/IM. */
export function isDeviceRegion(
  region: MemoryRegion | DeviceRegion
): region is DeviceRegion {
  return region.id === 'timer0' || region.id === 'timer1'
    || region.id === 'interrupt-generator';
}

/** Number of storage words in a memory region. */
export function regionWordCount(region: MemoryRegion): number {
  return ((region.range.endInclusive - region.range.start + 1) >>> 0) / 4;
}
