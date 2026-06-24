import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { cp0ByOperand, pseudoExpansionPreview, syscallByOperand } from '../../../language/mips/display';
import { getMipsHover } from '../../../language/mips/hover';
import { parseMips } from '../../../language/mips/parser';
import { MipsServerState } from '../../../language/mips/state';

function doc(text: string): TextDocument {
  return TextDocument.create('test://hover.s', 'mipsasm', 1, text);
}

function state(): MipsServerState {
  return {
    ignoredPseudoInstructionFiles: new Set(),
    ignoredPseudoInstructionMnemonics: new Set()
  };
}

function hoverText(text: string, line: number, character: number): string {
  const hover = getMipsHover(doc(text), { line, character }, defaultCoSettings, state());
  const contents = hover?.contents;
  return typeof contents === 'string' ? contents : contents?.value ?? '';
}

describe('pseudoExpansionPreview', () => {
  it('matches MARS li immediate selection', () => {
    expect(pseudoExpansionPreview('li', ['$t0', '100'])).toEqual(['addiu $t0, $zero, 100']);
    expect(pseudoExpansionPreview('li', ['$t0', '-1'])).toEqual(['addiu $t0, $zero, -1']);
    expect(pseudoExpansionPreview('li', ['$t0', "'a'"])).toEqual(['addiu $t0, $zero, 97']);
    expect(pseudoExpansionPreview('li', ['$t0', '0xffff'])).toEqual(['ori $t0, $zero, 0xffff']);
    expect(pseudoExpansionPreview('li', ['$t0', '65536'])).toEqual(['lui $at, 0x0001', 'ori $t0, $at, 0x0000']);
  });

  it('does not expand the basic three-register mul instruction', () => {
    expect(pseudoExpansionPreview('mul', ['$s0', '$s1', '$s2'])).toBeUndefined();
  });

  it('expands the immediate mul pseudo form through $at', () => {
    expect(pseudoExpansionPreview('mul', ['$s0', '$s1', '5'])).toEqual([
      'addi $at, $zero, 5',
      'mul $s0, $s1, $at'
    ]);
  });
});

describe('getMipsHover instruction markdown', () => {
  it('keeps nop concise and does not show a redundant expansion block', () => {
    const text = hoverText('main: nop', 0, 7);
    expect(text).toContain('**nop**');
    expect(text).toContain('机器码为 0');
    expect(text).not.toContain('展开预览');
    expect(text).not.toContain('sll $zero, $zero, 0');
  });

  it('does not show pseudo expansion for basic mul register form', () => {
    const text = hoverText('    mul $s0, $s1, $s2', 0, 5);
    expect(text).toContain('**mul**');
    expect(text).not.toContain('当前写法：**伪指令形式**');
    expect(text).not.toContain('展开预览');
    expect(text).not.toContain('mflo');
  });

  it('shows compact expansion details for mul immediate form', () => {
    const text = hoverText('    mul $s0, $s1, 5', 0, 5);
    expect(text).toContain('当前写法：**伪指令形式**');
    expect(text).toContain('addi $at, $zero, 5');
    expect(text).toContain('mul $s0, $s1, $at');
    expect(text).toContain('展开会使用 `$at`');
  });

  it('prefers a data symbol hover when the symbol name matches an instruction', () => {
    const source = [
      '.data',
      'b: .word 0 : 64',
      '.text',
      '    la $t0, b',
      '    b done',
      'done: nop'
    ].join('\n');

    const declaration = hoverText(source, 1, 0);
    expect(declaration).toContain('数据符号');
    expect(declaration).not.toContain('Unconditional branch');

    const reference = hoverText(source, 3, 12);
    expect(reference).toContain('数据符号');
    expect(reference).not.toContain('Unconditional branch');

    const branch = hoverText(source, 4, 5);
    expect(branch).toContain('**b**');
    expect(branch).toContain('Unconditional branch');
  });

  it('shows .eqv replacement text from AST ranges', () => {
    const source = [
      '.eqv SYS_EXIT 10 # keep comment out of replacement',
      '    li $v0, SYS_EXIT'
    ].join('\n');

    const text = hoverText(source, 1, 13);
    expect(text).toContain('.eqv 符号');
    expect(text).toContain('替换为：`10`');
    expect(text).not.toContain('keep comment');
  });

  it('previews macro expansion from AST ranges without replacing strings or comments', () => {
    const source = [
      '.macro emit(%reg, %label)',
      '    .asciiz "%reg"',
      '%label: sw %reg, 4($sp) # %reg',
      '.end_macro',
      'emit($t0, done)'
    ].join('\n');

    const text = hoverText(source, 4, 1);
    expect(text).toContain('展开预览');
    expect(text).toContain('    .asciiz "%reg"');
    expect(text).toContain('done: sw $t0, 4($sp) # %reg');
  });
});

describe('syscallByOperand', () => {
  it('resolves character literal service numbers', () => {
    expect(syscallByOperand("'\\n'")?.code).toBe(10);
  });

  it('resolves service numbers from AST integer operands', () => {
    const parsed = parseMips(doc("li $v0, '\\n'"), defaultCoSettings);
    const operand = parsed.ast.statements[0].executable?.operands[1];

    expect(operand?.kind).toBe('integer');
    expect(operand ? syscallByOperand(operand)?.code : undefined).toBe(10);
  });
});

describe('cp0ByOperand', () => {
  it('resolves CP0 registers from AST operands', () => {
    const parsed = parseMips(doc('mtc0 $t0, $12'), defaultCoSettings);
    const operand = parsed.ast.statements[0].executable?.operands[1];

    expect(operand?.kind).toBe('register');
    expect(operand ? cp0ByOperand(operand)?.number : undefined).toBe(12);
  });
});

describe('getMipsHover for trap instructions', () => {
  it('shows hover for R-type trap instruction teq', () => {
    const text = hoverText('    teq $t0, $t1', 0, 5);
    expect(text).toContain('**teq**');
    expect(text).toContain('Trap if equal');
    expect(text).toContain('R 型指令');
  });

  it('shows hover for I-type trap instruction teqi', () => {
    const text = hoverText('    teqi $t0, 100', 0, 5);
    expect(text).toContain('**teqi**');
    expect(text).toContain('Trap if equal immediate');
    expect(text).toContain('I 型指令');
  });

  it('shows hover for tne instruction', () => {
    const text = hoverText('    tne $t0, $t1', 0, 5);
    expect(text).toContain('**tne**');
    expect(text).toContain('Trap if not equal');
  });

  it('shows hover for tge instruction', () => {
    const text = hoverText('    tge $t0, $t1', 0, 5);
    expect(text).toContain('**tge**');
    expect(text).toContain('Trap if greater or equal');
  });

  it('shows hover for tltu instruction', () => {
    const text = hoverText('    tltu $t0, $t1', 0, 5);
    expect(text).toContain('**tltu**');
    expect(text).toContain('Trap if less than unsigned');
  });
});
