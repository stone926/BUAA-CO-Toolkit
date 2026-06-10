import { describe, expect, it } from 'vitest';
import {
  generateBuiltinAsmTestCase,
  resolveBuiltinInstructionSet
} from '../../courseTesting/builtinAsmGenerator';

describe('built-in ASM generator', () => {
  it('uses the course default instruction set for each CPU profile', () => {
    const defaults = new Map([
      ['P3', ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'nop']],
      ['P4', ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'jal', 'jr', 'nop']],
      ['P5', ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'jal', 'jr', 'nop']],
      ['P6', [
        'add', 'sub', 'and', 'or', 'slt', 'sltu', 'lui',
        'addi', 'andi', 'ori',
        'lb', 'lh', 'lw', 'sb', 'sh', 'sw',
        'mult', 'multu', 'div', 'divu', 'mfhi', 'mflo', 'mthi', 'mtlo',
        'beq', 'bne', 'jal', 'jr'
      ]],
      ['P7', [
        'nop', 'add', 'sub', 'and', 'or', 'slt', 'sltu', 'lui',
        'addi', 'andi', 'ori',
        'lb', 'lh', 'lw', 'sb', 'sh', 'sw',
        'mult', 'multu', 'div', 'divu', 'mfhi', 'mflo', 'mthi', 'mtlo',
        'beq', 'bne', 'jal', 'jr',
        'mfc0', 'mtc0', 'eret', 'syscall'
      ]]
    ] as const);

    for (const [profile, mnemonics] of defaults) {
      const resolved = resolveBuiltinInstructionSet(profile, '');
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
    const mnemonics = executableMnemonics(result.text);

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
    expect(executableMnemonics(result.text)).toEqual(Array(8).fill('nop'));
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
    const mainMnemonics = executableMnemonics(beforeKernelText(result.text));

    expect(result.instructionCount).toBe(96);
    expect(mainMnemonics).toHaveLength(96);
    expect(mainMnemonics).toContain('syscall');
    expect(result.text).toContain('.ktext 0x4180');
    expect(result.text).toContain('mfc0 $k0, $13');
    expect(result.text).toContain('mtc0 $k0, $14');
    expect(result.text).toContain('sb $0, 0($k0)');
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

  it('rejects P7 exception instruction sets that cannot build a returning handler', () => {
    expect(() => generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: 'eret',
      instructionCount: 4,
      seed: 'eret-only'
    })).toThrow(/inside the P7 exception handler/);
    expect(() => generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: 'syscall',
      instructionCount: 4,
      seed: 'syscall-only'
    })).toThrow(/exception handler requires/);
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
    expect(target).toBeGreaterThan(0x3000);
    // SR prologue enables the external interrupt before any body instruction.
    expect(result.text).toContain('ori $k0, $0, 0x1001');
    expect(result.text).toContain('mtc0 $k0, $12');
    // The first handler entry is the pre-anchor external interrupt, so it must not read full Cause
    // before acknowledging: MARS and legal CPUs may differ in Cause.IP visibility.
    const handler = result.text.slice(result.text.indexOf('.ktext 0x4180'));
    const firstEntryFlag = handler.indexOf('    ori $k1, $0, 1');
    const branchToException = handler.indexOf('    bne $k1, $0, _co_excep_skip');
    const interruptAck = handler.indexOf('    ori $k0, $0, 0x7f20');
    const exceptionPath = handler.indexOf('_co_excep_skip:');
    expect(handler).not.toContain('    mfc0 $k0, $13');
    expect(branchToException).toBeGreaterThanOrEqual(0);
    expect(firstEntryFlag).toBeGreaterThan(branchToException);
    expect(interruptAck).toBeGreaterThan(firstEntryFlag);
    expect(handler).toContain('    sb $0, 0($k0)');
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
    const handler = result.text.slice(result.text.indexOf('.ktext 0x4180'));
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

    const targetIndex = (result.interruptSchedule[0] - 0x3000) / 4;
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

  it('covers all course-required P7 exception classes with default exception injection', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 400,
      seed: 'p7-exception-coverage',
      exceptionRate: 0.2
    });
    const bodyLines = instructionSlotLines(beforeKernelText(result.text));

    expect(bodyLines.some((line) => /\b(lw|lh|lhu)\b.*1\(\$0\)/.test(line))).toBe(true);
    expect(bodyLines.some((line) => /\b(sw|sh)\b.*1\(\$0\)/.test(line))).toBe(true);
    expect(bodyLines).toContain('syscall');
    expect(bodyLines).toContain('_co_internal_unknown_instruction');
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
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-probe',
      interrupt: true,
      p7StressMode: 'probe',
      timerInterrupt: true,
      probeScenarioCount: 32
    });

    expect(result.mode).toBe('probe');
    expect(result.probe?.logBase).toBe(0x2800);
    expect(result.probe?.scenarios).toHaveLength(32);
    expect(new Set(result.probe?.scenarios.map((scenario) => scenario.kind))).toEqual(new Set([
      'external', 'timer0', 'timer1', 'adel', 'ades', 'syscall', 'ri', 'ov'
    ]));
    expect(result.text).toContain('mfc0 $24, $13');
    expect(result.text).toContain('mfc0 $25, $12');
    expect(result.text).toContain('mfc0 $23, $14');
    expect(result.text).not.toMatch(/mfc0\s+\$\d+,\s*\$8\b/);
    expect(result.text).toContain('sb $0, 0x7f20($0)');
    expect(result.text).toContain('sw $26, 0x7f04($0)');
    expect(result.text).toContain('sw $26, 0x7f00($0)');
    expect(result.text).toContain('sw $26, 0x7f14($0)');
    expect(result.text).toContain('sw $26, 0x7f10($0)');
    expect(result.text).not.toContain('sw $26, 0x7f08($0)');
    expect(result.text).not.toContain('sw $26, 0x7f18($0)');
    expect(result.text).toContain('sw $26, 0x27d0($0)');
    expect(result.text).toContain('_co_internal_unknown_instruction');
  });

  it('arms P7 probe timers only after the return PC is staged', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-probe-timer-setup',
      interrupt: false,
      p7StressMode: 'probe',
      timerInterrupt: true,
      probeScenarioCount: 8,
      exceptionTypes: []
    });
    const scenario = result.probe?.scenarios.find((item) => item.kind === 'timer0' || item.kind === 'timer1');
    if (!scenario) {
      throw new Error('missing timer probe scenario');
    }
    const timerStart = result.text.indexOf(`# probe scenario ${scenario.id}: ${scenario.kind}`);
    const waitLabel = result.text.indexOf(`_co_probe_s${scenario.id}_wait:`, timerStart);
    const doneStore = result.text.lastIndexOf('sw $26, 0x27e8($0)', waitLabel);
    const enableStatus = result.text.indexOf('mtc0 $26, $12', timerStart);

    expect(result.text.slice(timerStart, waitLabel)).toContain('jal _co_probe_guard');
    expect(result.text).toContain('_co_probe_guard:');
    expect(result.text).toContain('sw $0, 0x7f00($0)');
    expect(result.text).toContain('sw $0, 0x7f10($0)');
    expect(doneStore).toBeGreaterThan(timerStart);
    expect(enableStatus).toBeGreaterThan(doneStore);
    expect(waitLabel).toBeGreaterThan(enableStatus);
    expect(scenario.allowedEpc).toContain(scenario.waitPc);
    expect(scenario.allowedEpc).toContain((scenario.waitPc ?? 0) + 4);
    expect(scenario.allowedEpc.some((pc) => pc < (scenario.waitPc ?? 0))).toBe(true);
    expect(scenario.timerPreset).toBeGreaterThanOrEqual(2);
    expect(scenario.timerPreset).toBeLessThanOrEqual(96);
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

    expect(scenario?.kind).toBe('syscall');
    expect(scenario?.expectedExcCode).toBe(8);
    expect(scenario?.allowedEpc).toEqual([0x3000 + syscallIndex * 4]);
  });

  it('caps P7 probe scenario count at the log capacity without overlapping the handler', () => {
    const result = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: '',
      instructionCount: 200,
      seed: 'p7-probe-max',
      interrupt: true,
      p7StressMode: 'probe',
      timerInterrupt: true,
      probeScenarioCount: 99
    });
    const mainLines = instructionSlotLines(beforeKernelText(result.text));

    expect(result.probe?.scenarios).toHaveLength(64);
    expect(mainLines.length).toBeLessThanOrEqual((0x4180 - 0x3000) / 4 - 2);
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

function exceptionVictimIndices(lines: string[]): number[] {
  const victims: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === 'syscall' || line === '_co_internal_unknown_instruction' || /\b(lw|lh|lhu|sw|sh)\b.*1\(\$0\)/.test(line)) {
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
