import { describe, expect, it, vi } from 'vitest';
import {
  generateBuiltinAsmTestCase,
  resolveBuiltinInstructionSet
} from '../../courseTesting/builtinAsmGenerator';
import { generatorInstructionCatalog } from '../../courseTesting/generatorInstructionCatalog';
import { CpuState } from '../../courseTesting/cpuState';
import { signExtend16, signed32 } from '../../courseTesting/mipsUtil';
import { p7RiWordCatalog, p7RiWordDirective } from '../../courseTesting/p7RiWords';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { executeProgramForService } from '../../mips/core/machine/executeService';
import {
  p7ExceptionHandlerAddress,
  p7CourseInstructionCountMaximum,
  p7ExternalInterruptAckAddress,
  p7Hex,
  p7ProbeDefaultScenarioCount,
  p7ProbeLogBase,
  p7ProbeMaxScenarioCount,
  p7ProbeStateDonePc,
  p7ProbeExternalArmAddress,
  p7ProbeTimerPresetMax,
  p7ProbeTimerPresetMin,
  p7Timer0Ctrl,
  p7Timer0Count,
  p7Timer0Preset,
  p7Timer1Ctrl,
  p7Timer1Count,
  p7Timer1Preset,
  p7UserTextBaseAddress
} from '../../courseTesting/p7Hardware';

