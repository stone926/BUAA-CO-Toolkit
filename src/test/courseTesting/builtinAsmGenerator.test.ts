import { describe, expect, it } from 'vitest';
import {
  generateBuiltinAsmTestCase,
  resolveBuiltinInstructionSet
} from '../../courseTesting/builtinAsmGenerator';

describe('built-in ASM generator', () => {
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

  it('rejects exception-only instructions that the current trace path cannot load safely', () => {
    expect(() => resolveBuiltinInstructionSet('P7', 'syscall')).toThrow(/not supported by the built-in generator/);
    expect(() => resolveBuiltinInstructionSet('P7', 'eret')).toThrow(/not supported by the built-in generator/);
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
