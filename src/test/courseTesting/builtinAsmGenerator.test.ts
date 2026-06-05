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

  it('rejects exception-only instructions that the current trace path cannot load safely', () => {
    expect(() => resolveBuiltinInstructionSet('P7', 'syscall')).toThrow(/real CPU instructions/);
    expect(() => resolveBuiltinInstructionSet('P7', 'eret')).toThrow(/real CPU instructions/);
  });
});

function executableMnemonics(text: string): string[] {
  const result: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('.') || trimmed.endsWith(':')) {
      continue;
    }
    const match = /^([a-z][a-z0-9]*)\b/.exec(trimmed);
    if (match) {
      result.push(match[1]);
    }
  }
  return result;
}