describe('built-in ASM generator', () => {
  it('uses the course default instruction set for each CPU profile', () => {
    for (const [profile, mnemonics] of Object.entries(generatorInstructionCatalog.profiles)) {
      const resolved = resolveBuiltinInstructionSet(profile as Parameters<typeof resolveBuiltinInstructionSet>[0], '');
      expect(resolved.mnemonics).toEqual(mnemonics);
      expect(resolved.defaulted).toBe(true);
    }
  });

  it('parses comma and whitespace separated real instruction names', () => {
    const resolved = resolveBuiltinInstructionSet('P5', 'addu, subu   ori\nlw\t sw beq');

    expect(resolved.mnemonics).toEqual(['addu', 'subu', 'ori', 'lw', 'sw', 'beq']);
    expect(resolved.defaulted).toBe(false);
    expect(resolved.profile).toBe('P5');
  });

  it('rejects pseudo instructions and operand-looking tokens', () => {
    expect(() => resolveBuiltinInstructionSet('P5', 'addu li')).toThrow(/real CPU instructions/);
    expect(() => resolveBuiltinInstructionSet('P5', 'addu $t0')).toThrow(/unknown instruction/);
  });

  it('emits the requested number of instructions using only the configured set', () => {
    const allowed = new Set(['addu', 'subu', 'ori', 'lw', 'sw', 'beq']);
    const result = generateBuiltinAsmTestCase({
      profile: 'P5',
      instructionText: 'addu, subu ori lw sw beq',
      instructionCount: 48,
      seed: 'configured-set'
    });
    const mnemonics = executableMnemonics(beforeGeneratedHalt(result.text));

    expect(result.instructionCount).toBe(48);
    expect(mnemonics).toHaveLength(48);
    expect(mnemonics.every((mnemonic) => allowed.has(mnemonic))).toBe(true);
    for (const mnemonic of allowed) {
      expect(mnemonics, mnemonic).toContain(mnemonic);
    }
  });

  it('accepts nop as a real instruction', () => {
    const resolved = resolveBuiltinInstructionSet('P5', 'nop');
    const result = generateBuiltinAsmTestCase({
      profile: 'P5',
      instructionText: 'nop',
      instructionCount: 8,
      seed: 'nop-only'
    });

    expect(resolved.mnemonics).toEqual(['nop']);
    expect(executableMnemonics(beforeGeneratedHalt(result.text))).toEqual(Array(8).fill('nop'));
  });

  it('ends every generated CPU-profile ASM with the course halt loop', () => {
    for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7'] as const) {
      const result = generateBuiltinAsmTestCase({
        profile,
        instructionText: 'nop',
        instructionCount: profile === 'P7' ? 1118 : 8,
        seed: `halt-loop-${profile}`
      });
      const mainText = beforeKernelText(result.text);

      expect(mainText).toMatch(/_co_test_end:\n\s+beq \$0, \$0, _co_test_end\n\s+nop\s*$/);
      expect(executableMnemonics(beforeGeneratedHalt(mainText))).toHaveLength(result.instructionCount);
      expect(result.usedInstructions).toEqual(['nop']);
      expect(result.usedInstructions).not.toContain('beq');
      if (profile === 'P7') {
        expect(executableMnemonics(mainText)).toHaveLength(1120);
      }
    }
  });

  it('does not generate divide by zero', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P6',
      instructionText: 'ori addiu addu div divu mfhi mflo',
      instructionCount: 56,
      seed: 'division'
    });
    const divLines = result.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^divu?\s/.test(line));

    expect(divLines.length).toBeGreaterThan(0);
    expect(divLines.every((line) => !/,\s*\$0\b/.test(line))).toBe(true);
  });

  it('allocates and legally addresses the complete 12 KiB course DM', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P6',
      instructionText: 'lui ori lw sw',
      instructionCount: 1000,
      seed: 'memory-sign-and-boundary-coverage'
    });
    const coverage = inspectSimpleMemoryProgram(executableLines(result.text));

    expect(result.text).toContain('.space 12288');
    expect(coverage.addresses.some((address) => address === 0x2ffc)).toBe(true);
    expect(coverage.offsetSigns).toEqual(new Set(['negative', 'zero', 'positive']));
    expect(coverage.baseSigns).toContain('negative');
  });

  it('does not issue a stable-MARS byte access from the exclusive 0x2fff limit', () => {
    const byteAt = vi.spyOn(CpuState.prototype, 'byteAt');
    const writeByte = vi.spyOn(CpuState.prototype, 'writeByte');
    let addresses: number[] = [];
    try {
      generateBuiltinAsmTestCase({
        profile: 'P6',
        instructionText: 'lui ori lb lbu sb',
        instructionCount: 1000,
        seed: 'stable-mars-data-limit'
      });
      addresses = [
        ...byteAt.mock.calls.map(([address]) => address),
        ...writeByte.mock.calls.map(([address]) => address)
      ];
    } finally {
      byteAt.mockRestore();
      writeByte.mockRestore();
    }

    expect(addresses.length).toBeGreaterThan(0);
    expect(Math.max(...addresses)).toBeLessThanOrEqual(0x2ffe);
  });

  it('keeps stable-MARS partial-word spans below the exclusive 0x2fff limit', () => {
    const byteAt = vi.spyOn(CpuState.prototype, 'byteAt');
    const writeByte = vi.spyOn(CpuState.prototype, 'writeByte');
    const loadWordRight = vi.spyOn(CpuState.prototype, 'loadWordRight');
    const storeWordRight = vi.spyOn(CpuState.prototype, 'storeWordRight');
    let byteAddresses: number[] = [];
    let rightEffectiveAddresses: number[] = [];
    try {
      generateBuiltinAsmTestCase({
        profile: 'P6',
        instructionText: 'lwl lwr swl swr nop',
        instructionCount: 500,
        seed: 'partial-word-offsets'
      });
      byteAddresses = [
        ...byteAt.mock.calls.map(([address]) => address),
        ...writeByte.mock.calls.map(([address]) => address)
      ];
      rightEffectiveAddresses = [
        ...loadWordRight.mock.calls.map(([address]) => address),
        ...storeWordRight.mock.calls.map(([address]) => address)
      ];
    } finally {
      byteAt.mockRestore();
      writeByte.mockRestore();
      loadWordRight.mockRestore();
      storeWordRight.mockRestore();
    }

    expect(byteAddresses.length).toBeGreaterThan(0);
    expect(Math.max(...byteAddresses)).toBe(0x2ffe);
    expect(rightEffectiveAddresses.length).toBeGreaterThan(0);
    expect(Math.max(...rightEffectiveAddresses)).toBeLessThanOrEqual(0x2ffb);
  });

  it('uses every byte offset for unaligned word-left/right instructions', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P6',
      instructionText: 'lwl lwr swl swr nop',
      instructionCount: 500,
      seed: 'partial-word-offsets'
    });
    const offsets = executableLines(result.text)
      .filter((line) => /^(?:lwl|lwr|swl|swr)\b/.test(line))
      .map((line) => Number(/,\s*(-?(?:0x[\da-f]+|\d+))\(/i.exec(line)?.[1]) & 3);

    expect(new Set(offsets)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('never reads an unspecified HI/LO value, including after MUL', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P6',
      instructionText: 'ori mul mult madd mthi mtlo mfhi mflo',
      instructionCount: 500,
      seed: 'defined-hilo-only'
    });

    expect(hiLoUndefinedReads(executableMnemonics(result.text))).toEqual([]);
  });

  it('makes both taken and not-taken branch decisions observable', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P6',
      instructionText: 'beq lui ori',
      instructionCount: 100,
      seed: 'observable-branch-outcomes'
    });
    const lines = executableLines(result.text);
    const branches = lines
      .map((line, index) => ({ line, index, registers: /^beq\s+(\$\d+),\s*(\$\d+),/.exec(line) }))
      .filter((item) => item.registers);

    expect(branches.some((item) => item.registers?.[1] === item.registers?.[2])).toBe(true);
    expect(branches.some((item) => item.registers?.[1] !== item.registers?.[2])).toBe(true);
    expect(branches.filter((item) => item.index + 2 < lines.length).every((item) => /\$26\b/.test(lines[item.index + 2]))).toBe(true);
  });

  it('covers both link-branch outcomes while modeling their unconditional MIPS link', () => {
    const setRegister = vi.spyOn(CpuState.prototype, 'setRegister');
    let generatedText = '';
    let modeledLinkAddresses: number[] = [];
    try {
      const result = generateBuiltinAsmTestCase({
        profile: 'P6',
        instructionText: 'lui bgezal bltzal nop',
        instructionCount: 400,
        seed: 'both-link-branch-outcomes'
      });
      generatedText = result.text;
      modeledLinkAddresses = setRegister.mock.calls
        .filter(([register]) => register === '$31')
        .map(([, value]) => value);
    } finally {
      setRegister.mockRestore();
    }

    const lines = executableLines(beforeGeneratedHalt(generatedText));
    const state = new CpuState();
    const links: Array<{ mnemonic: string; register: string; index: number; taken: boolean }> = [];
    for (const [index, line] of lines.entries()) {
      const lui = /^lui\s+(\$\d+),\s*(-?(?:0x[\da-f]+|\d+))$/i.exec(line);
      if (lui) {
        state.setRegister(lui[1], Number(lui[2]) << 16);
        continue;
      }
      const link = /^(bgezal|bltzal)\s+(\$\d+),/.exec(line);
      if (link) {
        const value = signed32(state.regValue(link[2]));
        links.push({
          mnemonic: link[1],
          register: link[2],
          index,
          taken: link[1] === 'bgezal' ? value >= 0 : value < 0
        });
      }
    }

    expect(new Set(links.map((link) => link.mnemonic))).toEqual(new Set(['bgezal', 'bltzal']));
    for (const mnemonic of ['bgezal', 'bltzal']) {
      const outcomes = links.filter((link) => link.mnemonic === mnemonic).map((link) => link.taken);
      expect(outcomes).toContain(true);
      expect(outcomes).toContain(false);
    }
    expect(links.every((link) => link.register !== '$31')).toBe(true);
    expect(modeledLinkAddresses).toEqual(
      links.map((link) => p7UserTextBaseAddress + link.index * 4 + 8)
    );
  });

  it('includes bounded self and genuinely taken backward branch targets', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P6',
      instructionText: '',
      instructionCount: 120,
      seed: 'control-target-directions'
    });

    expect(result.text).toMatch(/(_co_self_\d+):\n\s+beq \$0, \$22, \1/);
    expect(result.text).toMatch(/(_co_backward_\d+):[\s\S]*beq \$0, \$0, \1/);
    expect(result.text).toMatch(/sub \$21, \$21, \$22[\s\S]*beq \$21, \$0, _co_backward_done_/);
  });

  it('covers both write and no-write outcomes for conditional moves', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P6',
      instructionText: 'ori movn movz',
      instructionCount: 200,
      seed: 'conditional-move-outcomes'
    });
    const outcomes = conditionalMoveOutcomes(executableLines(result.text));

    expect(outcomes.get('movn')).toEqual(new Set([false, true]));
    expect(outcomes.get('movz')).toEqual(new Set([false, true]));
  });

  it('covers both raising and non-raising outcomes for explicitly selected P7 traps', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: 'ori teq tne teqi tnei mfc0 mtc0 eret',
      instructionCount: 300,
      seed: 'trap-outcomes'
    });
    const body = executableLines(beforeKernelText(result.text));
    const teq = body.filter((line) => /^teq\b/.test(line));
    const tne = body.filter((line) => /^tne\b/.test(line));

    expect(result.text).toContain(`.ktext ${p7Hex(p7ExceptionHandlerAddress)}`);
    expect(teq.some(hasEqualTrapRegisters)).toBe(true);
    expect(teq.some((line) => !hasEqualTrapRegisters(line))).toBe(true);
    expect(tne.some(hasEqualTrapRegisters)).toBe(true);
    expect(tne.some((line) => !hasEqualTrapRegisters(line))).toBe(true);
    expect(body).toContain('teqi $0, 0');
    expect(body).toContain('teqi $0, 1');
    expect(body).toContain('tnei $0, 1');
    expect(body).toContain('tnei $0, 0');
  });

  it('keeps signed arithmetic non-overflowing in every random profile', () => {
    const p6 = generateBuiltinAsmTestCase({
      profile: 'P6',
      instructionText: 'lui ori add sub',
      instructionCount: 600,
      seed: 'non-overflowing-arithmetic'
    });
    const p7 = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: 'lui ori add sub',
      instructionCount: 600,
      seed: 'non-overflowing-arithmetic'
    });

    expect(arithmeticOverflowCount(executableLines(p6.text))).toBe(0);
    expect(arithmeticOverflowCount(executableLines(p7.text))).toBe(0);
  });

  it('uses stateful skipped poison for taken control-flow probes', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P5',
      instructionText: 'j beq ori addu',
      instructionCount: 40,
      seed: 'poison-0'
    });
    const poisonLines = executableLines(result.text).filter((line) => /\$26\b/.test(line));

    expect(poisonLines.length).toBeGreaterThan(0);
    expect(poisonLines.every((line) => /^(ori|addu)\s+\$26\b/.test(line))).toBe(true);
  });

  it('biases P6/P7 MDU reads into both busy and post-busy windows', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P6',
      instructionText: 'ori addiu addu mult multu div divu mfhi mflo',
      instructionCount: 160,
      seed: 'mdu-probes'
    });
    const mnemonics = executableMnemonics(result.text);
    const probes = mduReadProbeDistances(mnemonics);

    expect(probes.some((probe) => isBusyMduReadProbe(probe))).toBe(true);
    expect(probes.some((probe) => isReadyMduReadProbe(probe))).toBe(true);
    expect(mduWriteViolationsDuringStartOrBusy(mnemonics)).toEqual([]);
  });

  it('generates P7 syscall tests with a kernel exception handler', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 96,
      seed: 'p7-default'
    });
    const mainMnemonics = executableMnemonics(beforeGeneratedHalt(result.text));

    expect(result.instructionCount).toBe(96);
    expect(mainMnemonics).toHaveLength(96);
    expect(mainMnemonics).toContain('syscall');
    expect(result.text).toContain(`.ktext ${p7Hex(p7ExceptionHandlerAddress)}`);
    expect(result.text).toContain('mfc0 $k0, $13');
    expect(result.text).toContain('mtc0 $k0, $14');
    expect(result.text).toContain(`sb $0, ${p7Hex(p7ExternalInterruptAckAddress)}($0)`);
    expect(result.text).toContain('eret');
  });

  it('allows the configured P7 default count but rejects programs that would overlap the exception entry', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 1000,
      seed: 'p7-default-count'
    });

    expect(result.instructionCount).toBe(1000);
    expect(() => generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 1119,
      seed: 'p7-too-long'
    })).toThrow(/at most 1118/);
    expect(() => generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: 'nop',
      instructionCount: 1119,
      seed: 'p7-nop-too-long'
    })).toThrow(/at most 1118/);
  });

  it('does not apply the P7 instruction count rule to earlier profiles', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P6',
      instructionText: 'nop',
      instructionCount: 1200,
      seed: 'p6-long'
    });

    expect(result.instructionCount).toBe(1200);
  });

  it('keeps the fixed P7 handler independent from the payload instruction focus', () => {
    const eretOnly = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: 'eret',
      instructionCount: 4,
      seed: 'eret-only'
    });
    const syscallOnly = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: 'syscall',
      instructionCount: 4,
      seed: 'syscall-only'
    });
    expect(syscallOnly.text).toContain('mfc0 $k0, $13');
    expect(syscallOnly.text).toContain('mtc0 $k0, $14');
    expect(syscallOnly.text).toContain('eret');
    expect(eretOnly.instructionSet).toEqual(['eret']);
    expect(eretOnly.usedInstructions).toEqual(['nop']);
  });

  it('schedules one external interrupt at a safe PC and installs the SR prologue', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-interrupt',
      interrupt: true
    });

    expect(result.interruptSchedule).toHaveLength(1);
    const target = result.interruptSchedule[0];
    expect(target % 4).toBe(0);
    expect(target).toBeGreaterThan(p7UserTextBaseAddress);
    // SR prologue enables the external interrupt before any body instruction.
    expect(result.text).toContain('ori $k0, $0, 0x1001');
    expect(result.text).toContain('mtc0 $k0, $12');
    // The first handler entry is the pre-anchor external interrupt, so it must not read full Cause
    // before acknowledging: MARS and legal CPUs may differ in Cause.IP visibility.
    const handler = result.text.slice(result.text.indexOf(`.ktext ${p7Hex(p7ExceptionHandlerAddress)}`));
    const firstEntryFlag = handler.indexOf('    ori $k1, $0, 1');
    const branchToException = handler.indexOf('    bne $k1, $0, _co_excep_skip');
    const interruptAck = handler.indexOf(`    sb $0, ${p7Hex(p7ExternalInterruptAckAddress)}($0)`);
    const exceptionPath = handler.indexOf('_co_excep_skip:');
    expect(handler).not.toContain('    mfc0 $k0, $13');
    expect(branchToException).toBeGreaterThanOrEqual(0);
    expect(firstEntryFlag).toBeGreaterThan(branchToException);
    expect(interruptAck).toBeGreaterThan(firstEntryFlag);
    expect(handler).toContain(`    sb $0, ${p7Hex(p7ExternalInterruptAckAddress)}($0)`);
    expect(exceptionPath).toBeGreaterThan(interruptAck);
    expect(handler).toContain('    mtc0 $k0, $14');
  });

  it('keeps the Cause.ExcCode branch for P7 exception-only tests', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-exception-handler',
      interrupt: false,
      exceptionRate: 0.2
    });
    const handler = result.text.slice(result.text.indexOf(`.ktext ${p7Hex(p7ExceptionHandlerAddress)}`));
    const causeRead = handler.indexOf('    mfc0 $k0, $13');
    const branchToException = handler.indexOf('    bne $k1, $0, _co_excep_skip');

    expect(causeRead).toBeGreaterThanOrEqual(0);
    expect(branchToException).toBeGreaterThan(causeRead);
  });

  it('keeps P7 external interrupt targets out of the internal-exception flush shadow', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: 'ori and lui lw sw syscall mfc0 mtc0 eret',
      instructionCount: 400,
      seed: 'p7-exception-shadow',
      interrupt: true,
      exceptionRate: 0.35
    });

    expect(result.interruptSchedule).toHaveLength(1);
    const bodyLines = instructionSlotLines(beforeKernelText(result.text));
    const exceptionVictims = exceptionVictimIndices(bodyLines);
    expect(exceptionVictims.length).toBeGreaterThan(0);

    const targetIndex = (result.interruptSchedule[0] - p7UserTextBaseAddress) / 4;
    expect(Number.isInteger(targetIndex)).toBe(true);
    expect(targetIndex).toBeLessThan(Math.min(...exceptionVictims));
    expect(isInExceptionFlushShadow(targetIndex - 1, exceptionVictims)).toBe(false);
    expect(isInExceptionFlushShadow(targetIndex, exceptionVictims)).toBe(false);
  });

  it('emits no interrupt schedule when interrupt is disabled', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 120,
      seed: 'p7-no-interrupt'
    });

    expect(result.interruptSchedule).toEqual([]);
  });

  it('injects controllable internal exceptions when exceptionRate is set', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 400,
      seed: 'p7-exceptions',
      exceptionRate: 0.5
    });
    const bodyLines = executableLines(beforeKernelText(result.text));
    // At least one deliberately faulting access (misaligned load/store at offset 1 from $0).
    const faulting = bodyLines.filter((line) => /\b(lw|lh|lhu|sw|sh)\b.*1\(\$0\)/.test(line));

    expect(faulting.length).toBeGreaterThan(0);
  });

  it('covers every RI decoder family within the strongest default anchor budget', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: p7CourseInstructionCountMaximum,
      seed: 'p7-exception-coverage',
      exceptionRate: 0.08
    });
    const bodyLines = instructionSlotLines(beforeKernelText(result.text));

    expect(bodyLines.some((line) => /\b(lw|lh|lhu)\b.*1\(\$0\)/.test(line))).toBe(true);
    expect(bodyLines.some((line) => /\b(sw|sh)\b.*1\(\$0\)/.test(line))).toBe(true);
    expect(bodyLines).toContain('syscall');
    expect(bodyLines).toEqual(expect.arrayContaining(p7RiWordCatalog.map(p7RiWordDirective)));
    expect(result.text).not.toContain('_co_internal_unknown_instruction');
    expect(bodyLines.some((line) =>
      /\baddi\s+\$\d+,\s+\$24,\s+-1\b/.test(line) ||
      /\badd\s+\$\d+,\s+\$24,\s+\$24\b/.test(line) ||
      /\bsub\s+\$\d+,\s+\$24,\s+\$23\b/.test(line)
    )).toBe(true);
  });

  it('honors configured P7 exception classes', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: 'ori lui lw sw syscall mfc0 mtc0 eret',
      instructionCount: 200,
      seed: 'p7-exception-types',
      exceptionRate: 0.5,
      exceptionTypes: ['AdEL']
    });
    const bodyLines = instructionSlotLines(beforeKernelText(result.text));

    expect(bodyLines.some((line) => /\b(lw|lh|lhu)\b.*1\(\$0\)/.test(line))).toBe(true);
    expect(bodyLines.some((line) => /\b(sw|sh)\b.*1\(\$0\)/.test(line))).toBe(false);
    expect(bodyLines).not.toContain('syscall');
    expect(bodyLines).not.toContain('_co_internal_unknown_instruction');
  });

  it('generates P7 probe tests without relying on BadVAddr', () => {
    const coreResult = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-probe',
      interrupt: true,
      p7StressMode: 'probe',
      probeShard: 'core',
      timerInterrupt: false,
      probeScenarioCount: p7ProbeDefaultScenarioCount
    });
    const timerResult = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-probe-timer-shard',
      interrupt: false,
      p7StressMode: 'probe',
      probeShard: 'timer',
      timerInterrupt: true,
      probeScenarioCount: 10
    });
    const mmioResult = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-probe-mmio-shard',
      interrupt: false,
      p7StressMode: 'probe',
      probeShard: 'mmio',
      timerInterrupt: false,
      probeScenarioCount: 26
    });
    const sourceByScenario = new Map([coreResult, timerResult, mmioResult].flatMap((generated) =>
      generated.probe!.scenarios.map((scenario) => [scenario, generated.text] as const)));
    const result = {
      ...coreResult,
      text: `${coreResult.text}\n${timerResult.text}\n${mmioResult.text}`,
      probe: {
        ...coreResult.probe!,
        scenarios: [...coreResult.probe!.scenarios, ...timerResult.probe!.scenarios, ...mmioResult.probe!.scenarios]
      }
    };

    expect(result.mode).toBe('probe');
    expect(result.probe?.logBase).toBe(p7ProbeLogBase);
    expect(coreResult.probe?.scenarios).toHaveLength(p7ProbeDefaultScenarioCount);
    expect(timerResult.probe?.scenarios).toHaveLength(10);
    expect(mmioResult.probe?.scenarios).toHaveLength(26);
    expect(new Set(result.probe?.scenarios.map((scenario) => scenario.kind))).toEqual(new Set([
      'external', 'timer0', 'timer1', 'adel', 'ades', 'syscall', 'ri', 'ov'
    ]));
    expect(new Set(result.probe?.scenarios.filter((scenario) => scenario.expectedBd).map((scenario) => scenario.kind))).toEqual(new Set([
      'external', 'adel', 'ades', 'syscall', 'ri', 'ov'
    ]));
    const internalScenarios = result.probe?.scenarios.filter((scenario) =>
      ['adel', 'ades', 'syscall', 'ri', 'ov'].includes(scenario.kind)) ?? [];
    expect(internalScenarios.every((scenario) => Number.isFinite(scenario.victimPc))).toBe(true);
    expect(internalScenarios.every((scenario) => scenario.victimPc === scenario.allowedEpc[0] + (scenario.expectedBd ? 4 : 0))).toBe(true);
    const adelVariants = [
      'misaligned-load-delay-taken', 'misaligned-load-delay-not-taken',
      'misaligned-half-load-delay-taken', 'misaligned-half-load-delay-not-taken',
      'ea-overflow-load', 'dm-out-of-range-load',
      'timer-byte-load', 'timer-half-load', 'invalid-fetch', 'misaligned-fetch',
      ...['timer0-preset', 'timer0-count', 'timer1-ctrl', 'timer1-preset', 'timer1-count']
        .flatMap((register) => [`${register}-byte-load`, `${register}-half-load`])
    ];
    const adesVariants = [
      'misaligned-store-delay-taken', 'misaligned-store-delay-not-taken',
      'misaligned-half-store-delay-taken', 'misaligned-half-store-delay-not-taken',
      'ea-overflow-store', 'dm-out-of-range-store',
      'timer0-ctrl-byte-store', 'timer1-ctrl-byte-store',
      'timer0-ctrl-half-store', 'timer1-ctrl-half-store',
      'timer0-preset-byte-store', 'timer1-preset-byte-store',
      'timer0-preset-half-store', 'timer1-preset-half-store',
      'timer0-count-store', 'timer1-count-store',
      'timer0-count-byte-store', 'timer1-count-byte-store',
      'timer0-count-half-store', 'timer1-count-half-store'
    ];
    const ovVariants = [
      'add-overflow-delay-taken', 'add-overflow-delay-not-taken',
      'addi-overflow-delay-taken', 'addi-overflow-delay-not-taken',
      'sub-overflow-delay-taken', 'sub-overflow-delay-not-taken'
    ];
    const generatedAdelVariants = result.probe?.scenarios.filter((scenario) => scenario.kind === 'adel').map((scenario) => scenario.variant) ?? [];
    const generatedAdesVariants = result.probe?.scenarios.filter((scenario) => scenario.kind === 'ades').map((scenario) => scenario.variant) ?? [];
    const generatedRiVariants = result.probe?.scenarios.filter((scenario) => scenario.kind === 'ri').map((scenario) => scenario.variant) ?? [];
    const generatedOvVariants = result.probe?.scenarios.filter((scenario) => scenario.kind === 'ov').map((scenario) => scenario.variant) ?? [];
    expect(generatedAdelVariants).toHaveLength(adelVariants.length);
    expect(generatedAdesVariants).toHaveLength(adesVariants.length);
    expect(generatedOvVariants.slice(0, ovVariants.length)).toEqual(ovVariants);
    expect(new Set(generatedAdelVariants)).toEqual(new Set(adelVariants));
    expect(new Set(generatedAdesVariants)).toEqual(new Set(adesVariants));
    expect(new Set(generatedRiVariants)).toEqual(new Set(p7RiWordCatalog.map((entry) => entry.variant)));
    expect(new Set(generatedOvVariants)).toEqual(new Set(ovVariants));
    const variantPatterns = new Map<string, RegExp>([
      ['misaligned-load-delay-taken', /beq \$0, \$0,[^\n]+\n\s*lw \$\d+, 1\(\$0\)/],
      ['misaligned-load-delay-not-taken', /bne \$0, \$0,[^\n]+\n\s*lw \$\d+, 1\(\$0\)/],
      ['misaligned-half-load-delay-taken', /beq \$0, \$0,[^\n]+\n\s*lh \$\d+, 1\(\$0\)/],
      ['misaligned-half-load-delay-not-taken', /bne \$0, \$0,[^\n]+\n\s*lh \$\d+, 1\(\$0\)/],
      ['ea-overflow-load', /lui \$20, 0x7fff[\s\S]*ori \$20, \$20, 0xffff[\s\S]*lw \$\d+, 1\(\$20\)/],
      ['dm-out-of-range-load', /\blw \$\d+, 0x3000\(\$0\)/],
      ['timer-byte-load', /\blb \$\d+, 0x7f00\(\$0\)/],
      ['timer-half-load', /\blh \$\d+, 0x7f00\(\$0\)/],
      ['invalid-fetch', /ori \$20, \$0, 0x7000[\s\S]*jr \$20\s*\n\s*nop/],
      ['misaligned-fetch', /ori \$20, \$0, 0x3002[\s\S]*jr \$20\s*\n\s*nop/],
      ['misaligned-store-delay-taken', /beq \$0, \$0,[^\n]+\n\s*sw \$\d+, 1\(\$0\)/],
      ['misaligned-store-delay-not-taken', /bne \$0, \$0,[^\n]+\n\s*sw \$\d+, 1\(\$0\)/],
      ['misaligned-half-store-delay-taken', /beq \$0, \$0,[^\n]+\n\s*sh \$\d+, 1\(\$0\)/],
      ['misaligned-half-store-delay-not-taken', /bne \$0, \$0,[^\n]+\n\s*sh \$\d+, 1\(\$0\)/],
      ['ea-overflow-store', /lui \$20, 0x7fff[\s\S]*ori \$20, \$20, 0xffff[\s\S]*sw \$\d+, 1\(\$20\)/],
      ['dm-out-of-range-store', /\bsw \$\d+, 0x3000\(\$0\)/],
      ['timer0-ctrl-byte-store', /\bsb \$20, 0x7f00\(\$0\)/],
      ['timer1-ctrl-byte-store', /\bsb \$20, 0x7f10\(\$0\)/],
      ['timer0-ctrl-half-store', /\bsh \$20, 0x7f00\(\$0\)/],
      ['timer1-ctrl-half-store', /\bsh \$20, 0x7f10\(\$0\)/],
      ['timer0-preset-byte-store', /\bsb \$20, 0x7f04\(\$0\)/],
      ['timer1-preset-byte-store', /\bsb \$20, 0x7f14\(\$0\)/],
      ['timer0-preset-half-store', /\bsh \$20, 0x7f04\(\$0\)/],
      ['timer1-preset-half-store', /\bsh \$20, 0x7f14\(\$0\)/],
      ['timer0-count-store', /\bsw \$20, 0x7f08\(\$0\)/],
      ['timer1-count-store', /\bsw \$20, 0x7f18\(\$0\)/],
      ['add-overflow-delay-taken', /beq \$0, \$0,[^\n]+\n\s*add \$22, \$20, \$21/],
      ['add-overflow-delay-not-taken', /bne \$0, \$0,[^\n]+\n\s*add \$22, \$20, \$21/],
      ['addi-overflow-delay-taken', /beq \$0, \$0,[^\n]+\n\s*addi \$22, \$20, 1/],
      ['addi-overflow-delay-not-taken', /bne \$0, \$0,[^\n]+\n\s*addi \$22, \$20, 1/],
      ['sub-overflow-delay-taken', /beq \$0, \$0,[^\n]+\n\s*sub \$22, \$20, \$21/],
      ['sub-overflow-delay-not-taken', /bne \$0, \$0,[^\n]+\n\s*sub \$22, \$20, \$21/],
      ['delay-slot', /beq \$0, \$0, _co_probe_s\d+_done[\s\S]*syscall/],
      ['post-eret-status', /syscall[\s\S]*mfc0 \$8, \$12[\s\S]*sw \$8, 0x27d8\(\$0\)/],
      ['young-mult', /syscall\s*\n\s*mult \$20, \$21/],
      ['young-div', /syscall\s*\n\s*div \$20, \$21/],
      ['young-mthi', /syscall\s*\n\s*mthi \$20/],
      ['young-mtlo', /syscall\s*\n\s*mtlo \$21/],
      ['unknown-opcode', /\.word 0xfc000000/],
      ['unknown-funct', /\.word 0x0000003f/]
    ]);
    for (const [register, address] of [
      ['timer0-preset', '7f04'], ['timer0-count', '7f08'],
      ['timer1-ctrl', '7f10'], ['timer1-preset', '7f14'], ['timer1-count', '7f18']
    ]) {
      variantPatterns.set(`${register}-byte-load`, new RegExp(`lb \\$\\d+, 0x${address}\\(\\$0\\)`));
      variantPatterns.set(`${register}-half-load`, new RegExp(`lh \\$\\d+, 0x${address}\\(\\$0\\)`));
    }
    for (const [timer, address] of [['timer0', '7f08'], ['timer1', '7f18']]) {
      variantPatterns.set(`${timer}-count-byte-store`, new RegExp(`sb \\$20, 0x${address}\\(\\$0\\)`));
      variantPatterns.set(`${timer}-count-half-store`, new RegExp(`sh \\$20, 0x${address}\\(\\$0\\)`));
    }
    for (const scenario of internalScenarios) {
      if (scenario.variant) {
        const pattern = variantPatterns.get(scenario.variant);
        if (!pattern) {
          throw new Error(`missing probe variant pattern for ${scenario.variant}`);
        }
        expect(probeScenarioBlock(sourceByScenario.get(scenario)!, scenario.id)).toMatch(pattern);
      }
    }
    const invalidFetch = result.probe?.scenarios.find((scenario) => scenario.variant === 'invalid-fetch');
    expect(invalidFetch).toMatchObject({ expectedBd: false, allowedEpc: [0x7000], victimPc: 0x7000 });
    expect(result.text).toContain('mfc0 $24, $13');
    expect(result.text).toContain('mfc0 $25, $12');
    expect(result.text).toContain('mfc0 $23, $14');
    expect(result.text).not.toMatch(/mfc0\s+\$\d+,\s*\$8\b/);
    expect(result.text).toContain(`sb $0, ${p7Hex(p7ExternalInterruptAckAddress)}($0)`);
    expect(result.text).toContain(`sw $26, ${p7Hex(p7Timer0Preset)}($0)`);
    expect(result.text).toContain(`sw $26, ${p7Hex(p7Timer0Ctrl)}($0)`);
    expect(result.text).toContain(`sw $26, ${p7Hex(p7Timer1Preset)}($0)`);
    expect(result.text).toContain(`sw $26, ${p7Hex(p7Timer1Ctrl)}($0)`);
    expect(result.text).not.toContain(`sw $26, ${p7Hex(p7Timer0Count)}($0)`);
    expect(result.text).not.toContain(`sw $26, ${p7Hex(p7Timer1Count)}($0)`);
    expect(result.text).toContain(`sw $26, ${p7Hex(p7ProbeExternalArmAddress)}($0)`);
    expect(result.text).toEqual(expect.stringContaining('.word 0xfc000000'));
    expect(result.text).toEqual(expect.stringContaining('.word 0x0000003f'));
    expect(result.text).not.toContain('_co_internal_unknown_instruction');

    const timerAdesScenarios = result.probe?.scenarios.filter((scenario) =>
      scenario.kind === 'ades' && scenario.variant?.startsWith('timer')) ?? [];
    expect(timerAdesScenarios).toHaveLength(14);
    for (const scenario of timerAdesScenarios) {
      const expected = scenario.expectedRecords?.[0];
      expect(expected?.requireEqualAuxPair).toBe(true);
      expect(expected?.auxPairDescription).toContain('before/after invalid store');
      const target = scenario.variant?.includes('timer1')
        ? scenario.variant.includes('ctrl') ? 0x7f10 : scenario.variant.includes('preset') ? 0x7f14 : 0x7f18
        : scenario.variant?.includes('ctrl') ? 0x7f00 : scenario.variant?.includes('preset') ? 0x7f04 : 0x7f08;
      expect(probeScenarioBlock(sourceByScenario.get(scenario)!, scenario.id)).toContain(`lw $21, ${p7Hex(target)}($0)`);
      if (scenario.variant?.includes('ctrl')) {
        expect(expected?.allowedAuxPairs).toEqual([[0, 0]]);
      } else if (scenario.variant?.includes('preset')) {
        expect(expected?.allowedAuxPairs).toEqual([[0x13579bdf, 0x13579bdf]]);
      } else {
        expect(expected?.allowedAuxPairs).toBeUndefined();
      }
    }
    for (const address of [0x7f00, 0x7f04, 0x7f08, 0x7f10, 0x7f14, 0x7f18]) {
      expect(result.text).toContain(`lw $22, ${p7Hex(address)}($0)`);
    }
  });

  it('arms P7 probe timers only after the return PC is staged', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-probe-timer-setup',
      interrupt: false,
      p7StressMode: 'probe',
      probeShard: 'timer',
      timerInterrupt: true,
      probeScenarioCount: 10,
      exceptionTypes: []
    });
    const scenario = result.probe?.scenarios.find((item) => item.kind === 'timer0' || item.kind === 'timer1');
    if (!scenario) {
      throw new Error('missing timer probe scenario');
    }
    const timerStart = result.text.indexOf(`# probe scenario ${scenario.id}: ${scenario.kind}`);
    const waitLabel = result.text.indexOf(`_co_probe_s${scenario.id}_wait:`, timerStart);
    const doneStore = result.text.lastIndexOf(`sw $26, ${p7Hex(p7ProbeStateDonePc)}($0)`, waitLabel);
    const enableStatus = result.text.indexOf('mtc0 $26, $12', timerStart);

    expect(result.text.slice(timerStart, waitLabel)).toContain('jal _co_probe_guard');
    expect(result.text).toContain('_co_probe_guard:');
    expect(result.text).toContain(`sw $0, ${p7Hex(p7Timer0Ctrl)}($0)`);
    expect(result.text).toContain(`sw $0, ${p7Hex(p7Timer1Ctrl)}($0)`);
    expect(doneStore).toBeGreaterThan(timerStart);
    expect(enableStatus).toBeGreaterThan(doneStore);
    expect(waitLabel).toBeGreaterThan(enableStatus);
    expect(scenario.allowedEpc).toContain(scenario.waitPc);
    expect(scenario.allowedEpc).not.toContain((scenario.waitPc ?? 0) + 4);
    expect(scenario.allowedEpc.some((pc) => pc < (scenario.waitPc ?? 0))).toBe(true);
    expect(scenario.timerPreset).toBeGreaterThanOrEqual(p7ProbeTimerPresetMin);
    expect(scenario.timerPreset).toBeLessThanOrEqual(p7ProbeTimerPresetMax);
  });

  it('packs interrupt-priority replay into one physical probe record', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-priority-replay',
      interrupt: true,
      externalInterruptIntensity: 1,
      p7StressMode: 'probe',
      probeShard: 'core',
      timerInterrupt: true,
      probeScenarioCount: p7ProbeDefaultScenarioCount
    });
    const scenario = result.probe?.scenarios.find((item) => item.variant === 'priority-syscall');

    expect(result.probe?.scenarios).toHaveLength(64);
    expect(result.probe?.scenarios.every((item) => item.requireCompletion)).toBe(true);
    expect(scenario?.kind).toBe('external');
    expect(scenario?.expectedRecords).toEqual([
      expect.objectContaining({ expectedIpMask: 0x1000, expectedExcCode: 0, expectedBd: false, allowedEpc: [scenario?.victimPc] }),
      expect.objectContaining({ expectedIpMask: 0, expectedExcCode: 8, expectedBd: false, allowedEpc: [scenario?.victimPc] })
    ]);
    expect(scenario?.externalDelayCycles).toBe(0);
    expect(scenario?.requireCompletion).toBe(true);
    expect(result.text).toContain('_co_probe_capture_priority_interrupt:');
    expect(result.text).toContain('_co_probe_record_priority_exception:');
    for (const [variant, excCode] of [
      ['priority-syscall', 8],
      ['priority-adel', 4],
      ['priority-ades', 5],
      ['priority-ov', 12],
      ['priority-ri', 10]
    ] as const) {
      const priority = result.probe?.scenarios.find((item) => item.variant === variant);
      expect(priority?.expectedRecords?.[0]).toEqual(expect.objectContaining({
        expectedIpMask: 0x1000,
        expectedExcCode: 0
      }));
      expect(priority?.expectedRecords?.[1]).toEqual(expect.objectContaining({
        expectedIpMask: 0,
        expectedExcCode: excCode,
        allowedEpc: [priority?.victimPc]
      }));
      if (variant === 'priority-ov') {
        expect(probeScenarioBlock(result.text, priority?.id ?? 0)).toMatch(
          /lui \$8, 0x7fff[\s\S]*ori \$8, \$8, 0xffff[\s\S]*addi \$9, \$8, 1/
        );
      }
    }
    for (const variant of [
      'retry-store',
      'retry-load-dependency',
      'retry-jal',
      'retry-delay-slot-store-taken',
      'retry-delay-slot-store-not-taken'
    ]) {
      const retry = result.probe?.scenarios.find((item) => item.variant === variant);
      expect(retry?.externalDelayCycles).toBe(0);
      expect(retry?.requiredCommits).toHaveLength(1);
      expect(retry?.requireCompletion).toBe(true);
    }
  });

  it('keeps P7 probe and interrupt scaffolding independent from a narrow payload focus', () => {
    const probe = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: 'ori',
      instructionCount: 200,
      seed: 'p7-fixed-probe-harness',
      interrupt: true,
      timerInterrupt: true,
      p7StressMode: 'probe',
      probeShard: 'core',
      probeScenarioCount: p7ProbeDefaultScenarioCount
    });
    const anchor = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: 'eret jr mult',
      instructionCount: 64,
      seed: 'p7-fixed-anchor-harness',
      interrupt: true,
      exceptionTypes: []
    });

    expect(probe.instructionSet).toEqual(['ori']);
    expect(probe.usedInstructions).toContain('mfc0');
    expect(probe.usedInstructions).toContain('eret');
    expect(probe.usedInstructions).toContain('sltu');
    expect(probe.text).toContain('instruction_set_scope: randomized payload focus');
    expect(anchor.instructionSet).toEqual(['eret', 'jr', 'mult']);
    expect(anchor.interruptSchedule).toHaveLength(1);
    expect(anchor.text).toContain('ori $25, $25, 0');
    expect(anchor.text).toContain('eret');
    expect(anchor.usedInstructions).toContain('nop');
  });

  it('covers masked external windows, post-eret Status, and timer mode boundaries', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-control-state-boundaries',
      interrupt: true,
      timerInterrupt: true,
      p7StressMode: 'probe',
      probeShard: 'core',
      probeScenarioCount: p7ProbeDefaultScenarioCount
    });
    const timerResult = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-control-state-boundaries-timer',
      interrupt: false,
      timerInterrupt: true,
      p7StressMode: 'probe',
      probeShard: 'timer',
      probeScenarioCount: 10
    });

    for (const variant of ['masked-ie', 'masked-im2']) {
      const scenario = result.probe?.scenarios.find((item) => item.variant === variant);
      expect(scenario?.kind).toBe('external');
      expect(scenario?.triggerPc).toBeDefined();
      expect(scenario?.triggerPc).not.toBe(scenario?.waitPc);
      expect(scenario?.requiredPreHandlerCommits).toHaveLength(1);
      expect(scenario?.allowedEpc.every((pc) => pc > (scenario.triggerPc ?? pc))).toBe(true);
      const block = probeScenarioBlock(result.text, scenario?.id ?? 0);
      expect(block).toContain(variant === 'masked-ie'
        ? 'ori $26, $0, 0x1c00'
        : 'ori $26, $0, 0xc01');
    }
    const postEret = result.probe?.scenarios.find((item) => item.variant === 'post-eret-status');
    expect(postEret?.requiredCommits).toEqual([
      expect.objectContaining({ kind: 'grf', target: 8, value: 0x1c01 }),
      expect.objectContaining({ kind: 'dm', target: 0x27d8, value: 0x1c01 })
    ]);
    for (const kind of ['timer0', 'timer1'] as const) {
      const timers = timerResult.probe?.scenarios.filter((item) => item.kind === kind) ?? [];
      expect(new Set(timers.map((item) => item.variant))).toEqual(new Set([
        'mode0-min', 'mode0-max', 'mode1-repeat', 'disable-reload', 'write-priority'
      ]));
      expect(timers.find((item) => item.variant === 'mode0-min')?.timerPreset).toBe(p7ProbeTimerPresetMin);
      expect(timers.find((item) => item.variant === 'mode0-max')?.timerPreset).toBe(p7ProbeTimerPresetMax);
      for (const timer of timers.filter((item) => item.variant?.startsWith('mode0-'))) {
        expect(timer.expectedRecords?.[0].allowedAuxPairs).toEqual([[8, 0]]);
      }
      for (const timer of timers.filter((item) => item.variant === 'mode1-repeat')) {
        expect(timer.expectedRecords?.[0].allowedIpMasks).toEqual([0, kind === 'timer0' ? 0x0400 : 0x0800]);
        expect(timer.expectedRecords).toHaveLength(2);
        expect(timer.expectedRecords?.[0].allowedBdEpc).toHaveLength(1);
        expect(timer.expectedRecords?.[1].allowedBdEpc).toHaveLength(1);
        expect(timer.expectedRecords?.[0].allowedBdEpc).not.toEqual(timer.expectedRecords?.[1].allowedBdEpc);
        expect(timer.requiredPreHandlerCommits).toEqual([
          expect.objectContaining({ kind: 'grf', target: 11, value: 1 }),
          expect.objectContaining({ kind: 'grf', target: 11, value: 2 }),
          expect.objectContaining({ kind: 'grf', target: 15, value: 0 }),
          expect.objectContaining({ kind: 'dm', target: 0x27dc, value: 0x7100 | timer.id })
        ]);
        const block = probeScenarioBlock(timerResult.text, timer.id);
        expect(block).toMatch(/ori \$26, \$0, 0xb\s*\n\s*sw \$26, 0x7f(?:00|10)\(\$0\)/);
        expect(block).not.toMatch(/ori \$26, \$0, 0xd\s*\n\s*sw \$26, 0x7f(?:00|10)\(\$0\)/);
        expect(block).toMatch(
          /lw \$12, 0x7f(?:08|18)\(\$0\)[\s\S]*sltu \$13, \$10, \$12[\s\S]*addi \$11, \$11, 1[\s\S]*bne \$11, \$14, _co_probe_s\d+_mode1_poll/
        );
        expect(block).toMatch(
          /ori \$14, \$0, 16[\s\S]*sltu \$13, \$12, \$14[\s\S]*mfc0 \$15, \$13[\s\S]*andi \$15, \$15, 0x(?:400|800)[\s\S]*sw \$15, 0x27dc\(\$0\)/
        );
      }
      const reload = timers.find((item) => item.variant === 'disable-reload');
      expect(reload?.expectedExcCode).toBe(8);
      expect(probeScenarioBlock(timerResult.text, reload?.id ?? 0)).toMatch(
        /bne \$10, \$11, _co_probe_s\d+_bad_timer_state[\s\S]*sltu \$12, \$10, \$11[\s\S]*beq \$12, \$0, _co_probe_s\d+_bad_timer_state/
      );
      const writePriority = timers.find((item) => item.variant === 'write-priority');
      expect(writePriority?.expectedExcCode).toBe(8);
      expect(writePriority?.requiredPreHandlerCommits).toEqual([
        expect.objectContaining({ kind: 'grf', target: 11, value: 0 }),
        expect.objectContaining({ kind: 'grf', target: 12, value: 0 }),
        expect.objectContaining({ kind: 'grf', target: 13, value: 0x40 }),
        expect.objectContaining({ kind: 'grf', target: 14, value: 0 }),
        expect.objectContaining({ kind: 'grf', target: 15, value: 0 }),
        expect.objectContaining({ kind: 'grf', target: 16, value: 0x20 })
      ]);
      const writePriorityBlock = probeScenarioBlock(timerResult.text, writePriority?.id ?? 0);
      expect(writePriorityBlock).toMatch(
        /sw \$8, 0x7f(?:04|14)\(\$0\)\s*\n\s*sw \$9, 0x7f(?:00|10)\(\$0\)\s*\n\s*sw \$10, 0x7f(?:04|14)\(\$0\)\s*\n\s*lw \$11, 0x7f(?:08|18)\(\$0\)\s*\n\s*lw \$12, 0x7f(?:08|18)\(\$0\)\s*\n\s*lw \$13, 0x7f(?:08|18)\(\$0\)/
      );
      expect(writePriorityBlock).toMatch(
        /sw \$8, 0x7f(?:04|14)\(\$0\)\s*\n\s*sw \$9, 0x7f(?:00|10)\(\$0\)\s*\n\s*sw \$9, 0x7f(?:00|10)\(\$0\)\s*\n\s*lw \$14, 0x7f(?:08|18)\(\$0\)\s*\n\s*lw \$15, 0x7f(?:08|18)\(\$0\)\s*\n\s*lw \$16, 0x7f(?:08|18)\(\$0\)/
      );
    }
    const handler = timerResult.text.slice(timerResult.text.indexOf('_co_probe_handler:'));
    expect(timerResult.text).not.toContain('${');
    const declaredUsedInstructions = new Set(timerResult.usedInstructions);
    expect(executableMnemonics(timerResult.text).filter((mnemonic) => !declaredUsedInstructions.has(mnemonic))).toEqual([]);
    expect(handler.indexOf('lw $20, 0x7f00($0)')).toBeLessThan(handler.indexOf('sw $0, 0x7f00($0)'));
    expect(handler).toMatch(/andi \$26, \$22, 2048\s*\n\s*bne \$26, \$0, _co_probe_record_repeat_timer_interrupt/);
    expect(handler).toMatch(/ori \$26, \$0, 3\s*\n\s*sw \$26, 0x7f(?:00|10)\(\$0\)/);
    expect(handler).toMatch(/lui \$26, 0xbad1\s*\n\s*ori \$26, \$26, 0x1\s*\n\s*sw \$26, 0x27dc\(\$0\)/);
    expect(timerResult.text).toContain('_co_probe_record_repeat_timer_interrupt:');
    expect(timerResult.text).toContain('_co_probe_write_repeat_timer_record:');
  });

  it('covers every younger state-changing MDU instruction with exact HI/LO sentinels', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-younger-mdu',
      interrupt: true,
      p7StressMode: 'probe',
      probeShard: 'core',
      timerInterrupt: true,
      probeScenarioCount: p7ProbeDefaultScenarioCount
    });
    const variants = ['young-mult', 'young-div', 'young-mthi', 'young-mtlo'];

    for (const variant of variants) {
      const scenario = result.probe?.scenarios.find((item) => item.variant === variant);
      expect(scenario?.kind).toBe('syscall');
      expect(scenario?.expectedBd).toBe(false);
      expect(scenario?.expectedRecords?.[0].allowedAuxPairs).toEqual([[0x13579bdf, 0x2468ace0]]);
      expect(scenario?.requireCompletion).toBe(true);
      expect(probeScenarioBlock(result.text, scenario?.id ?? 0)).toMatch(new RegExp(`syscall\\s*\\n\\s*${variant.slice(6)}`));
    }
    expect(result.text).toContain('mfhi $22');
    expect(result.text).toContain('mflo $22');
  });

  it('restricts an external P7 probe EPC to its macroscopic-PC wait target', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-probe-external-epc',
      interrupt: true,
      externalInterruptIntensity: 1,
      p7StressMode: 'probe',
      probeShard: 'core',
      timerInterrupt: false,
      probeScenarioCount: 1,
      exceptionTypes: []
    });
    const scenario = result.probe?.scenarios[0];

    expect(scenario?.kind).toBe('external');
    expect(scenario?.allowedEpc).toEqual([scenario?.waitPc]);
  });

  it('records the actual syscall PC for internal P7 probe scenarios', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-probe-internal',
      interrupt: false,
      p7StressMode: 'probe',
      timerInterrupt: false,
      probeScenarioCount: 1,
      exceptionTypes: ['Syscall']
    });
    const scenario = result.probe?.scenarios[0];
    const bodyLines = instructionSlotLines(beforeKernelText(result.text));
    const syscallIndex = bodyLines.indexOf('syscall');
    const branchIndex = syscallIndex - 1;
    const scenarioStart = result.text.indexOf('# probe scenario 1: syscall');
    const syscallTextIndex = result.text.indexOf('\n    syscall', scenarioStart);

    expect(scenario?.kind).toBe('syscall');
    expect(scenario?.expectedExcCode).toBe(8);
    expect(scenario?.expectedBd).toBe(true);
    expect(bodyLines[branchIndex]).toBe('beq $0, $0, _co_probe_s1_done');
    expect(scenario?.allowedEpc).toEqual([p7UserTextBaseAddress + branchIndex * 4]);
    expect(scenario?.victimPc).toBe(p7UserTextBaseAddress + syscallIndex * 4);
    expect(scenario?.donePc).toBe(p7UserTextBaseAddress + (syscallIndex + 1) * 4);
    expect(result.text.slice(scenarioStart, syscallTextIndex)).toContain('mtc0 $26, $12');
    expect(result.text.slice(scenarioStart, syscallTextIndex)).toContain(`sw $26, ${p7Hex(p7ProbeStateDonePc)}($0)`);
    expect(result.text.slice(result.text.indexOf('_co_probe_record_internal:'))).toContain(`lw $23, ${p7Hex(p7ProbeStateDonePc)}($0)`);
    expect(result.text).not.toContain('addi $23, $23, 4');
    expect(result.text).toMatch(/eret\s*\n\s*sw \$0, 0x27d4\(\$0\)/);
  });

  it('puts the RI probe in a not-taken branch delay slot', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-probe-ri-delay-slot',
      interrupt: false,
      p7StressMode: 'probe',
      timerInterrupt: false,
      probeScenarioCount: 1,
      exceptionTypes: ['RI']
    });
    const scenario = result.probe?.scenarios[0];
    const bodyLines = instructionSlotLines(beforeKernelText(result.text));
    const riIndex = bodyLines.indexOf('.word 0xfc000000');
    const branchIndex = riIndex - 1;

    expect(scenario?.kind).toBe('ri');
    expect(scenario?.variant).toBe('unknown-opcode');
    expect(scenario?.expectedBd).toBe(true);
    expect(bodyLines[branchIndex]).toBe('bne $0, $0, _co_probe_s1_done');
    expect(scenario?.allowedEpc).toEqual([p7UserTextBaseAddress + branchIndex * 4]);
    expect(scenario?.victimPc).toBe(p7UserTextBaseAddress + riIndex * 4);
    expect(scenario?.donePc).toBe(p7UserTextBaseAddress + (riIndex + 1) * 4);
  });

  it('marks both taken and not-taken AdEL delay-slot victims with BD', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-probe-adel-bd',
      interrupt: false,
      p7StressMode: 'probe',
      timerInterrupt: false,
      probeScenarioCount: 2,
      exceptionTypes: ['AdEL']
    });
    const scenarios = result.probe?.scenarios ?? [];

    expect(scenarios.map((scenario) => scenario.variant)).toEqual([
      'misaligned-load-delay-taken',
      'misaligned-load-delay-not-taken'
    ]);
    expect(scenarios.every((scenario) => scenario.kind === 'adel' && scenario.expectedBd === true)).toBe(true);
    expect(scenarios.every((scenario) => scenario.victimPc === (scenario.allowedEpc[0] ?? 0) + 4)).toBe(true);
  });

  it('caps P7 probe scenario count at the log capacity without overlapping the handler', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-probe-max',
      interrupt: true,
      p7StressMode: 'probe',
      probeShard: 'core',
      timerInterrupt: true,
      probeScenarioCount: 99
    });
    const mainText = beforeKernelText(result.text);
    const mainLines = instructionSlotLines(mainText);

    expect(result.probe?.scenarios).toHaveLength(p7ProbeMaxScenarioCount);
    expect(mainLines.length).toBeLessThanOrEqual((p7ExceptionHandlerAddress - p7UserTextBaseAddress) / 4);
    expect(mainText).toMatch(/_co_probe_all_done:\s*\n\s*beq \$0, \$0, _co_probe_all_done\s*\n\s*nop\s*$/);
  });

  it('completes the hardened Mode-1 protocol against the official timer cycle model', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: p7CourseInstructionCountMaximum,
      seed: 'p7-mode1-official-cycle-model',
      p7StressMode: 'probe',
      probeShard: 'timer',
      interrupt: false,
      timerInterrupt: true,
      probeScenarioCount: 10
    });
    const assembled = assembleCourseSource({ id: 'probe', text: result.text }, { profile: 'P7' });
    expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
    const haltPc = p7UserTextBaseAddress + (result.instructionCount - 2) * 4;
    const deviceTimeline = Array.from({ length: 5_000 }, (_, afterInstruction) => ({
      afterInstruction,
      cycles: 1
    }));
    const executed = executeProgramForService({
      profile: 'P7',
      segments: assembled.image!.segments,
      entryPc: assembled.image!.entryPc,
      haltPc,
      maxSteps: deviceTimeline.length,
      enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
      deviceSchedule: { kind: 'timeline', entries: deviceTimeline },
      collectTrace: true
    });
    const trace = (executed.trace ?? []).join('\n');
    const checked = checkP7Probe(trace, parseSimOutput(trace), result.probe!);

    expect(executed).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
    expect(checked.failures).toEqual([]);
    expect(checked.records).toHaveLength(10);
    expect((executed.trace ?? []).filter((line) => line.includes('*000027DC <= 000071'))).toHaveLength(2);
    expect(trace).not.toContain('BAD10001');
  });
});

