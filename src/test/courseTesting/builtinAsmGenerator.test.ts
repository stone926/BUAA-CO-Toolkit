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
    expect(result.text).toContain('mfc0 $27, $14');
    expect(result.text).toContain('mtc0 $27, $14');
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
    })).toThrow(/include syscall/);
    expect(() => generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: 'syscall',
      instructionCount: 4,
      seed: 'syscall-only'
    })).toThrow(/requires P7 exception handler/);
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

function beforeKernelText(text: string): string {
  return text.split(/^\.ktext\b/m)[0];
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
