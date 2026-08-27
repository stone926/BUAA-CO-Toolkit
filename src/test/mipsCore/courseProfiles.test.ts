import { describe, expect, it } from 'vitest';
import { courseExceptionCodes, cp0RegisterNumbers } from '../../mips/core/profiles/profile';
import {
  courseExecutionProfiles,
  courseHaltBranchWord,
  courseProfileIds,
  resolveCourseProfile
} from '../../mips/core/profiles/courseProfiles';
import { op } from './programFixtures';

/**
 * Frozen course-contract assertions. Every expected value here is transcribed
 * from the tutorial, not from the profile data, so a single-field mutation of
 * `courseProfiles.ts` (link offset off by four, delay slot flipped, a CP0 mask
 * bit moved) fails this suite instead of silently changing the oracle.
 *
 * Sources: P7-2-2 地址表, P7-2-3 CP0 位域/异常码, P7-2-6 提交要求,
 * P4-1 "不考虑延迟槽", P6-1 "所有运算类指令均暂不考虑因溢出而产生的异常",
 * P5-4-5 程序行为约束.
 */

describe('course execution profile contract', () => {
  it('freezes the course address space for every profile', () => {
    for (const id of courseProfileIds) {
      const profile = resolveCourseProfile(id);
      const data = profile.memoryRegions.find((region) => region.id === 'data');
      const text = profile.memoryRegions.find((region) => region.id === 'text');
      expect(data, id).toBeDefined();
      expect(text, id).toBeDefined();
      // DM 0x0000_0000..0x0000_2FFF (12 KiB = 3072 words), IM 0x3000..0x6FFF (16 KiB = 4096 words).
      expect(data!.range, id).toEqual({ start: 0x0000_0000, endInclusive: 0x0000_2fff });
      expect(text!.range, id).toEqual({ start: 0x0000_3000, endInclusive: 0x0000_6fff });
      expect(text!.instructionOnly, id).toBe(true);
      expect(profile.reset.pc, id).toBe(0x0000_3000);
      expect(profile.reset.gpr.every((value) => value === 0), id).toBe(true);
      expect(profile.reset.hiLoDefined, id).toBe(false);
    }
  });

  it('freezes delay-slot and link semantics per profile', () => {
    // P3/P4 are single-cycle designs; P4-1 says 不考虑延迟槽. P5 onward have one
    // delay slot and link PC+8 (P5 DELAY-001).
    expect(resolveCourseProfile('P3').delaySlot).toBe(false);
    expect(resolveCourseProfile('P4').delaySlot).toBe(false);
    expect(resolveCourseProfile('P5').delaySlot).toBe(true);
    expect(resolveCourseProfile('P6').delaySlot).toBe(true);
    expect(resolveCourseProfile('P7').delaySlot).toBe(true);

    expect(resolveCourseProfile('P3').linkOffset).toBe(4);
    expect(resolveCourseProfile('P4').linkOffset).toBe(4);
    expect(resolveCourseProfile('P5').linkOffset).toBe(8);
    expect(resolveCourseProfile('P6').linkOffset).toBe(8);
    expect(resolveCourseProfile('P7').linkOffset).toBe(8);
  });

  it('traps arithmetic overflow only on P7', () => {
    expect(resolveCourseProfile('P3').overflow).toBe('wrap');
    expect(resolveCourseProfile('P4').overflow).toBe('wrap');
    expect(resolveCourseProfile('P5').overflow).toBe('wrap');
    expect(resolveCourseProfile('P6').overflow).toBe('wrap');
    expect(resolveCourseProfile('P7').overflow).toBe('trap');
  });

  it('declares the DUT cycle prefix only from P5 onward', () => {
    // P4-7 prints `@%h: ...`; P5-5-2 prints `%d@%h: ...`.
    expect(resolveCourseProfile('P3').trace.dutCyclePrefix).toBe(false);
    expect(resolveCourseProfile('P4').trace.dutCyclePrefix).toBe(false);
    expect(resolveCourseProfile('P5').trace.dutCyclePrefix).toBe(true);
    expect(resolveCourseProfile('P6').trace.dutCyclePrefix).toBe(true);
    expect(resolveCourseProfile('P7').trace.dutCyclePrefix).toBe(true);
  });

  it('exposes P7 devices and no devices anywhere else', () => {
    for (const id of ['P3', 'P4', 'P5', 'P6'] as const) {
      expect(resolveCourseProfile(id).deviceRegions, id).toEqual([]);
      expect(resolveCourseProfile(id).exceptions, id).toBeUndefined();
    }
    const p7 = resolveCourseProfile('P7');
    const byId = new Map(p7.deviceRegions.map((region) => [region.id, region]));
    expect(byId.get('timer0')!.range).toEqual({ start: 0x0000_7f00, endInclusive: 0x0000_7f0b });
    expect(byId.get('timer1')!.range).toEqual({ start: 0x0000_7f10, endInclusive: 0x0000_7f1b });
    expect(byId.get('interrupt-generator')!.range)
      .toEqual({ start: 0x0000_7f20, endInclusive: 0x0000_7f23 });
    // `lb/lh/sb/sh` against a Timer register is an address error, but the official
    // acknowledge is `sb $0, 0x7f20($0)`, so the generator must accept byte access.
    expect(byId.get('timer0')!.acceptedWidths).toEqual([4]);
    expect(byId.get('timer1')!.acceptedWidths).toEqual([4]);
    expect(byId.get('interrupt-generator')!.acceptedWidths).toEqual([1, 2, 4]);
  });

  it('freezes the P7 CP0 bit layout and exception codes', () => {
    const cp0 = resolveCourseProfile('P7').exceptions!.cp0;
    expect(cp0.handlerPc).toBe(0x0000_4180);
    // SR: IM = 15:10, EXL = 1, IE = 0.
    expect(cp0.statusInterruptMaskBits).toBe(0b1111_1100_0000_0000);
    expect(cp0.statusExceptionLevelBit).toBe(1 << 1);
    expect(cp0.statusInterruptEnableBit).toBe(1 << 0);
    expect(cp0.statusWritableMask).toBe(0xfc03);
    // Cause: BD = 31, IP = 15:10, ExcCode = 6:2.
    expect(cp0.causeBranchDelayBit >>> 0).toBe(0x8000_0000);
    expect(cp0.causeInterruptPendingBits).toBe(0b1111_1100_0000_0000);
    expect(cp0.causeExceptionCodeBits).toBe(0b0111_1100);
    expect(cp0.causeExceptionCodeShift).toBe(2);
    // The course guarantees Cause is never written by a test program.
    expect(cp0.causeWritableMask).toBe(0);
    expect(cp0.readableRegisters).toEqual([12, 13, 14]);
    expect(cp0.writableRegisters).toEqual([12, 14]);
    expect(cp0RegisterNumbers).toEqual({ status: 12, cause: 13, epc: 14 });
  });

  it('freezes the exception codes and HWInt wiring', () => {
    expect(courseExceptionCodes).toEqual({
      int: 0, adel: 4, ades: 5, syscall: 8, ri: 10, ov: 12
    });
    expect(resolveCourseProfile('P7').exceptions!.wiring)
      .toEqual({ timer0Bit: 0, timer1Bit: 1, interruptGeneratorBit: 2 });
    expect(resolveCourseProfile('P7').exceptions!.stagePriority)
      .toEqual(['fetch', 'decode', 'execute', 'memory']);
    expect(resolveCourseProfile('P7').exceptions!.eretHasDelaySlot).toBe(false);
  });

  it('encodes the canonical halt sequence', () => {
    // COURSE-COMMON-HALT-001: `beq $0, $0, -1` is 0x1000ffff and targets itself.
    expect(courseHaltBranchWord).toBe(0x1000_ffff);
    expect(op('beq', { rs: 0, rt: 0, immediate: -1 })).toBe(0x1000_ffff);
    expect(op('nop')).toBe(0x0000_0000);
    for (const id of courseProfileIds) {
      const profile = courseExecutionProfiles[id];
      expect(profile.halt.selfBranchWord, id).toBe(0x1000_ffff);
      expect(profile.halt.delaySlotWord, id).toBe(0);
      expect(profile.halt.requireDelaySlotCommit, id).toBe(profile.delaySlot);
    }
  });

  it('enables required and commonExtensions layers by default', () => {
    // COURSE-P7-ISA-EXT-001: the official handler uses addu/addiu, so those stay
    // recognised; subu and the rest of the MARS layer must not be on by default.
    for (const id of courseProfileIds) {
      expect([...resolveCourseProfile(id).defaultLayers], id)
        .toEqual(['required', 'commonExtensions']);
    }
  });
});
