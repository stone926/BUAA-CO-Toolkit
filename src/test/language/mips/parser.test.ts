import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseMips } from '../../../language/mips/parser';
import { defaultCoSettings, CoSettings } from '../../../language/common/settings';

function doc(text: string): TextDocument {
  return TextDocument.create('test://test.s', 'mipsasm', 1, text);
}

function settings(overrides: Record<string, unknown> = {}): CoSettings {
  const o = overrides as Record<string, Record<string, unknown>>;
  return {
    ...defaultCoSettings,
    ...overrides,
    project: { ...defaultCoSettings.project, ...(o.project ?? {}) },
    mips: { ...defaultCoSettings.mips, ...(o.mips ?? {}) },
    verilog: {
      implicitNet: { ...defaultCoSettings.verilog.implicitNet, ...(o.verilog?.implicitNet ?? {}) },
      lint: { ...defaultCoSettings.verilog.lint, ...(o.verilog?.lint ?? {}) }
    }
  };
}

function diagCodes(result: ReturnType<typeof parseMips>): string[] {
  return result.diagnostics.map((d) => d.code as string);
}

// ────────────────────────────────────────────────────────────────────────────────
// parseMips — basic parsing
// ────────────────────────────────────────────────────────────────────────────────
describe('parseMips', () => {
  describe('basic label and instruction parsing', () => {
    it('parses labels', () => {
      const text = 'main:\n    nop';
      const result = parseMips(doc(text), settings());
      expect(result.labels.has('main')).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });

    it('parses data symbols', () => {
      const text = '.data\nmsg: .asciiz "hello"';
      const result = parseMips(doc(text), settings());
      expect(result.dataSymbols.has('msg')).toBe(true);
    });

    it('parses instructions without errors', () => {
      const text = '.text\nmain:\n    add $t0, $t1, $t2\n    nop\n    syscall';
      const result = parseMips(doc(text), settings());
      expect(result.instructions).toHaveLength(3);
      expect(result.instructions[0].mnemonic).toBe('add');
    });

    it('handles empty documents', () => {
      const result = parseMips(doc(''), settings());
      expect(result.labels.size).toBe(0);
      expect(result.instructions).toHaveLength(0);
      expect(result.diagnostics).toHaveLength(0);
    });

    it('handles comment-only documents', () => {
      const result = parseMips(doc('# just a comment\n# another comment'), settings());
      expect(result.labels.size).toBe(0);
      expect(result.instructions).toHaveLength(0);
      expect(result.diagnostics).toHaveLength(0);
    });
  });

  describe('directive validation — boundary cases', () => {
    it('accepts .byte with valid values', () => {
      const text = '.data\n    .byte 1, 2, 3';
      const result = parseMips(doc(text), settings());
      const errors = result.diagnostics.filter((d) => d.severity === 1);
      expect(errors).toHaveLength(0);
    });

    it('accepts .half with valid values', () => {
      const text = '.data\n    .half 1, 2';
      const result = parseMips(doc(text), settings());
      const errors = result.diagnostics.filter((d) => d.severity === 1);
      expect(errors).toHaveLength(0);
    });

    it('accepts .float with valid values', () => {
      const text = '.data\n    .float 3.14, 2.0';
      const result = parseMips(doc(text), settings());
      const errors = result.diagnostics.filter((d) => d.severity === 1);
      expect(errors).toHaveLength(0);
    });

    it('accepts .asciiz with valid string', () => {
      const text = '.data\n    .asciiz "hello"';
      const result = parseMips(doc(text), settings());
      const errors = result.diagnostics.filter((d) => d.severity === 1);
      expect(errors).toHaveLength(0);
    });

    it('accepts .globl with label', () => {
      const text = '.globl main\nmain: nop';
      const result = parseMips(doc(text), settings());
      const errors = result.diagnostics.filter((d) => d.severity === 1);
      expect(errors).toHaveLength(0);
    });

    it('accepts .include with quoted path', () => {
      const text = '.include "utils.asm"';
      const result = parseMips(doc(text), settings());
      const errors = result.diagnostics.filter((d) => d.code === 'directive-operand');
      expect(errors).toHaveLength(0);
    });

    it('reports error for .include without quotes', () => {
      const text = '.include utils.asm';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('directive-operand');
    });
  });

  describe('instruction in wrong section', () => {
    it('reports error for instruction in .data segment', () => {
      const text = '.data\n    add $t0, $t1, $t2';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('instruction-in-data');
    });

    it('does not report error for instruction in .text segment', () => {
      const text = '.text\n    add $t0, $t1, $t2';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).not.toContain('instruction-in-data');
    });
  });

  describe('multiple labels on one line', () => {
    it('parses multiple labels on the same line', () => {
      const text = 'a: b: c: nop';
      const result = parseMips(doc(text), settings());
      expect(result.labels.has('a')).toBe(true);
      expect(result.labels.has('b')).toBe(true);
      expect(result.labels.has('c')).toBe(true);
    });
  });

  describe('.eqv handling', () => {
    it('parses .eqv definitions', () => {
      const text = '.eqv MY_CONST 42\n    li $v0, MY_CONST';
      const result = parseMips(doc(text), settings());
      expect(result.eqvSymbols.has('MY_CONST')).toBe(true);
      // No errors (pseudo-instruction info-level diagnostics are acceptable)
      const errors = result.diagnostics.filter((d) => d.severity === 1);
      expect(errors).toHaveLength(0);
    });

    it('reports error for duplicate .eqv', () => {
      const text = '.eqv X 1\n.eqv X 2';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('duplicate-symbol');
    });

    it('detects .eqv forward reference', () => {
      const text = '    li $v0, MY_CONST\n.eqv MY_CONST 42';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('eqv-forward-reference');
    });
  });

  describe('macro handling', () => {
    it('parses macro definitions', () => {
      const text = '.macro my_macro(%a, %b)\n    add $t0, %a, %b\n.end_macro';
      const result = parseMips(doc(text), settings());
      expect(result.macros.has('my_macro')).toBe(true);
      const overloads = result.macros.get('my_macro')!;
      expect(overloads).toHaveLength(1);
      expect(overloads[0].params).toEqual(['%a', '%b']);
    });

    it('reports error for missing .end_macro', () => {
      const text = '.macro my_macro(%a)\n    add $t0, %a, $zero';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('macro-unclosed');
    });

    it('warns about nested macros', () => {
      const text = '.macro outer()\n.inner:\n    .macro inner()\n    .end_macro\n.end_macro';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('nested-macro');
    });

    it('reports error for duplicate macro with same param count', () => {
      const text = '.macro foo(%a)\n.end_macro\n.macro foo(%b)\n.end_macro';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('duplicate-macro');
    });

    it('allows macro overloading with different param counts', () => {
      const text = '.macro foo(%a)\n.end_macro\n.macro foo(%a, %b)\n.end_macro';
      const result = parseMips(doc(text), settings());
      expect(result.macros.get('foo')).toHaveLength(2);
      expect(result.diagnostics.filter((d) => d.code === 'duplicate-macro')).toHaveLength(0);
    });

    it('detects wrong number of macro arguments', () => {
      const text = '.macro foo(%a, %b)\n.end_macro\nfoo($t0)';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('macro-argument-count');
    });

    it('detects duplicate macro parameters', () => {
      const text = '.macro foo(%a, %a)\n.end_macro';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('duplicate-macro-parameter');
    });
  });

  describe('section handling', () => {
    it('switches between .text and .data sections', () => {
      const text = '.text\nmain: nop\n.data\nmsg: .word 42';
      const result = parseMips(doc(text), settings());
      expect(result.labels.has('main')).toBe(true);
      expect(result.dataSymbols.has('msg')).toBe(true);
    });

    it('reports error for instruction in data segment', () => {
      const text = '.data\n    add $t0, $t1, $t2';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('instruction-in-data');
    });
  });

  describe('duplicate symbol detection', () => {
    it('reports error for duplicate labels', () => {
      const text = 'loop:\nnop\nloop: nop';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('duplicate-symbol');
    });

    it('reports error for duplicate data symbols', () => {
      const text = '.data\nmsg: .word 1\nmsg: .word 2';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('duplicate-symbol');
    });
  });

  describe('undeclared symbol detection', () => {
    it('reports error for undefined labels', () => {
      const text = '    beq $t0, $t1, undefined_label';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('missing-label');
    });

    it('does not report error for defined labels', () => {
      const text = '    beq $t0, $t1, target\n    nop\ntarget: nop';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).not.toContain('missing-label');
    });

    it('reports error for undeclared macro parameters', () => {
      const text = '    add $t0, %undefined, $t1';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('undeclared-symbol');
    });
  });

  describe('directive validation', () => {
    it('reports error for unknown directive', () => {
      const text = '    .unknown_directive';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('unknown-directive');
    });

    it('reports error for .word in non-data segment', () => {
      const text = '.text\n    .word 42';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('directive-segment');
    });

    it('reports error for non-integer operand in .word', () => {
      const text = '.data\n    .word "hello"';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('directive-operand');
    });

    it('accepts valid .word with integer', () => {
      const text = '.data\n    .word 42';
      const result = parseMips(doc(text), settings());
      const errors = result.diagnostics.filter((d) => d.severity === 1);
      expect(errors).toHaveLength(0);
    });

    it('accepts .word with label reference', () => {
      const text = '.data\n    .word main\n.text\nmain: nop';
      const result = parseMips(doc(text), settings());
      const errors = result.diagnostics.filter((d) => d.code === 'directive-operand');
      expect(errors).toHaveLength(0);
    });

    it('reports error for .space with non-multiple-of-4', () => {
      const text = '.data\n    .space 3';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('space-alignment');
    });

    it('accepts .space with multiple of 4', () => {
      const text = '.data\n    .space 8';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).not.toContain('space-alignment');
    });

    it('reports warning for large .align values', () => {
      const text = '.data\n    .align 5';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('align-large');
    });
  });

  describe('P2 syscall tracking', () => {
    it('warns when syscall is used without prior $v0 initialization in P2', () => {
      const text = '    syscall';
      const result = parseMips(doc(text), settings({ project: { profile: 'P2' } }));
      expect(diagCodes(result)).toContain('syscall-v0-uninitialized');
    });

    it('does not warn when $v0 is set before syscall', () => {
      const text = '    li $v0, 10\n    syscall';
      const result = parseMips(doc(text), settings({ project: { profile: 'P2' } }));
      expect(diagCodes(result)).not.toContain('syscall-v0-uninitialized');
    });

    it('warns about missing exit syscall in P2 programs with enough lines', () => {
      const text = 'main:\n    add $t0, $t1, $t2\n    sub $t3, $t4, $t5\n    nop';
      const result = parseMips(doc(text), settings({ project: { profile: 'P2' }, mips: { warnMissingExitSyscall: true } }));
      expect(diagCodes(result)).toContain('missing-syscall');
    });

    it('does not warn about missing syscall when one exists', () => {
      const text = 'main:\n    li $v0, 10\n    syscall';
      const result = parseMips(doc(text), settings({ project: { profile: 'P2' }, mips: { warnMissingExitSyscall: true } }));
      expect(diagCodes(result)).not.toContain('missing-syscall');
    });
  });

  describe('register validation', () => {
    it('reports error for unknown registers', () => {
      const text = '    add $invalid, $t1, $t2';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('unknown-register');
    });

    it('accepts all standard registers', () => {
      const text = '    add $zero, $at, $v0';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).not.toContain('unknown-register');
    });
  });

  describe('reserved identifier detection', () => {
    it('reports error for label that conflicts with register name', () => {
      const text = '$t0: nop';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('reserved-symbol');
    });

    it('reports error for label that conflicts with instruction name', () => {
      const text = 'add: nop';
      const result = parseMips(doc(text), settings());
      expect(diagCodes(result)).toContain('reserved-symbol');
    });
  });

  describe('macro scope isolation', () => {
    it('labels inside macros are scoped to the macro', () => {
      const text = '.macro my_macro()\ninner: nop\n.end_macro\nouter: nop';
      const result = parseMips(doc(text), settings());
      // 'inner' should be in macro scope, not global
      expect(result.labels.has('inner')).toBe(false);
      expect(result.labels.has('outer')).toBe(true);
    });
  });
});
