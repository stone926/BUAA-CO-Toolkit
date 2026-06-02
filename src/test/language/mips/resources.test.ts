import { describe, it, expect } from 'vitest';
import {
  isRegister,
  isFloatingPointRegister,
  canonicalRegister,
  numericRegisters,
  registerNames,
  directives,
  instructions,
  syscalls,
  cp0Registers,
  instructionTypeLabel
} from '../../../language/mips/resources';

// ────────────────────────────────────────────────────────────────────────────────
// isRegister
// ────────────────────────────────────────────────────────────────────────────────
describe('isRegister', () => {
  it('recognizes numeric registers $0-$31', () => {
    expect(isRegister('$0')).toBe(true);
    expect(isRegister('$1')).toBe(true);
    expect(isRegister('$31')).toBe(true);
  });

  it('recognizes named registers', () => {
    expect(isRegister('$zero')).toBe(true);
    expect(isRegister('$at')).toBe(true);
    expect(isRegister('$v0')).toBe(true);
    expect(isRegister('$v1')).toBe(true);
    expect(isRegister('$a0')).toBe(true);
    expect(isRegister('$t0')).toBe(true);
    expect(isRegister('$t9')).toBe(true);
    expect(isRegister('$s0')).toBe(true);
    expect(isRegister('$sp')).toBe(true);
    expect(isRegister('$ra')).toBe(true);
    expect(isRegister('$gp')).toBe(true);
    expect(isRegister('$fp')).toBe(true);
  });

  it('is case-insensitive for named registers', () => {
    expect(isRegister('$ZERO')).toBe(true);
    expect(isRegister('$AT')).toBe(true);
    expect(isRegister('$V0')).toBe(true);
    expect(isRegister('$T0')).toBe(true);
    expect(isRegister('$RA')).toBe(true);
    expect(isRegister('$SP')).toBe(true);
  });

  it('rejects invalid registers', () => {
    expect(isRegister('$32')).toBe(false);
    expect(isRegister('$99')).toBe(false);
    expect(isRegister('$invalid')).toBe(false);
    expect(isRegister('$')).toBe(false);
    expect(isRegister('t0')).toBe(false); // missing $
    expect(isRegister('')).toBe(false);
  });

  it('handles register aliases', () => {
    // $zero is alias for $0, $at is alias for $1, etc.
    expect(isRegister('$zero')).toBe(true);
    expect(isRegister('$at')).toBe(true);
    expect(isRegister('$k0')).toBe(true);
    expect(isRegister('$k1')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// isFloatingPointRegister
// ────────────────────────────────────────────────────────────────────────────────
describe('isFloatingPointRegister', () => {
  it('recognizes $f0-$f31', () => {
    expect(isFloatingPointRegister('$f0')).toBe(true);
    expect(isFloatingPointRegister('$f1')).toBe(true);
    expect(isFloatingPointRegister('$f31')).toBe(true);
    expect(isFloatingPointRegister('$f15')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isFloatingPointRegister('$F0')).toBe(true);
    expect(isFloatingPointRegister('$F31')).toBe(true);
  });

  it('rejects out-of-range FP registers', () => {
    expect(isFloatingPointRegister('$f32')).toBe(false);
    expect(isFloatingPointRegister('$f99')).toBe(false);
  });

  it('rejects non-FP registers', () => {
    expect(isFloatingPointRegister('$t0')).toBe(false);
    expect(isFloatingPointRegister('$0')).toBe(false);
    expect(isFloatingPointRegister('')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// canonicalRegister
// ────────────────────────────────────────────────────────────────────────────────
describe('canonicalRegister', () => {
  it('resolves numeric registers to their canonical named form', () => {
    expect(canonicalRegister('$0')).toBe('$zero');
    expect(canonicalRegister('$1')).toBe('$at');
    expect(canonicalRegister('$2')).toBe('$v0');
    expect(canonicalRegister('$3')).toBe('$v1');
    expect(canonicalRegister('$29')).toBe('$sp');
    expect(canonicalRegister('$31')).toBe('$ra');
  });

  it('resolves aliases to canonical form', () => {
    expect(canonicalRegister('$ZERO')).toBe('$zero');
    expect(canonicalRegister('$AT')).toBe('$at');
  });

  it('returns lowercase for already-canonical names', () => {
    expect(canonicalRegister('$zero')).toBe('$zero');
    expect(canonicalRegister('$v0')).toBe('$v0');
  });

  it('returns lowercase for unknown registers', () => {
    expect(canonicalRegister('$unknown')).toBe('$unknown');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// numericRegisters
// ────────────────────────────────────────────────────────────────────────────────
describe('numericRegisters', () => {
  it('returns 32 registers', () => {
    expect(numericRegisters()).toHaveLength(32);
  });

  it('starts with $0 and ends with $31', () => {
    const regs = numericRegisters();
    expect(regs[0]).toBe('$0');
    expect(regs[31]).toBe('$31');
  });

  it('contains all registers from $0 to $31', () => {
    const regs = numericRegisters();
    for (let i = 0; i < 32; i++) {
      expect(regs).toContain(`$${i}`);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// registerNames
// ────────────────────────────────────────────────────────────────────────────────
describe('registerNames', () => {
  it('contains standard register names', () => {
    expect(registerNames.has('$zero')).toBe(true);
    expect(registerNames.has('$at')).toBe(true);
    expect(registerNames.has('$v0')).toBe(true);
    expect(registerNames.has('$sp')).toBe(true);
    expect(registerNames.has('$ra')).toBe(true);
  });

  it('contains canonical register names (aliases resolved to primary)', () => {
    // registerNames contains the canonical names like $zero, $at, etc.
    expect(registerNames.has('$zero')).toBe(true);
    expect(registerNames.has('$at')).toBe(true);
    expect(registerNames.has('$v0')).toBe(true);
    expect(registerNames.has('$31')).toBe(false); // $31 is not canonical, $ra is
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// directives
// ────────────────────────────────────────────────────────────────────────────────
describe('directives', () => {
  it('contains common MIPS directives', () => {
    expect(directives.has('.data')).toBe(true);
    expect(directives.has('.text')).toBe(true);
    expect(directives.has('.word')).toBe(true);
    expect(directives.has('.byte')).toBe(true);
    expect(directives.has('.half')).toBe(true);
    expect(directives.has('.ascii')).toBe(true);
    expect(directives.has('.asciiz')).toBe(true);
    expect(directives.has('.space')).toBe(true);
    expect(directives.has('.align')).toBe(true);
    expect(directives.has('.globl')).toBe(true);
    expect(directives.has('.macro')).toBe(true);
    expect(directives.has('.end_macro')).toBe(true);
    expect(directives.has('.eqv')).toBe(true);
    expect(directives.has('.include')).toBe(true);
    expect(directives.has('.extern')).toBe(true);
    expect(directives.has('.float')).toBe(true);
    expect(directives.has('.double')).toBe(true);
  });

  it('contains kernel segment directives', () => {
    expect(directives.has('.ktext')).toBe(true);
    expect(directives.has('.kdata')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// instructions
// ────────────────────────────────────────────────────────────────────────────────
describe('instructions', () => {
  it('contains common R-type instructions', () => {
    expect(instructions).toHaveProperty('add');
    expect(instructions).toHaveProperty('sub');
    expect(instructions).toHaveProperty('and');
    expect(instructions).toHaveProperty('or');
    expect(instructions).toHaveProperty('xor');
    expect(instructions).toHaveProperty('nor');
    expect(instructions).toHaveProperty('sll');
    expect(instructions).toHaveProperty('srl');
    expect(instructions).toHaveProperty('sra');
    expect(instructions).toHaveProperty('slt');
    expect(instructions).toHaveProperty('sltu');
    expect(instructions).toHaveProperty('jr');
    expect(instructions).toHaveProperty('jalr');
    expect(instructions).toHaveProperty('mult');
    expect(instructions).toHaveProperty('multu');
    expect(instructions).toHaveProperty('div');
    expect(instructions).toHaveProperty('divu');
    expect(instructions).toHaveProperty('mfhi');
    expect(instructions).toHaveProperty('mflo');
    expect(instructions).toHaveProperty('mthi');
    expect(instructions).toHaveProperty('mtlo');
  });

  it('contains common I-type instructions', () => {
    expect(instructions).toHaveProperty('addi');
    expect(instructions).toHaveProperty('addiu');
    expect(instructions).toHaveProperty('andi');
    expect(instructions).toHaveProperty('ori');
    expect(instructions).toHaveProperty('xori');
    expect(instructions).toHaveProperty('lui');
    expect(instructions).toHaveProperty('lw');
    expect(instructions).toHaveProperty('lh');
    expect(instructions).toHaveProperty('lb');
    expect(instructions).toHaveProperty('sw');
    expect(instructions).toHaveProperty('sh');
    expect(instructions).toHaveProperty('sb');
    expect(instructions).toHaveProperty('beq');
    expect(instructions).toHaveProperty('bne');
    expect(instructions).toHaveProperty('blez');
    expect(instructions).toHaveProperty('bgtz');
    expect(instructions).toHaveProperty('slti');
    expect(instructions).toHaveProperty('sltiu');
  });

  it('contains common J-type instructions', () => {
    expect(instructions).toHaveProperty('j');
    expect(instructions).toHaveProperty('jal');
  });

  it('contains special instructions', () => {
    expect(instructions).toHaveProperty('syscall');
    expect(instructions).toHaveProperty('nop');
  });

  it('contains MARS pseudo instruction forms from PseudoOps.txt', () => {
    expect(instructions).toHaveProperty('subi');
    expect(instructions).toHaveProperty('subiu');
    expect(instructions.subi.formats).toContain('subi $rt, $rs, simm16');
    expect(instructions.subiu.formats).toContain('subiu $rt, $rs, imm32');
    expect(instructions.ori.formats).toContain('ori $rt, imm32');
    expect(instructions.lw.formats).toContain('lw $rt, label+imm32($base)');
  });

  it('each instruction has required fields', () => {
    for (const [name, instr] of Object.entries(instructions)) {
      expect(instr.mnemonic).toBe(name);
      expect(typeof instr.summary).toBe('string');
      expect(typeof instr.type).toBe('string');
      expect(Array.isArray(instr.formats)).toBe(true);
      expect(instr.formats.length).toBeGreaterThan(0);
      expect(Array.isArray(instr.operands)).toBe(true);
      expect(instr.operands).toHaveLength(2);
      expect(instr.operands[0]).toBeLessThanOrEqual(instr.operands[1]);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// syscalls
// ────────────────────────────────────────────────────────────────────────────────
describe('syscalls', () => {
  it('is an array of syscall definitions', () => {
    expect(Array.isArray(syscalls)).toBe(true);
    expect(syscalls.length).toBeGreaterThan(0);
  });

  it('each syscall has required fields', () => {
    for (const syscall of syscalls) {
      expect(typeof syscall.code).toBe('number');
      expect(typeof syscall.name).toBe('string');
      expect(typeof syscall.description).toBe('string');
    }
  });

  it('contains common syscalls', () => {
    const codes = new Map(syscalls.map((s) => [s.code, s.name]));
    // print_int is typically 1, print_string is 4, exit is 10
    expect(codes.has(1)).toBe(true);
    expect(codes.has(4)).toBe(true);
    expect(codes.has(10)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// cp0Registers
// ────────────────────────────────────────────────────────────────────────────────
describe('cp0Registers', () => {
  it('is an array of CP0 register definitions', () => {
    expect(Array.isArray(cp0Registers)).toBe(true);
    expect(cp0Registers.length).toBeGreaterThan(0);
  });

  it('each CP0 register has required fields', () => {
    for (const reg of cp0Registers) {
      expect(typeof reg.number).toBe('number');
      expect(typeof reg.name).toBe('string');
      expect(typeof reg.description).toBe('string');
    }
  });

  it('contains SR (Status Register)', () => {
    const sr = cp0Registers.find((r) => r.name === 'SR');
    expect(sr).toBeDefined();
    expect(sr?.number).toBe(12);
  });

  it('contains Cause register', () => {
    const cause = cp0Registers.find((r) => r.name === 'Cause');
    expect(cause).toBeDefined();
    expect(cause?.number).toBe(13);
  });

  it('contains EPC register', () => {
    const epc = cp0Registers.find((r) => r.name === 'EPC');
    expect(epc).toBeDefined();
    expect(epc?.number).toBe(14);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// instructionTypeLabel
// ────────────────────────────────────────────────────────────────────────────────
describe('instructionTypeLabel', () => {
  it('returns Chinese labels for instruction types', () => {
    expect(instructionTypeLabel('R-type')).toBe('R 型指令');
    expect(instructionTypeLabel('I-type')).toBe('I 型指令');
    expect(instructionTypeLabel('J-type')).toBe('J 型指令');
    expect(instructionTypeLabel('special')).toBe('特殊指令');
    expect(instructionTypeLabel('pseudo')).toBe('伪指令');
  });
});