interface MduReadProbe {
  source: string;
  distance: number;
}

const longMduWrites = new Set(['mult', 'multu', 'div', 'divu']);
const allHiLoWrites = new Set(['mult', 'multu', 'div', 'divu', 'mthi', 'mtlo']);
const hiLoReads = new Set(['mfhi', 'mflo']);

function executableMnemonics(text: string): string[] {
  return executableLines(text).map((line) => {
    const match = /^([a-z][a-z0-9]*)\b/.exec(line);
    return match ? match[1] : '';
  }).filter(Boolean);
}

function executableLines(text: string): string[] {
  const result: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('.') || trimmed.endsWith(':')) {
      continue;
    }
    const match = /^([a-z][a-z0-9]*)\b/.exec(trimmed);
    if (match) {
      result.push(trimmed);
    }
  }
  return result;
}

function instructionSlotLines(text: string): string[] {
  const result: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.endsWith(':')) {
      continue;
    }
    if (trimmed.startsWith('.')) {
      if (/^\.word\b/i.test(trimmed)) {
        result.push(trimmed);
      }
      continue;
    }
    const match = /^(_?[a-z][a-z0-9_]*)\b/.exec(trimmed);
    if (match) {
      result.push(trimmed);
    }
  }
  return result;
}

function beforeKernelText(text: string): string {
  return text.split(/^\.ktext\b/m)[0];
}

