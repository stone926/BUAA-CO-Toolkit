import { describe, expect, it } from 'vitest';
import {
  p7Hardware,
  p7UserTextBaseAddress,
  p7ExceptionHandlerAddress,
  p7KernelTextDumpEndAddress,
  p7ProbeLogBase,
  p7ProbeRecordWords,
  p7InstructionMemoryWords,
  p7DataMemoryWords,
  p7ProbeStateScenarioId,
  p7ProbeStateKind,
  p7ProbeStateDonePc,
  p7ProbeStateRecordPtr,
  p7ProbeExternalArmAddress,
  p7StatusEnableAllCourseInterrupts,
  p7ExternalInterruptAckAddress,
  p7Timer0Ctrl,
  p7Timer0Preset,
  p7Timer0Count,
  p7Timer1Ctrl,
  p7Timer1Preset,
  p7Timer1Count,
  p7CauseIpTimer0Mask,
  p7CauseIpTimer1Mask,
  p7CauseIpExternalMask,
  p7CauseExcCodeMask,
  p7ProbeMagic,
  p7ProbeKindExternal,
  p7ProbeKindTimer0,
  p7ProbeKindTimer1,
  p7ProbeKindInternal,
  p7ProbeKindAdel,
  p7ProbeKindAdes,
  p7ProbeKindSyscall,
  p7ProbeKindRi,
  p7ProbeKindOv,
  p7ProbeDefaultScenarioCount,
  p7ProbeMaxScenarioCount,
  p7ProbeTimerPresetMin,
  p7ProbeTimerPresetMax,
  p7ProbeTimerCtrlStart,
  p7ExcCodeAdel,
  p7ExcCodeAdes,
  p7ExcCodeSyscall,
  p7ExcCodeRi,
  p7ExcCodeOv
} from '../../courseTesting/builtinAsm/p7/constants';
import { p7InternalUnknownInstructionMnemonic } from '../../courseTesting/builtinAsmGenerator';

describe('P7 hardware memory layout', () => {
  it('exports constants from the structured P7 hardware resource', () => {
    expect(p7UserTextBaseAddress).toBe(p7Hardware.memoryLayout.userTextBaseAddress);
    expect(p7ExceptionHandlerAddress).toBe(p7Hardware.memoryLayout.exceptionHandlerAddress);
    expect(p7ProbeLogBase).toBe(p7Hardware.memoryLayout.probeLogBase);
    expect(p7ProbeRecordWords).toBe(p7Hardware.memoryLayout.probeRecordWords);
    expect(p7InstructionMemoryWords).toBe(p7Hardware.memoryLayout.instructionMemoryWords);
    expect(p7DataMemoryWords).toBe(p7Hardware.memoryLayout.dataMemoryWords);
    expect(p7ExternalInterruptAckAddress).toBe(p7Hardware.interrupt.externalAckAddress);
    expect(p7ProbeMagic).toBe(p7Hardware.probe.magic);
  });

  it('text base address is 0x3000', () => {
    expect(p7UserTextBaseAddress).toBe(0x3000);
  });

  it('exception handler is at 0x4180', () => {
    expect(p7ExceptionHandlerAddress).toBe(0x4180);
  });

  it('exception handler does not overlap with user text', () => {
    // User text: 0x3000 to 0x4180-1. Exception handler: starts at 0x4180.
    // With 4 bytes per instruction, there are exactly 1120 user-text slots before the handler.
    const userInstructionSlots = (p7ExceptionHandlerAddress - p7UserTextBaseAddress) / 4;
    expect(userInstructionSlots).toBe(0x4180 - 0x3000 >> 2);
    expect(userInstructionSlots).toBeGreaterThan(0);
  });

  it('probe log base (0x2800) is outside text and handler ranges', () => {
    // Probe log is at 0x2800, well below 0x3000 text start.
    expect(p7ProbeLogBase).toBe(0x2800);
    expect(p7ProbeLogBase).toBeLessThan(p7UserTextBaseAddress);
  });

  it('probe state words are in contiguous reserved area', () => {
    expect(p7ProbeStateScenarioId).toBe(0x27e0);
    expect(p7ProbeStateKind).toBe(0x27e4);
    expect(p7ProbeStateDonePc).toBe(0x27e8);
    expect(p7ProbeStateRecordPtr).toBe(0x27ec);
    // All state words are at distinct 4-byte intervals
    const stateAddrs = [p7ProbeStateScenarioId, p7ProbeStateKind, p7ProbeStateDonePc, p7ProbeStateRecordPtr];
    for (let i = 1; i < stateAddrs.length; i++) {
      expect(stateAddrs[i] - stateAddrs[i - 1]).toBe(4);
    }
  });

  it('probe external arm address is separate from probe state', () => {
    expect(p7ProbeExternalArmAddress).toBe(0x27d0);
  });

  it('probe record uses 8 words', () => {
    expect(p7ProbeRecordWords).toBe(8);
  });

  it('uses separate P7 instruction and data memory depths', () => {
    expect(p7InstructionMemoryWords).toBe(4096);
    expect(p7DataMemoryWords).toBe(3072);
    expect(p7InstructionMemoryWords).toBeGreaterThan(p7DataMemoryWords);
  });

  it('derives kernel text dump end from instruction memory depth', () => {
    expect(p7KernelTextDumpEndAddress).toBe(p7UserTextBaseAddress + p7InstructionMemoryWords * 4 - 4);
    expect(p7KernelTextDumpEndAddress).toBe(0x6ffc);
    expect(p7ExceptionHandlerAddress).toBeLessThanOrEqual(p7KernelTextDumpEndAddress);
  });
});

