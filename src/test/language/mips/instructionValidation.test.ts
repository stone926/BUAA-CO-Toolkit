import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { isMacroArgumentToken, instructionWritesRegister, labelOperand } from '../../../language/mips/instructionValidation';
import { parseMips } from '../../../language/mips/parser';
import { instructions } from '../../../language/mips/resources';
import type { MipsOperandAst } from '../../../language/mips/ast';

function astOperands(text: string): MipsOperandAst[] {
  const document = TextDocument.create('test://instruction-validation.s', 'mipsasm', 1, text);
  return parseMips(document, defaultCoSettings).ast.statements[0].executable?.operands ?? [];
}

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
    expect(instructionWritesRegister('add', astOperands('add $v0, $t1, $t2'), '$v0')).toBe(true);
  });

  it('detects $v0 write for li (pseudo)', () => {
    expect(instructionWritesRegister('li', astOperands('li $v0, 10'), '$v0')).toBe(true);
  });

  it('detects $v0 write for lw', () => {
    expect(instructionWritesRegister('lw', astOperands('lw $v0, 0($sp)'), '$v0')).toBe(true);
  });

  it('detects $v0 write for move', () => {
    expect(instructionWritesRegister('move', astOperands('move $v0, $t0'), '$v0')).toBe(true);
  });

  it('does not detect $v0 write when first operand is different', () => {
    expect(instructionWritesRegister('add', astOperands('add $t0, $v0, $t2'), '$v0')).toBe(false);
  });

  it('handles syscall (does not write $v0)', () => {
    expect(instructionWritesRegister('syscall', [], '$v0')).toBe(false);
  });

  it('handles empty operands', () => {
    expect(instructionWritesRegister('nop', [], '$v0')).toBe(false);
  });

  it('detects $v0 write for ori', () => {
    expect(instructionWritesRegister('ori', astOperands('ori $v0, $zero, 0x1234'), '$v0')).toBe(true);
  });

  it('detects writes from parsed AST operands', () => {
    expect(instructionWritesRegister('li', astOperands('li $v0, 10'), '$v0')).toBe(true);
  });

  it('detects $v0 write for subi', () => {
    expect(instructionWritesRegister('subi', astOperands('subi $v0, $v0, 1'), '$v0')).toBe(true);
  });

  it('detects $v0 write for lui', () => {
    expect(instructionWritesRegister('lui', astOperands('lui $v0, 0x1234'), '$v0')).toBe(true);
  });

  it('does not detect register write for trap instructions', () => {
    // Trap instructions do not write to any register
    expect(instructionWritesRegister('teq', astOperands('teq $t0, $t1'), '$t0')).toBe(false);
    expect(instructionWritesRegister('tne', astOperands('tne $t0, $t1'), '$t0')).toBe(false);
    expect(instructionWritesRegister('tge', astOperands('tge $t0, $t1'), '$t0')).toBe(false);
    expect(instructionWritesRegister('tgeu', astOperands('tgeu $t0, $t1'), '$t0')).toBe(false);
    expect(instructionWritesRegister('tlt', astOperands('tlt $t0, $t1'), '$t0')).toBe(false);
    expect(instructionWritesRegister('tltu', astOperands('tltu $t0, $t1'), '$t0')).toBe(false);
    expect(instructionWritesRegister('teqi', astOperands('teqi $t0, 100'), '$t0')).toBe(false);
    expect(instructionWritesRegister('tnei', astOperands('tnei $t0, 100'), '$t0')).toBe(false);
    expect(instructionWritesRegister('tgei', astOperands('tgei $t0, 100'), '$t0')).toBe(false);
    expect(instructionWritesRegister('tgeiu', astOperands('tgeiu $t0, 100'), '$t0')).toBe(false);
    expect(instructionWritesRegister('tlti', astOperands('tlti $t0, 100'), '$t0')).toBe(false);
    expect(instructionWritesRegister('tltiu', astOperands('tltiu $t0, 100'), '$t0')).toBe(false);
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
      expect(labelOperand(instr, astOperands('beq $t0, $t1, target'))).toBe('target');
    }
  });

  it('returns the label operand for j (last)', () => {
    const instr = instructions['j'];
    expect(instr).toBeDefined();
    if (instr) {
      expect(labelOperand(instr, astOperands('j target'))).toBe('target');
    }
  });

  it('returns the label operand for jal (last)', () => {
    const instr = instructions['jal'];
    expect(instr).toBeDefined();
    if (instr) {
      expect(labelOperand(instr, astOperands('jal target'))).toBe('target');
    }
  });

  it('returns the label operand for bne (last)', () => {
    const instr = instructions['bne'];
    expect(instr).toBeDefined();
    if (instr) {
      expect(labelOperand(instr, astOperands('bne $t0, $t1, target'))).toBe('target');
    }
  });

  it('returns label operands from parsed AST operands', () => {
    const instr = instructions['beq'];
    expect(instr).toBeDefined();
    if (instr) {
      expect(labelOperand(instr, astOperands('beq $t0, $t1, target'))).toBe('target');
    }
  });

  it('returns undefined for instructions without label operand', () => {
    const instr = instructions['add'];
    expect(instr).toBeDefined();
    if (instr) {
      expect(labelOperand(instr, astOperands('add $t0, $t1, $t2'))).toBeUndefined();
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
