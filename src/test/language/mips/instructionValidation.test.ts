import { describe, it, expect } from 'vitest';
import { isMacroArgumentToken, instructionWritesRegister, labelOperand } from '../../../language/mips/instructionValidation';
import { instructions } from '../../../language/mips/resources';

// ────────────────────────────────────────────────────────────────────────────────
// isMacroArgumentToken
// ────────────────────────────────────────────────────────────────────────────────
describe('isMacroArgumentToken', () => {
  it('accepts register names', () => {
    expect(isMacroArgumentToken('$t0')).toBe(true);
    expect(isMacroArgumentToken('$zero')).toBe(true);
    expect(isMacroArgumentToken('$v0')).toBe(true);
  });

  it('accepts identifiers', () => {
    expect(isMacroArgumentToken('label')).toBe(true);
    expect(isMacroArgumentToken('_start')).toBe(true);
  });

  it('accepts macro parameters', () => {
    expect(isMacroArgumentToken('%arg')).toBe(true);
    expect(isMacroArgumentToken('%dst')).toBe(true);
  });

  it('accepts string literals', () => {
    expect(isMacroArgumentToken('"hello"')).toBe(true);
    expect(isMacroArgumentToken('"hello world"')).toBe(true);
  });

  it('accepts character literals', () => {
    expect(isMacroArgumentToken("'a'")).toBe(true);
    expect(isMacroArgumentToken("'\\n'")).toBe(true);
  });

  it('accepts integer literals', () => {
    expect(isMacroArgumentToken('42')).toBe(true);
    expect(isMacroArgumentToken('0xFF')).toBe(true);
    expect(isMacroArgumentToken('-1')).toBe(true);
  });

  it('accepts float literals', () => {
    expect(isMacroArgumentToken('3.14')).toBe(true);
  });

  it('rejects memory operands', () => {
    expect(isMacroArgumentToken('4($t0)')).toBe(false);
    expect(isMacroArgumentToken('offset($sp)')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isMacroArgumentToken('')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// instructionWritesRegister
// ────────────────────────────────────────────────────────────────────────────────
describe('instructionWritesRegister', () => {
  it('detects $v0 write for add', () => {
    expect(instructionWritesRegister('add', ['$v0', '$t1', '$t2'], '$v0')).toBe(true);
  });

  it('detects $v0 write for li (pseudo)', () => {
    expect(instructionWritesRegister('li', ['$v0', '10'], '$v0')).toBe(true);
  });

  it('detects $v0 write for lw', () => {
    expect(instructionWritesRegister('lw', ['$v0', '0($sp)'], '$v0')).toBe(true);
  });

  it('detects $v0 write for move', () => {
    expect(instructionWritesRegister('move', ['$v0', '$t0'], '$v0')).toBe(true);
  });

  it('does not detect $v0 write when first operand is different', () => {
    expect(instructionWritesRegister('add', ['$t0', '$v0', '$t2'], '$v0')).toBe(false);
  });

  it('handles syscall (does not write $v0)', () => {
    expect(instructionWritesRegister('syscall', [], '$v0')).toBe(false);
  });

  it('handles empty operands', () => {
    expect(instructionWritesRegister('nop', [], '$v0')).toBe(false);
  });

  it('detects $v0 write for ori', () => {
    expect(instructionWritesRegister('ori', ['$v0', '$zero', '0x1234'], '$v0')).toBe(true);
  });

  it('detects $v0 write for subi', () => {
    expect(instructionWritesRegister('subi', ['$v0', '$v0', '1'], '$v0')).toBe(true);
  });

  it('detects $v0 write for lui', () => {
    expect(instructionWritesRegister('lui', ['$v0', '0x1234'], '$v0')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// labelOperand
// ────────────────────────────────────────────────────────────────────────────────
describe('labelOperand', () => {
  it('returns the label operand for beq (last)', () => {
    const instr = instructions['beq'];
    expect(instr).toBeDefined();
    if (instr) {
      expect(labelOperand(instr, ['$t0', '$t1', 'target'])).toBe('target');
    }
  });

  it('returns the label operand for j (last)', () => {
    const instr = instructions['j'];
    expect(instr).toBeDefined();
    if (instr) {
      expect(labelOperand(instr, ['target'])).toBe('target');
    }
  });

  it('returns the label operand for jal (last)', () => {
    const instr = instructions['jal'];
    expect(instr).toBeDefined();
    if (instr) {
      expect(labelOperand(instr, ['target'])).toBe('target');
    }
  });

  it('returns the label operand for bne (last)', () => {
    const instr = instructions['bne'];
    expect(instr).toBeDefined();
    if (instr) {
      expect(labelOperand(instr, ['$t0', '$t1', 'target'])).toBe('target');
    }
  });

  it('returns undefined for instructions without label operand', () => {
    const instr = instructions['add'];
    expect(instr).toBeDefined();
    if (instr) {
      expect(labelOperand(instr, ['$t0', '$t1', '$t2'])).toBeUndefined();
    }
  });

  it('returns undefined for nop', () => {
    const instr = instructions['nop'];
    expect(instr).toBeDefined();
    if (instr) {
      expect(labelOperand(instr, [])).toBeUndefined();
    }
  });
});