function beforeGeneratedHalt(text: string): string {
  return beforeKernelText(text).split(/^_co_test_end:\s*$/m)[0];
}

function exceptionVictimIndices(lines: string[]): number[] {
  const victims: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === 'syscall' || /^\.word\b/.test(line) || /\b(lw|lh|lhu|sw|sh)\b.*1\(\$0\)/.test(line)) {
      victims.push(index);
    }
  }
  return victims;
}

function isInExceptionFlushShadow(index: number, victims: number[]): boolean {
  return victims.some((victim) => index > victim && index <= victim + 2);
}

function mduReadProbeDistances(mnemonics: string[]): MduReadProbe[] {
  const probes: MduReadProbe[] = [];
  for (let i = 0; i < mnemonics.length; i++) {
    const source = mnemonics[i];
    if (!longMduWrites.has(source)) {
      continue;
    }
    const readIndex = mnemonics.findIndex((mnemonic, index) => index > i && hiLoReads.has(mnemonic));
    if (readIndex >= 0) {
      probes.push({ source, distance: readIndex - i - 1 });
    }
  }
  return probes;
}

function isBusyMduReadProbe(probe: MduReadProbe): boolean {
  const busyCycles = probe.source === 'div' || probe.source === 'divu' ? 10 : 5;
  return probe.distance >= 1 && probe.distance <= busyCycles;
}

