import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { isMacroArgumentToken, instructionWritesRegister, labelOperand, usesMarsPseudoInstructionForm } from '../../../language/mips/instructionValidation';
import { parseMips } from '../../../language/mips/parser';
import { instructions } from '../../../language/mips/resources';
import type { MipsOperandAst } from '../../../language/mips/ast';

function astOperands(text: string): MipsOperandAst[] {
  const document = TextDocument.create('test://instruction-validation.s', 'mipsasm', 1, text);
  return parseMips(document, defaultCoSettings).ast.statements[0].executable?.operands ?? [];
}

function parseInstructionLines(lines: string[]) {
  const text = ['.text', 'main:', ...lines.map((line) => `    ${line}`), 'target: nop'].join('\n');
  return parseMips(TextDocument.create('test://instruction-matrix.s', 'mipsasm', 1, text), defaultCoSettings);
}

function concreteInstructionFormat(format: string): string {
  const firstSpace = format.indexOf(' ');
  if (firstSpace < 0) {
    return format;
  }
  const mnemonic = format.slice(0, firstSpace);
  const operands = format.slice(firstSpace + 1)
    .split(',')
    .map((operand) => concreteOperand(operand.trim()));
  return `${mnemonic} ${operands.join(', ')}`;
}

function concreteOperand(pattern: string): string {
  switch (pattern) {
    case '$rd':
      return '$t0';
    case '$rs':
      return '$t1';
    case '$rt':
      return '$t2';
    case '$base':
      return '$sp';
    case '($base)':
      return '($sp)';
    case 'cp0':
      return '$12';
    case 'imm32':
      return '42';
    case 'simm16':
      return '-1';
    case 'uimm16':
      return '0xffff';
    case 'shamt':
      return '4';
    case 'code16':
      return '1';
    case 'label':
      return 'target';
    case 'offset($base)':
      return '4($sp)';
    case 'imm32($base)':
      return '42($sp)';
    case 'uimm16($base)':
      return '4($sp)';
    case 'label($base)':
      return 'target($sp)';
    case 'label+imm32':
      return 'target+4';
    case 'label+imm32($base)':
      return 'target+4($sp)';
    default:
      throw new Error(`Unhandled MIPS instruction operand pattern: ${pattern}`);
  }
}

describe('instruction resource format matrix', () => {
  it('accepts at least one concrete format for every instruction', () => {
    const lines = Object.values(instructions).map((instruction) => concreteInstructionFormat(instruction.formats[0] ?? instruction.mnemonic));
    const result = parseInstructionLines(lines);
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 1);

    expect(Object.keys(instructions)).toHaveLength(114);
    expect(errors).toEqual([]);
  });

  it('accepts every declared instruction format from the resource table', () => {
    const lines = Object.values(instructions).flatMap((instruction) =>
      (instruction.formats.length ? instruction.formats : [instruction.mnemonic]).map(concreteInstructionFormat)
    );
    const result = parseInstructionLines(lines);
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 1);

    expect(errors).toEqual([]);
  });

  it('reports stable operand diagnostics for common operand family mistakes', () => {
    const result = parseInstructionLines([
      'add 1, $t1, $t2',
      'addi $t0, $t1, target',
      'beq $t0, $t1, 4($sp)',
      'lw $t0, target',
      'sll $t0, $t1, 40',
      'mfc0 $t0, $bad'
    ]);
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

    expect(codes).toContain('operand-type');
    expect(codes).toContain('unknown-register');
  });
});

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

// ────────────────────────────────────────────────────────────────────────────────
// usesMarsPseudoInstructionForm — must align with MARS PseudoOps.txt
// ────────────────────────────────────────────────────────────────────────────────
describe('usesMarsPseudoInstructionForm aligns with MARS PseudoOps.txt', () => {
  function ops(text: string) {
    return astOperands(text);
  }

  // ── Set/comparison pseudos: MARS accepts rd,rs,rt AND rd,rs,imm16 AND rd,rs,imm32 ──
  describe('set/comparison pseudos (seq, sne, sgt, sgtu, sge, sgeu, sle, sleu)', () => {
    const OPS = ['seq', 'sne', 'sgt', 'sgtu', 'sge', 'sgeu', 'sle', 'sleu'];

    it('recognizes rd, rs, rt (all registers)', () => {
      for (const op of OPS) {
        expect(usesMarsPseudoInstructionForm(op, ops(`${op} $t0, $t1, $t2`), undefined, new Map())).toBe(true);
      }
    });

    it('recognizes rd, rs, imm16', () => {
      for (const op of OPS) {
        expect(usesMarsPseudoInstructionForm(op, ops(`${op} $t0, $t1, -100`), undefined, new Map())).toBe(true);
      }
    });

    it('recognizes rd, rs, imm32', () => {
      for (const op of OPS) {
        expect(usesMarsPseudoInstructionForm(op, ops(`${op} $t0, $t1, 100000`), undefined, new Map())).toBe(true);
      }
    });
  });

  // ── Branch pseudos: MARS accepts rs,rt,label AND rs,imm16,label AND rs,imm32,label ──
  describe('branch pseudos (blt, bltu, bgt, bgtu, ble, bleu, bge, bgeu)', () => {
    const OPS = ['blt', 'bltu', 'bgt', 'bgtu', 'ble', 'bleu', 'bge', 'bgeu'];

    it('recognizes rs, rt, label (register comparison)', () => {
      for (const op of OPS) {
        expect(usesMarsPseudoInstructionForm(op, ops(`${op} $t0, $t1, target`), undefined, new Map())).toBe(true);
      }
    });

    it('recognizes rs, imm16, label', () => {
      for (const op of OPS) {
        expect(usesMarsPseudoInstructionForm(op, ops(`${op} $t0, -100, target`), undefined, new Map())).toBe(true);
      }
    });

    it('recognizes rs, imm32, label', () => {
      for (const op of OPS) {
        expect(usesMarsPseudoInstructionForm(op, ops(`${op} $t0, 100000, target`), undefined, new Map())).toBe(true);
      }
    });
  });

  // ── div/divu: 3-register form (regression) ──
  describe('div/divu with 3 registers', () => {
    it('recognizes div rd, rs, rt', () => {
      expect(usesMarsPseudoInstructionForm('div', ops('div $t0, $t1, $t2'), undefined, new Map())).toBe(true);
    });
    it('recognizes divu rd, rs, rt', () => {
      expect(usesMarsPseudoInstructionForm('divu', ops('divu $t0, $t1, $t2'), undefined, new Map())).toBe(true);
    });
  });
});
