// @index mips-core — Ordinary MARS memory/reset policy using the shared ISA machine
import { getMarsMemoryLayout, MarsMemoryConfiguration } from '../profiles/marsMemoryLayout';
import { CourseExecutionProfile, MemoryRegion } from '../profiles/profile';

/** MARS Memory.java's 1024 blocks of 1024 words per segment. */
export const marsMemoryCapacityBytes = 4_194_304;

export function createMarsProfile(
  configuration: MarsMemoryConfiguration = 'Default',
  delayedBranching = false
): CourseExecutionProfile {
  const layout = getMarsMemoryLayout(configuration);
  const gpr = new Array<number>(32).fill(0);
  gpr[28] = layout.globalPointer;
  gpr[29] = layout.stackPointer;
  const compact = configuration !== 'Default';
  const memoryRegions: MemoryRegion[] = [
    { id: 'text', range: { start: layout.sectionLayout.text.base, endInclusive: Math.min(layout.sectionLayout.text.endInclusive + 3, layout.sectionLayout.text.base + marsMemoryCapacityBytes - 1) }, acceptedWidths: [4], instructionOnly: true },
    { id: 'data', range: { start: layout.dataSegmentBase, endInclusive: Math.min(layout.sectionLayout.data.endInclusive, layout.dataSegmentBase + marsMemoryCapacityBytes - 1) }, acceptedWidths: [1, 2, 4], instructionOnly: false },
    { id: 'ktext', range: { start: layout.sectionLayout.ktext.base, endInclusive: Math.min(layout.sectionLayout.ktext.endInclusive + 3, layout.sectionLayout.ktext.base + marsMemoryCapacityBytes - 1) }, acceptedWidths: [4], instructionOnly: true },
    { id: 'kdata', range: { start: layout.kernelDataBase, endInclusive: Math.min(layout.kernelDataEndInclusive, layout.kernelDataBase + marsMemoryCapacityBytes - 1) }, acceptedWidths: [1, 2, 4], instructionOnly: false }
  ];
  if (!compact) {
    memoryRegions.push({ id: 'stack', range: { start: layout.stackBase - marsMemoryCapacityBytes + 4, endInclusive: layout.stackBase + 3 }, acceptedWidths: [1, 2, 4], instructionOnly: false });
  }
  return {
    // P7 selects the complete integer catalog; ordinary CP0/services are explicit policies.
    id: 'P7',
    defaultLayers: ['required', 'commonExtensions', 'marsCompatibility'],
    delaySlot: delayedBranching,
    linkOffset: delayedBranching ? 8 : 4,
    overflow: 'trap',
    effectiveAddressOverflow: 'wrap',
    syscallMode: 'services',
    reset: {
      pc: layout.sectionLayout.text.base,
      gpr, hi: 0, lo: 0, hiLoDefined: true,
      cp0Status: 0x0000ff11, cp0Cause: 0, cp0Epc: 0
    },
    memoryRegions,
    deviceRegions: [],
    exceptions: {
      unhandled: 'fault',
      preserveSoftwarePending: true,
      cp0: {
        handlerPc: layout.exceptionHandler,
        causeImplementedMask: 0xffffffff,
        statusWritableMask: 0xffffffff, causeWritableMask: 0xffffffff, epcWritableMask: 0xffffffff,
        statusInterruptMaskBits: 0xfc00, statusExceptionLevelBit: 2, statusInterruptEnableBit: 1,
        causeBranchDelayBit: 0x80000000, causeInterruptPendingBits: 0xfc00,
        causeExceptionCodeBits: 0x7c, causeExceptionCodeShift: 2,
        readableRegisters: Array.from({ length: 32 }, (_, i) => i),
        writableRegisters: Array.from({ length: 32 }, (_, i) => i)
      },
      wiring: { timer0Bit: 0, timer1Bit: 1, interruptGeneratorBit: 2 },
      stagePriority: ['fetch', 'decode', 'execute', 'memory'],
      eretHasDelaySlot: false
    },
    trace: { dutCyclePrefix: false, wordAlignedStores: true, suppressZeroRegisterWrites: true },
    halt: { selfBranchWord: 0x1000ffff, delaySlotWord: 0, requireDelaySlotCommit: delayedBranching }
  };
}