function isReadyMduReadProbe(probe: MduReadProbe): boolean {
  const busyCycles = probe.source === 'div' || probe.source === 'divu' ? 10 : 5;
  return probe.distance >= busyCycles + 1;
}

function mduWriteViolationsDuringStartOrBusy(mnemonics: string[]): string[] {
  const violations: string[] = [];
  for (let i = 0; i < mnemonics.length; i++) {
    const source = mnemonics[i];
    if (!longMduWrites.has(source)) {
      continue;
    }
    const protectedSlots = (source === 'div' || source === 'divu' ? 10 : 5) + 1;
    for (let offset = 1; offset <= protectedSlots && i + offset < mnemonics.length; offset++) {
      const mnemonic = mnemonics[i + offset];
      if (hiLoReads.has(mnemonic)) {
        break;
      }
      if (allHiLoWrites.has(mnemonic)) {
        violations.push(`${source}->${mnemonic}@+${offset}`);
      }
    }
  }
  return violations;
}

function inspectSimpleMemoryProgram(lines: string[]): {
  addresses: number[];
  offsetSigns: Set<string>;
  baseSigns: string[];
} {
  const state = new CpuState();
  const addresses: number[] = [];
  const offsetSigns = new Set<string>();
  const baseSigns: string[] = [];

  for (const line of lines) {
    const lui = /^lui\s+(\$\d+),\s*(-?(?:0x[\da-f]+|\d+))$/i.exec(line);
    if (lui) {
      state.setRegister(lui[1], Number(lui[2]) << 16);
      continue;
    }
    const ori = /^ori\s+(\$\d+),\s*(\$\d+),\s*(-?(?:0x[\da-f]+|\d+))$/i.exec(line);
    if (ori) {
      state.setRegister(ori[1], state.regValue(ori[2]) | (Number(ori[3]) & 0xffff));
      continue;
    }
    const memory = /^(lw|sw)\s+(\$\d+),\s*(-?(?:0x[\da-f]+|\d+))\((\$\d+)\)$/i.exec(line);
    if (!memory) {
      continue;
    }
    const offset = signExtend16(Number(memory[3]));
    const base = signed32(state.regValue(memory[4]));
    const address = base + offset;
    if (address < 0 || address > 0x2ffc || address % 4 !== 0) {
      throw new Error(`illegal generated memory operand: ${line} -> ${address}`);
    }
    addresses.push(address);
    offsetSigns.add(offset < 0 ? 'negative' : offset > 0 ? 'positive' : 'zero');
    baseSigns.push(base < 0 ? 'negative' : base > 0 ? 'positive' : 'zero');
    if (memory[1] === 'lw') {
      state.setRegister(memory[2], state.wordAt(address));
    } else {
      state.memory.set(address, state.regValue(memory[2]));
    }
  }
  return { addresses, offsetSigns, baseSigns };
}