describe('P7 CP0 Status / Cause bit masks', () => {
  it('external interrupt mask is 0x1000 (IM[2])', () => {
    expect(p7CauseIpExternalMask).toBe(0x1000);
  });

  it('timer0 interrupt mask is 0x0400 (IP2)', () => {
    expect(p7CauseIpTimer0Mask).toBe(0x0400);
  });

  it('timer1 interrupt mask is 0x0800 (IP3)', () => {
    expect(p7CauseIpTimer1Mask).toBe(0x0800);
  });

  it('interrupt masks are mutually exclusive (distinct bits)', () => {
    const masks = [p7CauseIpExternalMask, p7CauseIpTimer0Mask, p7CauseIpTimer1Mask];
    for (let i = 0; i < masks.length; i++) {
      for (let j = i + 1; j < masks.length; j++) {
        expect(masks[i] & masks[j]).toBe(0);
      }
    }
  });

  it('ExcCode mask is 0x007c (bits 2-6)', () => {
    expect(p7CauseExcCodeMask).toBe(0x007c);
  });

  it('ExcCode mask does not overlap with interrupt IP bits', () => {
    expect(p7CauseExcCodeMask & p7CauseIpExternalMask).toBe(0);
    expect(p7CauseExcCodeMask & p7CauseIpTimer0Mask).toBe(0);
    expect(p7CauseExcCodeMask & p7CauseIpTimer1Mask).toBe(0);
  });

  it('status enable-all-course-interrupts value includes IM[2] and IE bits', () => {
    // 0x1c01 = IE (bit0) + IM[2] (bit12) + IM[3] (bit13) + IM[4] (bit14)
    expect(p7StatusEnableAllCourseInterrupts).toBe(0x1c01);
    // Must include IE (bit 0)
    expect(p7StatusEnableAllCourseInterrupts & 0x0001).toBeTruthy();
    // Must include external interrupt mask IM[2] (bit 12)
    expect(p7StatusEnableAllCourseInterrupts & p7CauseIpExternalMask).toBeTruthy();
  });
});

