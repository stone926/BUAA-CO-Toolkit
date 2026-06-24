import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseMips } from '../../../language/mips/parser';
import { defaultCoSettings, mergeCoSettings, CoSettings } from '../../../language/common/settings';
import { isRegister, instructions } from '../../../language/mips/resources';

function doc(text: string): TextDocument {
  return TextDocument.create('test://test.s', 'mipsasm', 1, text);
}

function settings(overrides: Record<string, unknown> = {}): CoSettings {
  return mergeCoSettings(overrides);
}

function errorCodes(result: ReturnType<typeof parseMips>): string[] {
  return result.diagnostics.filter((d) => d.severity === 1).map((d) => d.code as string);
}

function infoCodes(result: ReturnType<typeof parseMips>): string[] {
  return result.diagnostics.filter((d) => d.severity === 3).map((d) => d.code as string);
}

// ────────────────────────────────────────────────────────────────────────────────
// MARS工程 patterns — real code from student exercises
// ────────────────────────────────────────────────────────────────────────────────
describe('MARS工程 real patterns', () => {

  describe('ori pseudo-instruction (from 1.asm)', () => {
    it('parses 3-operand ori', () => {
      const text = '    ori $t1, $0, 0xf';
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
      expect(result.instructions).toHaveLength(1);
      expect(result.instructions[0].mnemonic).toBe('ori');
    });

    it('parses 2-operand ori as pseudo-instruction (MARS extension)', () => {
      const text = '    ori $t1, 0xf';
      const result = parseMips(doc(text), settings());
      // MARS supports 2-operand ori (implicit $0), but the real ori needs 3 operands
      // The parser correctly flags this as a pseudo-instruction form
      expect(result.instructions).toHaveLength(1);
    });

    it('parses ori with large immediate', () => {
      const text = '    ori $t1, $0, 0xfffff';
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses ori pseudo with large immediate (MARS extension)', () => {
      const text = '    ori $t1, 0xfffff';
      const result = parseMips(doc(text), settings());
      // MARS supports 2-operand ori, parser flags as pseudo form
      expect(errorCodes(result)).toHaveLength(0);
      expect(result.instructions).toHaveLength(1);
    });

    it('parses andi/xori 2-operand forms as pseudo-instructions', () => {
      const text = `
.text
main:
    andi $t0, 0xf
    xori $t1, 0x10000
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('marks negative logical immediates as MARS 32-bit pseudo forms', () => {
      const text = `
.text
main:
    andi $t0, $t0, -1
    ori $t1, $zero, -1
    xori $t2, $t2, -32768
`;
      const result = parseMips(doc(text), settings({ mips: { warnPseudoInstruction: true } }));
      expect(errorCodes(result)).toHaveLength(0);
      expect(infoCodes(result)).toContain('pseudo-instruction:andi');
      expect(infoCodes(result)).toContain('pseudo-instruction:ori');
      expect(infoCodes(result)).toContain('pseudo-instruction:xori');
    });

    it('keeps unsigned 16-bit logical immediates as real instructions', () => {
      const text = `
.text
main:
    andi $t0, $t0, 65535
    ori $t1, $zero, 0xffff
    xori $t2, $t2, 0x8000
`;
      const result = parseMips(doc(text), settings({ mips: { warnPseudoInstruction: true } }));
      expect(errorCodes(result)).toHaveLength(0);
      expect(infoCodes(result)).not.toContain('pseudo-instruction:andi');
      expect(infoCodes(result)).not.toContain('pseudo-instruction:ori');
      expect(infoCodes(result)).not.toContain('pseudo-instruction:xori');
    });
  });

  describe('div/mfhi/mflo pattern (from leap year, GCD)', () => {
    it('parses div followed by mfhi for modulo', () => {
      const text = `
.text
main:
    li $t0, 2024
    li $t1, 4
    div $t0, $t1
    mfhi $t2
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses div followed by mflo for quotient', () => {
      const text = `
.text
main:
    li $t0, 100
    li $t1, 3
    div $t0, $t1
    mflo $t2
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses divu for unsigned division', () => {
      const text = `
.text
main:
    divu $t0, $t1
    mflo $t2
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('mult/mflo pattern (from calculator)', () => {
    it('parses mult followed by mflo', () => {
      const text = `
.text
main:
    li $t0, 7
    li $t1, 6
    mult $t0, $t1
    mflo $t2
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses multu for unsigned multiplication', () => {
      const text = `
.text
main:
    multu $t0, $t1
    mflo $t2
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('beqz pseudo-instruction (from GCD)', () => {
    it('parses beqz as a pseudo-instruction', () => {
      const text = `
.text
main:
    beqz $t0, done
    nop
done:
    nop
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
      // beqz should be recognized (it expands to beq $reg, $0, label)
    });
  });

  describe('ble/bge pseudo-instructions (from leap year)', () => {
    it('parses ble pseudo-instruction', () => {
      const text = `
.text
main:
    ble $t0, $zero, target
    nop
target:
    nop
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses bge pseudo-instruction', () => {
      const text = `
.text
main:
    bge $t0, $t1, target
    nop
target:
    nop
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses blt pseudo-instruction', () => {
      const text = `
.text
main:
    blt $t0, $t1, target
    nop
target:
    nop
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses bgt pseudo-instruction', () => {
      const text = `
.text
main:
    bgt $t0, $t1, target
    nop
target:
    nop
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('subi pseudo-instruction (from Tower of Hanoi)', () => {
    it('parses subi and subiu as MARS pseudo-instructions', () => {
      const text = `
.text
main:
    subi $sp, $sp, 8
    subiu $t0, $t0, 0x10000
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
      expect(result.instructions.map((instruction) => instruction.mnemonic)).toEqual(['subi', 'subiu']);
      expect(result.instructions.every((instruction) => instruction.usesPseudoForm)).toBe(true);
    });
  });

  describe('move pseudo-instruction', () => {
    it('parses move pseudo-instruction', () => {
      const text = `
.text
main:
    move $s0, $v0
    move $a0, $t0
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('la pseudo-instruction (from palindrome)', () => {
    it('parses la for loading address', () => {
      const text = `
.data
msg: .asciiz "hello"
.text
main:
    la $a0, msg
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('li pseudo-instruction', () => {
    it('parses li with small immediate', () => {
      const text = '    li $v0, 5';
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses li with large immediate (needs lui+ori expansion)', () => {
      const text = '    li $t0, 0x12345678';
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses li with 0', () => {
      const text = '    li $t0, 0';
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('syscall patterns from real exercises', () => {
    it('parses syscall 5 (read integer)', () => {
      const text = `
.text
main:
    li $v0, 5
    syscall
`;
      const result = parseMips(doc(text), settings({ project: { profile: 'P2' } }));
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses syscall 8 (read string)', () => {
      const text = `
.data
buf: .space 800
.text
main:
    li $v0, 8
    la $a0, buf
    li $a1, 800
    syscall
`;
      const result = parseMips(doc(text), settings({ project: { profile: 'P2' } }));
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses syscall 11 (print character)', () => {
      const text = `
.text
main:
    li $v0, 11
    li $a0, 65
    syscall
`;
      const result = parseMips(doc(text), settings({ project: { profile: 'P2' } }));
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses syscall 1 (print integer)', () => {
      const text = `
.text
main:
    li $v0, 1
    li $a0, 42
    syscall
`;
      const result = parseMips(doc(text), settings({ project: { profile: 'P2' } }));
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses syscall 4 (print string)', () => {
      const text = `
.data
msg: .asciiz "Hello"
.text
main:
    li $v0, 4
    la $a0, msg
    syscall
`;
      const result = parseMips(doc(text), settings({ project: { profile: 'P2' } }));
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses syscall 10 (exit)', () => {
      const text = `
.text
main:
    li $v0, 10
    syscall
`;
      const result = parseMips(doc(text), settings({ project: { profile: 'P2' } }));
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('sll for index-to-byte-offset (from bubble sort)', () => {
    it('parses sll for address calculation', () => {
      const text = `
.data
array: .space 400
.text
main:
    sll $t1, $t0, 2
    lw $t2, array($t1)
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('load/store pseudo address forms', () => {
    it('parses label plus offset memory operands from PseudoOps.txt', () => {
      const text = `
.data
array: .space 4
.text
main:
    lw $t0, array+100000($t1)
    sw $t0, array+100000
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('lb/sb for byte operations (from palindrome)', () => {
    it('parses lb for loading bytes', () => {
      const text = `
.text
main:
    lb $t0, 0($t1)
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses sb for storing bytes', () => {
      const text = `
.text
main:
    sb $t0, 0($t1)
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('lh/sh for halfword operations', () => {
    it('parses lh for loading halfwords', () => {
      const text = `
.text
main:
    lh $t0, 0($t1)
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses sh for storing halfwords', () => {
      const text = `
.text
main:
    sh $t0, 0($t1)
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('stack operations with $sp (from DFS, Hanoi)', () => {
    it('parses sw to stack pointer', () => {
      const text = `
.text
main:
    sw $ra, 0($sp)
    sw $s0, 4($sp)
    addi $sp, $sp, -8
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses lw from stack pointer', () => {
      const text = `
.text
main:
    addi $sp, $sp, 8
    lw $ra, 0($sp)
    lw $s0, 4($sp)
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('jr $ra for function return', () => {
    it('parses jr $ra', () => {
      const text = `
.text
main:
    jal func
    nop
    li $v0, 10
    syscall
func:
    jr $ra
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('.space for array allocation', () => {
    it('parses .space with various sizes', () => {
      const text = `
.data
arr1: .space 4
arr2: .space 40
arr3: .space 4000
arr4: .space 800
`;
      const result = parseMips(doc(text), settings());
      expect(result.dataSymbols.has('arr1')).toBe(true);
      expect(result.dataSymbols.has('arr2')).toBe(true);
      expect(result.dataSymbols.has('arr3')).toBe(true);
      expect(result.dataSymbols.has('arr4')).toBe(true);
    });
  });

  describe('.asciiz with escape sequences', () => {
    it('parses .asciiz with newline escape', () => {
      const text = `
.data
msg: .asciiz "Hello\\nWorld\\n"
`;
      const result = parseMips(doc(text), settings());
      expect(result.dataSymbols.has('msg')).toBe(true);
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses empty .asciiz', () => {
      const text = `
.data
empty: .asciiz ""
`;
      const result = parseMips(doc(text), settings());
      expect(result.dataSymbols.has('empty')).toBe(true);
    });
  });

  describe('.word with multiple values', () => {
    it('parses .word with comma-separated values', () => {
      const text = `
.data
arr: .word 1, 2, 3, 4, 5
`;
      const result = parseMips(doc(text), settings());
      expect(result.dataSymbols.has('arr')).toBe(true);
      expect(errorCodes(result)).toHaveLength(0);
    });

    it('parses .word with label references', () => {
      const text = `
.data
tbl: .word L0, L1, L2
.text
L0: nop
L1: nop
L2: nop
`;
      const result = parseMips(doc(text), settings());
      expect(result.dataSymbols.has('tbl')).toBe(true);
    });
  });

  describe('complete DFS program (from dfs.asm)', () => {
    it('parses the full DFS combination program without errors', () => {
      const text = `
.data
n: .word 4
r: .word 2
result: .space 40
space: .asciiz " "
newline: .asciiz "\\n"

.text
main:
    lw $s0, n
    lw $s1, r
    li $s2, 0
    la $s3, result
    jal dfs
    li $v0, 10
    syscall

dfs:
    sw $ra, 0($sp)
    addi $sp, $sp, -4
    beq $s2, $s1, print_result
    beqz $s2, start_from_one
    lw $t0, -4($s3)
    addi $t0, $t0, 1
    j loop
start_from_one:
    li $t0, 1
loop:
    bgt $t0, $s0, ret
    sll $t1, $s2, 2
    add $t1, $s3, $t1
    sw $t0, 0($t1)
    addi $s2, $s2, 1
    jal dfs
    addi $s2, $s2, -1
    addi $t0, $t0, 1
    j loop
ret:
    addi $sp, $sp, 4
    lw $ra, 0($sp)
    jr $ra

print_result:
    li $t0, 0
print_loop:
    beq $t0, $s2, print_newline
    sll $t1, $t0, 2
    add $t1, $s3, $t1
    lw $a0, 0($t1)
    li $v0, 1
    syscall
    la $a0, space
    li $v0, 4
    syscall
    addi $t0, $t0, 1
    j print_loop
print_newline:
    la $a0, newline
    li $v0, 4
    syscall
    j ret
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
      expect(result.labels.has('main')).toBe(true);
      expect(result.labels.has('dfs')).toBe(true);
      expect(result.labels.has('print_result')).toBe(true);
    });
  });

  describe('complete bubble sort program (from 2冒泡排序.asm)', () => {
    it('parses bubble sort pattern without errors', () => {
      const text = `
.data
array: .space 4000
space: .asciiz " "
newline: .asciiz "\\n"
lbracket: .asciiz "["
rbracket: .asciiz "]"

.text
main:
    li $v0, 5
    syscall
    move $s0, $v0
    la $s1, array
    li $t0, 0
read_loop:
    beq $t0, $s0, sort_init
    li $v0, 5
    syscall
    sll $t1, $t0, 2
    add $t1, $s1, $t1
    sw $v0, 0($t1)
    addi $t0, $t0, 1
    j read_loop

sort_init:
    li $t0, 0
outer_loop:
    addi $t1, $s0, -1
    beq $t0, $t1, print_init
    li $t2, 0
inner_loop:
    sub $t3, $s0, $t0
    addi $t3, $t3, -1
    beq $t2, $t3, outer_next
    sll $t4, $t2, 2
    add $t4, $s1, $t4
    lw $t5, 0($t4)
    lw $t6, 4($t4)
    ble $t5, $t6, no_swap
    sw $t6, 0($t4)
    sw $t5, 4($t4)
no_swap:
    addi $t2, $t2, 1
    j inner_loop
outer_next:
    addi $t0, $t0, 1
    j outer_loop

print_init:
    la $a0, lbracket
    li $v0, 4
    syscall
    li $t0, 0
print_loop:
    beq $t0, $s0, print_end
    sll $t1, $t0, 2
    add $t1, $s1, $t1
    lw $a0, 0($t1)
    li $v0, 1
    syscall
    addi $t2, $s0, -1
    beq $t0, $t2, skip_comma
    la $a0, space
    li $v0, 4
    syscall
skip_comma:
    addi $t0, $t0, 1
    j print_loop
print_end:
    la $a0, rbracket
    li $v0, 4
    syscall
    la $a0, newline
    li $v0, 4
    syscall
    li $v0, 10
    syscall
`;
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
    });
  });

  describe('nop instruction', () => {
    it('parses nop', () => {
      const text = '    nop';
      const result = parseMips(doc(text), settings());
      expect(errorCodes(result)).toHaveLength(0);
      expect(result.instructions).toHaveLength(1);
      expect(result.instructions[0].mnemonic).toBe('nop');
    });
  });

  describe('pseudo-instruction warning detection', () => {
    it('warns about pseudo-instructions when enabled', () => {
      const text = `
.text
main:
    li $v0, 10
    move $t0, $t1
    syscall
`;
      const result = parseMips(doc(text), settings({ mips: { warnPseudoInstruction: true } }));
      const pseudoWarnings = infoCodes(result).filter((c) => c.startsWith('pseudo-instruction'));
      expect(pseudoWarnings.length).toBeGreaterThan(0);
    });

    it('does not warn about pseudo-instructions when disabled', () => {
      const text = `
.text
main:
    li $v0, 10
    move $t0, $t1
    syscall
`;
      const result = parseMips(doc(text), settings({ mips: { warnPseudoInstruction: false } }));
      const pseudoWarnings = infoCodes(result).filter((c) => c.startsWith('pseudo-instruction'));
      expect(pseudoWarnings).toHaveLength(0);
    });
  });
});