function hiLoUndefinedReads(mnemonics: string[]): string[] {
  const violations: string[] = [];
  let hiInitialized = false;
  let loInitialized = false;
  for (const mnemonic of mnemonics) {
    if (mnemonic === 'mfhi' && !hiInitialized) {
      violations.push('mfhi');
    }
    if (mnemonic === 'mflo' && !loInitialized) {
      violations.push('mflo');
    }
    if ((mnemonic === 'madd' || mnemonic === 'maddu' || mnemonic === 'msub' || mnemonic === 'msubu') &&
      (!hiInitialized || !loInitialized)) {
      violations.push(mnemonic);
    }
    if (mnemonic === 'mul') {
      hiInitialized = false;
      loInitialized = false;
    } else if (mnemonic === 'mthi') {
      hiInitialized = true;
    } else if (mnemonic === 'mtlo') {
      loInitialized = true;
    } else if (
      mnemonic === 'mult' || mnemonic === 'multu' || mnemonic === 'div' || mnemonic === 'divu' ||
      mnemonic === 'madd' || mnemonic === 'maddu' || mnemonic === 'msub' || mnemonic === 'msubu'
    ) {
      hiInitialized = true;
      loInitialized = true;
    }
  }
  return violations;
}

function arithmeticOverflowCount(lines: string[]): number {
  const state = new CpuState();
  let overflows = 0;
  for (const line of lines) {
    const lui = /^lui\s+(\$\d+),\s*(-?(?:0x[\da-f]+|\d+))$/i.exec(line);
    if (lui) {
      state.setRegister(lui[1], Number(lui[2]) << 16);
      continue;
    }
    const ori = /^ori\s+(\$\d+),\s*(\$\d+),\s*(-?(?:0x[\da-f]+|\d+))$/i.exec(line);
    if (ori) {
      state.setRegister(ori[1], state.regValue(ori[2]) | (Number(ori[3]) & 0xffff));
      continue;
    }
    const arithmetic = /^(add|sub)\s+(\$\d+),\s*(\$\d+),\s*(\$\d+)$/i.exec(line);
    if (!arithmetic) {
      continue;
    }
    const left = signed32(state.regValue(arithmetic[3]));
    const right = signed32(state.regValue(arithmetic[4]));
    const result = arithmetic[1] === 'add' ? left + right : left - right;
    if (result > 0x7fffffff || result < -0x80000000) {
      overflows++;
    }
    state.setRegister(arithmetic[2], result);
  }
  return overflows;
}

