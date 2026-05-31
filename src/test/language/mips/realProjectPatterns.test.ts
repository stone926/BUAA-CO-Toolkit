import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseMips } from '../../../language/mips/parser';
import { defaultCoSettings, mergeCoSettings, CoSettings } from '../../../language/common/settings';
import { isRegister, canonicalRegister } from '../../../language/mips/resources';

function doc(text: string): TextDocument {
  return TextDocument.create('test://test.s', 'mipsasm', 1, text);
}

function settings(overrides: Record<string, unknown> = {}): CoSettings {
  return mergeCoSettings(overrides);
}

function errorCodes(result: ReturnType<typeof parseMips>): string[] {
  return result.diagnostics.filter((d) => d.severity === 1).map((d) => d.code as string);
}

// ────────────────────────────────────────────────────────────────────────────────
// Real MIPS assembly patterns from P0-P2 projects
// ────────────────────────────────────────────────────────────────────────────────
describe('Real project MIPS patterns', () => {

  describe('P0 submatrix.asm patterns', () => {
    it('parses syscall-based I/O pattern', () => {
      const text = `
.text
main:
    li $v0, 5
    syscall
    move $s0, $v0
    li $v0, 1
    move $a0, $s0
    syscall
    li $v0, 11
    li $a0, 10
    syscall
    li $v0, 10
    syscall
`;
      const result = parseMips(doc(text), settings({ project: { profile: 'P2' } }));
      expect(errorCodes(result)).toHaveLength(0);
      expect(result.instructions.length).toBeGreaterThan(0);
    });

    it('parses .data section with .asciiz strings', () => {
      const text = `
.data
msg: .asciiz "Error: out of bound\\n"
matrix: .space 256
.text
main:
    li $v0, 4
    la $a0, msg
    syscall
`;
      const result = parseMips(doc(text), settings());
      expect(result.dataSymbols.has('msg')).toBe(true);
      expect(result.dataSymbols.has('matrix')).toBe(true);
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('P2 macro patterns', () => {
    it('parses get_int macro pattern', () => {
      const text = `
.macro get_int(%reg)
    li $v0, 5
    syscall
    move %reg, $v0
.end_macro

.text
main:
    get_int($s0)
    get_int($s1)
`;
      const result = parseMips(doc(text), settings());
      expect(result.macros.has('get_int')).toBe(true);
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses put_int macro pattern', () => {
      const text = `
.macro put_int(%reg)
    li $v0, 1
    move $a0, %reg
    syscall
.end_macro

.text
main:
    put_int($s0)
`;
      const result = parseMips(doc(text), settings());
      expect(result.macros.has('put_int')).toBe(true);
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses index macro for 2D array access', () => {
      const text = `
.macro index(%row, %col, %cols, %dst)
    mult %row, %cols
    mflo %dst
    add %dst, %dst, %col
    sll %dst, %dst, 2
.end_macro

.data
matrix: .space 256
.text
main:
    index($s0, $s1, $s2, $t0)
    lw $t1, matrix($t0)
`;
      const result = parseMips(doc(text), settings());
      expect(result.macros.has('index')).toBe(true);
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses for loop macros', () => {
      const text = `
.macro for(%reg, %from, %to)
    li %reg, %from
    loop:
.end_macro

.macro for_end(%reg, %to, %label)
    addi %reg, %reg, 1
    bne %reg, %to, %label
.end_macro

.text
main:
    for($t0, 0, 10)
    nop
    for_end($t0, 10, loop)
`;
      const result = parseMips(doc(text), settings());
      expect(result.macros.has('for')).toBe(true);
      expect(result.macros.has('for_end')).toBe(true);
    });

    it('parses push/pop stack macros', () => {
      const text = `
.macro push(%reg)
    sw %reg, 0($sp)
    addi $sp, $sp, -4
.end_macro

.macro pop(%reg)
    addi $sp, $sp, 4
    lw %reg, 0($sp)
.end_macro

.text
main:
    push($ra)
    push($s0)
    pop($s0)
    pop($ra)
`;
      const result = parseMips(doc(text), settings());
      expect(result.macros.has('push')).toBe(true);
      expect(result.macros.has('pop')).toBe(true);
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses newline macro', () => {
      const text = `
.macro newline
    li $v0, 11
    li $a0, 10
    syscall
.end_macro

.text
main:
    newline
`;
      const result = parseMips(doc(text), settings());
      expect(result.macros.has('newline')).toBe(true);
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('P2 recursion patterns', () => {
    it('parses recursive function with stack frame', () => {
      const text = `
.text
main:
    li $a0, 5
    jal factorial
    move $s0, $v0
    li $v0, 10
    syscall

factorial:
    sw $ra, 0($sp)
    sw $a0, 4($sp)
    addi $sp, $sp, -8
    bne $a0, $zero, recurse
    li $v0, 1
    addi $sp, $sp, 8
    jr $ra

recurse:
    addi $a0, $a0, -1
    jal factorial
    addi $sp, $sp, 8
    lw $ra, 0($sp)
    lw $a0, 4($sp)
    mult $a0, $v0
    mflo $v0
    jr $ra
`;
      const result = parseMips(doc(text), settings());
      expect(result.labels.has('main')).toBe(true);
      expect(result.labels.has('factorial')).toBe(true);
      expect(result.labels.has('recurse')).toBe(true);
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('P2 register usage patterns', () => {
    it('recognizes all standard register aliases used in projects', () => {
      // Registers commonly used in P2 projects
      const commonlyUsed = ['$v0', '$v1', '$a0', '$a1', '$a2', '$a3', '$t0', '$t1', '$t2', '$t3',
        '$s0', '$s1', '$s2', '$s3', '$s4', '$s5', '$s6', '$s7', '$sp', '$ra', '$zero', '$at'];
      for (const reg of commonlyUsed) {
        expect(isRegister(reg)).toBe(true);
      }
    });

    it('resolves register aliases correctly', () => {
      expect(canonicalRegister('$zero')).toBe('$zero');
      expect(canonicalRegister('$at')).toBe('$at');
      expect(canonicalRegister('$v0')).toBe('$v0');
      expect(canonicalRegister('$sp')).toBe('$sp');
      expect(canonicalRegister('$ra')).toBe('$ra');
    });
  });

  describe('P2 instruction patterns', () => {
    it('parses mult/mflo for multiplication', () => {
      const text = `
.text
main:
    mult $s0, $s1
    mflo $t0
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
      expect(result.instructions).toHaveLength(2);
    });

    it('parses div for division', () => {
      const text = `
.text
main:
    div $s0, $s1
    mflo $t0
    mfhi $t1
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
      expect(result.instructions).toHaveLength(3);
    });

    it('parses lui/ori for loading 32-bit constants', () => {
      const text = `
.text
main:
    lui $t0, 0x1234
    ori $t0, $t0, 0x5678
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses beq/bne for branching', () => {
      const text = `
.text
main:
    beq $s0, $s1, equal
    bne $s0, $s1, not_equal
    j end
equal:
    li $t0, 1
    j end
not_equal:
    li $t0, 0
end:
    nop
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
      expect(result.labels.has('main')).toBe(true);
      expect(result.labels.has('equal')).toBe(true);
      expect(result.labels.has('not_equal')).toBe(true);
      expect(result.labels.has('end')).toBe(true);
    });

    it('parses slt/sltu for comparison', () => {
      const text = `
.text
main:
    slt $t0, $s0, $s1
    sltu $t1, $s0, $s1
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses sll/srl/sra for shifts', () => {
      const text = `
.text
main:
    sll $t0, $s0, 2
    srl $t1, $s0, 2
    sra $t2, $s0, 2
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('.eqv patterns from real projects', () => {
    it('parses .eqv for constants', () => {
      const text = `
.eqv MATRIX_SIZE 16
.eqv WORD_SIZE 4
.eqv SYS_READ_INT 5
.eqv SYS_PRINT_INT 1
.eqv SYS_EXIT 10

.data
matrix: .space MATRIX_SIZE * WORD_SIZE
.text
main:
    li $v0, SYS_READ_INT
    syscall
`;
      const result = parseMips(doc(text), settings());
      expect(result.eqvSymbols.has('MATRIX_SIZE')).toBe(true);
      expect(result.eqvSymbols.has('WORD_SIZE')).toBe(true);
      expect(result.eqvSymbols.has('SYS_READ_INT')).toBe(true);
    });
  });

  describe('P2 macro with label parameters', () => {
    it('parses macro with label used as branch target', () => {
      const text = `
.macro for(%reg, %from, %to, %label)
    li %reg, %from
    %label:
.end_macro

.macro for_end(%reg, %to, %label)
    addi %reg, %reg, 1
    bne %reg, %to, %label
.end_macro

.text
main:
    for($t0, 0, 10, loop1)
    nop
    for_end($t0, 10, loop1)
`;
      const result = parseMips(doc(text), settings());
      expect(result.macros.has('for')).toBe(true);
      expect(result.macros.has('for_end')).toBe(true);
    });
  });
});
