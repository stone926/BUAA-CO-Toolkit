// @index mips-core — 冻结的 P3–P7 课程执行 profile 数据（唯一 profile 事实来源）
import { CourseProfile, InstructionLayer, isaProfilePolicies } from '../generated/isaCatalog';
import {
  CourseExecutionProfile,
  DeviceRegion,
  ExceptionPolicy,
  HaltPolicy,
  MemoryRegion,
  ResetState,
  TraceProjectionPolicy
} from './profile';

/**
 * 课程地址空间与执行策略（[P7-2-2] 系统桥地址表、[P6-1]/[P5-5-2] 存储器容量、
 * [P4-1] "不考虑延迟槽"、[P6-1] "所有运算类指令均暂不考虑因溢出而产生的异常"）。
 *
 * 这些常量是课程契约的机器可读投影，不是实现细节：修改它们等同于修改课程规范，
 * 必须同时更新 conformance contract ledger。
 */

/** DM: 12 KiB = 3,072 words. */
const dataMemory: MemoryRegion = {
  id: 'data',
  range: { start: 0x0000_0000, endInclusive: 0x0000_2fff },
  acceptedWidths: [1, 2, 4],
  instructionOnly: false
};

/** IM: 16 KiB = 4,096 words; last valid instruction word is 0x6ffc. */
const instructionMemory: MemoryRegion = {
  id: 'text',
  range: { start: 0x0000_3000, endInclusive: 0x0000_6fff },
  acceptedWidths: [4],
  instructionOnly: true
};

const courseMemoryRegions: readonly MemoryRegion[] = [dataMemory, instructionMemory];

/** Timer register ports are word-only: `lb/lh/sb/sh` against them is an address error. */
const timer0Region: DeviceRegion = {
  id: 'timer0',
  range: { start: 0x0000_7f00, endInclusive: 0x0000_7f0b },
  acceptedWidths: [4]
};

const timer1Region: DeviceRegion = {
  id: 'timer1',
  range: { start: 0x0000_7f10, endInclusive: 0x0000_7f1b },
  acceptedWidths: [4]
};

/**
 * The interrupt generator has no storage: reads are always zero and a write of any
 * width acknowledges the pending external request. The official corpus uses
 * `sb $0, 0x7f20($0)`, so byte access must stay legal here even though the same
 * width against a Timer register is an address error.
 */
const interruptGeneratorRegion: DeviceRegion = {
  id: 'interrupt-generator',
  range: { start: 0x0000_7f20, endInclusive: 0x0000_7f23 },
  acceptedWidths: [1, 2, 4]
};

const p7DeviceRegions: readonly DeviceRegion[] = [
  timer0Region,
  timer1Region,
  interruptGeneratorRegion
];

/** Reset: PC = 0x3000, GPR/DM zero, HI/LO architecturally undefined, CP0 zero. */
const courseReset: ResetState = {
  pc: 0x0000_3000,
  gpr: Object.freeze(new Array<number>(32).fill(0)),
  hi: 0,
  lo: 0,
  hiLoDefined: false,
  cp0Status: 0,
  cp0Cause: 0,
  cp0Epc: 0
};

/** `beq $0, $0, -1` — the self-targeting course completion branch. */
export const courseHaltBranchWord = 0x1000ffff;

function haltPolicy(delaySlot: boolean): HaltPolicy {
  return {
    selfBranchWord: courseHaltBranchWord,
    delaySlotWord: 0x0000_0000,
    requireDelaySlotCommit: delaySlot
  };
}

function traceProjection(dutCyclePrefix: boolean): TraceProjectionPolicy {
  return {
    dutCyclePrefix,
    wordAlignedStores: true,
    suppressZeroRegisterWrites: true
  };
}

/** CP0/exception contract frozen by P7-2-3, P7-2-4 and P7-2-6. */
const p7ExceptionPolicy: ExceptionPolicy = {
  cp0: {
    handlerPc: 0x0000_4180,
    // SR: IM(15:10) | EXL(1) | IE(0). Every other bit is unimplemented and reads zero.
    statusWritableMask: 0x0000_fc03,
    // The course guarantees test programs never write Cause; mtc0 cannot target it either.
    causeWritableMask: 0x0000_0000,
    epcWritableMask: 0xffff_ffff,
    statusInterruptMaskBits: 0x0000_fc00,
    statusExceptionLevelBit: 0x0000_0002,
    statusInterruptEnableBit: 0x0000_0001,
    causeBranchDelayBit: 0x8000_0000,
    causeInterruptPendingBits: 0x0000_fc00,
    causeExceptionCodeBits: 0x0000_007c,
    causeExceptionCodeShift: 2,
    readableRegisters: [12, 13, 14],
    writableRegisters: [12, 14]
  },
  wiring: { timer0Bit: 0, timer1Bit: 1, interruptGeneratorBit: 2 },
  stagePriority: ['fetch', 'decode', 'execute', 'memory'],
  eretHasDelaySlot: false
};

const defaultLayers: readonly InstructionLayer[] = ['required', 'commonExtensions'];

function courseProfile(
  id: CourseProfile,
  overrides: {
    readonly deviceRegions?: readonly DeviceRegion[];
    readonly exceptions?: ExceptionPolicy;
    readonly dutCyclePrefix: boolean;
  }
): CourseExecutionProfile {
  const delaySlot = isaProfilePolicies[id].controlTransferDelaySlot;
  return {
    id,
    defaultLayers,
    delaySlot,
    linkOffset: delaySlot ? 8 : 4,
    overflow: isaProfilePolicies[id].architecturalExceptions ? 'trap' : 'wrap',
    reset: courseReset,
    memoryRegions: courseMemoryRegions,
    deviceRegions: overrides.deviceRegions ?? [],
    ...(overrides.exceptions ? { exceptions: overrides.exceptions } : {}),
    trace: traceProjection(overrides.dutCyclePrefix),
    halt: haltPolicy(delaySlot)
  };
}

/**
 * P3/P4 GRF/DM modules print `@%h: ...`; P5 and later add the `%d@` `$time`
 * prefix ([P4-7], [P5-5-2]). The oracle never fabricates a cycle number, so the
 * flag only records what the DUT side is expected to emit.
 */
export const courseExecutionProfiles: Readonly<Record<CourseProfile, CourseExecutionProfile>> = {
  P3: courseProfile('P3', { dutCyclePrefix: false }),
  P4: courseProfile('P4', { dutCyclePrefix: false }),
  P5: courseProfile('P5', { dutCyclePrefix: true }),
  P6: courseProfile('P6', { dutCyclePrefix: true }),
  P7: courseProfile('P7', {
    dutCyclePrefix: true,
    deviceRegions: p7DeviceRegions,
    exceptions: p7ExceptionPolicy
  })
};

/** Resolve a frozen course profile by id. */
export function resolveCourseProfile(id: CourseProfile): CourseExecutionProfile {
  return courseExecutionProfiles[id];
}

/** Course profile ids in tutorial order. */
export const courseProfileIds: readonly CourseProfile[] = ['P3', 'P4', 'P5', 'P6', 'P7'];