function conditionalMoveOutcomes(lines: string[]): Map<string, Set<boolean>> {
  const state = new CpuState();
  const outcomes = new Map<string, Set<boolean>>([
    ['movn', new Set<boolean>()],
    ['movz', new Set<boolean>()]
  ]);
  for (const line of lines) {
    const ori = /^ori\s+(\$\d+),\s*(\$\d+),\s*(-?(?:0x[\da-f]+|\d+))$/i.exec(line);
    if (ori) {
      state.setRegister(ori[1], state.regValue(ori[2]) | (Number(ori[3]) & 0xffff));
      continue;
    }
    const move = /^(movn|movz)\s+(\$\d+),\s*(\$\d+),\s*(\$\d+)$/i.exec(line);
    if (!move) {
      continue;
    }
    const condition = move[1] === 'movn'
      ? state.regValue(move[4]) !== 0
      : state.regValue(move[4]) === 0;
    outcomes.get(move[1])?.add(condition);
    if (condition) {
      state.setRegister(move[2], state.regValue(move[3]));
    }
  }
  return outcomes;
}

function probeScenarioBlock(text: string, scenarioId: number): string {
  const start = text.indexOf(`# probe scenario ${scenarioId}:`);
  const next = text.indexOf('\n# probe scenario ', start + 1);
  const allDone = text.indexOf('\n_co_probe_all_done:', start + 1);
  const end = next >= 0 ? next : allDone >= 0 ? allDone : text.length;
  return start >= 0 ? text.slice(start, end) : '';
}

function hasEqualTrapRegisters(line: string): boolean {
  const match = /^t(?:eq|ne)\s+(\$\d+),\s*(\$\d+)$/.exec(line);
  return Boolean(match && match[1] === match[2]);
}