describe('P7 timer addresses', () => {
  it('timer0 registers are at 0x7f00-0x7f0c', () => {
    expect(p7Timer0Ctrl).toBe(0x7f00);
    expect(p7Timer0Preset).toBe(0x7f04);
    expect(p7Timer0Count).toBe(0x7f08);
  });

  it('timer1 registers are at 0x7f10-0x7f1c', () => {
    expect(p7Timer1Ctrl).toBe(0x7f10);
    expect(p7Timer1Preset).toBe(0x7f14);
    expect(p7Timer1Count).toBe(0x7f18);
  });

  it('timer0 and timer1 blocks do not overlap', () => {
    // Timer0: 0x7f00-0x7f0c, Timer1: 0x7f10-0x7f1c
    expect(p7Timer1Ctrl - p7Timer0Count).toBeGreaterThan(0);
  });

  it('external interrupt ack is at 0x7f20', () => {
    expect(p7ExternalInterruptAckAddress).toBe(0x7f20);
  });

  it('timer preset range is within bounds', () => {
    expect(p7ProbeTimerPresetMin).toBe(2);
    expect(p7ProbeTimerPresetMax).toBe(96);
    expect(p7ProbeTimerPresetMin).toBeLessThan(p7ProbeTimerPresetMax);
  });

  it('timer CTRL start value is 0x9', () => {
    expect(p7ProbeTimerCtrlStart).toBe(0x9);
  });
});

describe('P7 exception codes', () => {
  it('has correct AdEL (4) exception code', () => {
    expect(p7ExcCodeAdel).toBe(4);
  });

  it('has correct AdES (5) exception code', () => {
    expect(p7ExcCodeAdes).toBe(5);
  });

  it('has correct Syscall (8) exception code', () => {
    expect(p7ExcCodeSyscall).toBe(8);
  });

  it('has correct RI (10) exception code', () => {
    expect(p7ExcCodeRi).toBe(10);
  });

  it('has correct Ov (12) exception code', () => {
    expect(p7ExcCodeOv).toBe(12);
  });

  it('all exception codes fit in 5-bit ExcCode field', () => {
    const excCodes = [p7ExcCodeAdel, p7ExcCodeAdes, p7ExcCodeSyscall, p7ExcCodeRi, p7ExcCodeOv];
    for (const code of excCodes) {
      // ExcCode is bits 2-6; max 5-bit value is 31
      expect(code).toBeGreaterThan(0);
      expect(code).toBeLessThanOrEqual(31);
    }
  });

  it('all exception codes are distinct', () => {
    const excCodes = [p7ExcCodeAdel, p7ExcCodeAdes, p7ExcCodeSyscall, p7ExcCodeRi, p7ExcCodeOv];
    expect(new Set(excCodes).size).toBe(excCodes.length);
  });
});

describe('P7 probe constants', () => {
  it('probe magic value is 0xc0a70001', () => {
    expect(p7ProbeMagic).toBe(0xc0a70001);
  });

  it('probe kind IDs cover all course-required events', () => {
    expect(p7ProbeKindExternal).toBe(1);
    expect(p7ProbeKindTimer0).toBe(2);
    expect(p7ProbeKindTimer1).toBe(3);
    expect(p7ProbeKindInternal).toBe(4);
    expect(p7ProbeKindAdel).toBe(5);
    expect(p7ProbeKindAdes).toBe(6);
    expect(p7ProbeKindSyscall).toBe(7);
    expect(p7ProbeKindRi).toBe(8);
    expect(p7ProbeKindOv).toBe(9);
  });

  it('all probe kind IDs are distinct', () => {
    const kinds = [
      p7ProbeKindExternal, p7ProbeKindTimer0, p7ProbeKindTimer1,
      p7ProbeKindInternal,
      p7ProbeKindAdel, p7ProbeKindAdes, p7ProbeKindSyscall,
      p7ProbeKindRi, p7ProbeKindOv
    ];
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('default scenario count does not exceed max', () => {
    expect(p7ProbeDefaultScenarioCount).toBeGreaterThan(0);
    expect(p7ProbeDefaultScenarioCount).toBeLessThanOrEqual(p7ProbeMaxScenarioCount);
  });

  it('max scenario count is 64', () => {
    expect(p7ProbeMaxScenarioCount).toBe(64);
  });
});

describe('P7 internal unknown instruction mnemonic', () => {
  it('uses the reserved prefix naming convention', () => {
    expect(p7InternalUnknownInstructionMnemonic).toBe('_co_internal_unknown_instruction');
    expect(p7InternalUnknownInstructionMnemonic).toMatch(/^_co_internal_/);
  });
});
