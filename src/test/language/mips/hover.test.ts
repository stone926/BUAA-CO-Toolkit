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
  if (Array.isArray(contents)) {
    return contents.map((entry) => typeof entry === 'string' ? entry : entry.value).join('\n');
  }
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

  it('matches MARS logical immediate pseudo forms for negative values', () => {
    expect(pseudoExpansionPreview('ori', ['$t0', '$zero', '-1'])).toEqual([
      'lui $at, 0xffff',
      'ori $at, $at, 0xffff',
      'or $t0, $zero, $at'
    ]);
    expect(pseudoExpansionPreview('xori', ['$t1', '$t1', '-32768'])).toEqual([
      'lui $at, 0xffff',
      'ori $at, $at, 0x8000',
      'xor $t1, $t1, $at'
    ]);
    expect(pseudoExpansionPreview('andi', ['$t2', '-1'])).toEqual([
      'lui $at, 0xffff',
      'ori $at, $at, 0xffff',
      'and $t2, $t2, $at'
    ]);
    expect(pseudoExpansionPreview('ori', ['$t0', '$zero', '0xffff'])).toBeUndefined();
  });

  // ── Single-form simple pseudos ──
  it('expands la with label', () => {
    expect(pseudoExpansionPreview('la', ['$t0', 'label'])).toEqual([
      'lui $at, %hi(label)', 'ori $t0, $at, %lo(label)'
    ]);
  });
  it('expands move', () => {
    expect(pseudoExpansionPreview('move', ['$t0', '$t1'])).toEqual(['addu $t0, $zero, $t1']);
  });
  it('expands b', () => {
    expect(pseudoExpansionPreview('b', ['target'])).toEqual(['bgez $zero, target']);
  });
  it('expands beqz / bnez', () => {
    expect(pseudoExpansionPreview('beqz', ['$t0', 'target'])).toEqual(['beq $t0, $zero, target']);
    expect(pseudoExpansionPreview('bnez', ['$t0', 'target'])).toEqual(['bne $t0, $zero, target']);
  });
  it('expands not / neg / negu / abs', () => {
    expect(pseudoExpansionPreview('not', ['$t0', '$t1'])).toEqual(['nor $t0, $t1, $zero']);
    expect(pseudoExpansionPreview('neg', ['$t0', '$t1'])).toEqual(['sub $t0, $zero, $t1']);
    expect(pseudoExpansionPreview('negu', ['$t0', '$t1'])).toEqual(['subu $t0, $zero, $t1']);
    expect(pseudoExpansionPreview('abs', ['$t0', '$t1'])).toEqual([
      'sra $at, $t1, 31', 'xor $t0, $at, $t1', 'subu $t0, $t0, $at'
    ]);
  });

  // ── add/addu/sub/subu with immediate ──
  it('expands add with imm16 via addi', () => {
    expect(pseudoExpansionPreview('add', ['$t0', '$t1', '-100'])).toEqual(['addi $t0, $t1, -100']);
  });
  it('expands add with imm32 via lui+ori+add', () => {
    expect(pseudoExpansionPreview('add', ['$t0', '$t1', '100000'])).toEqual([
      'lui $at, 0x0001', 'ori $at, $at, 0x86a0', 'add $t0, $t1, $at'
    ]);
  });
  it('expands sub with imm16 via addi+sub', () => {
    expect(pseudoExpansionPreview('sub', ['$t0', '$t1', '-100'])).toEqual([
      'addi $at, $zero, -100', 'sub $t0, $t1, $at'
    ]);
  });
  it('expands subu with imm32', () => {
    const r = pseudoExpansionPreview('subu', ['$t0', '$t1', '100000']);
    expect(r?.[0]).toBe('lui $at, 0x0001');
    expect(r?.[2]).toBe('subu $t0, $t1, $at');
  });

  // ── addi/addiu/subi/subiu with large immediate ──
  it('expands addi with out-of-range immediate', () => {
    const r = pseudoExpansionPreview('addi', ['$t0', '$t1', '100000']);
    expect(r?.[0]).toBe('lui $at, 0x0001');
    expect(r?.[2]).toBe('add $t0, $t1, $at');
  });
  it('does not expand addi with in-range immediate', () => {
    expect(pseudoExpansionPreview('addi', ['$t0', '$t1', '-100'])).toBeUndefined();
  });
  it('expands subi with imm16', () => {
    expect(pseudoExpansionPreview('subi', ['$t0', '$t1', '-100'])).toEqual([
      'addi $at, $zero, -100', 'sub $t0, $t1, $at'
    ]);
  });
  it('expands subiu with imm32', () => {
    const r = pseudoExpansionPreview('subiu', ['$t0', '$t1', '100000']);
    expect(r?.[0]).toBe('lui $at, 0x0001');
    expect(r?.[2]).toBe('subu $t0, $t1, $at');
  });

  // ── andi/ori/xori ──
  it('expands andi 2-op with imm32 via lui+ori+and', () => {
    expect(pseudoExpansionPreview('andi', ['$t0', '100000'])).toEqual([
      'lui $at, 0x0001', 'ori $at, $at, 0x86a0', 'and $t0, $t0, $at'
    ]);
  });
  it('does not expand andi with in-range uimm16', () => {
    expect(pseudoExpansionPreview('andi', ['$t0', '$zero', '0xffff'])).toBeUndefined();
  });
  it('expands ori 3-op with imm32', () => {
    expect(pseudoExpansionPreview('ori', ['$t0', '$t1', '100000'])).toEqual([
      'lui $at, 0x0001', 'ori $at, $at, 0x86a0', 'or $t0, $t1, $at'
    ]);
  });

  // ── and/or/xor with uimm16 ──
  it('expands and 2-op with uimm16', () => {
    expect(pseudoExpansionPreview('and', ['$t0', '0xff'])).toEqual(['andi $t0, $t0, 0x00ff']);
  });
  it('expands or 3-op with uimm16', () => {
    expect(pseudoExpansionPreview('or', ['$t0', '$t1', '0xff'])).toEqual(['ori $t0, $t1, 0x00ff']);
  });

  // ── div/divu/rem/remu ──
  it('expands div 3-reg with divide-by-zero guard', () => {
    expect(pseudoExpansionPreview('div', ['$t0', '$t1', '$t2'])).toEqual([
      'bne $t2, $zero, 1', 'break', 'div $t1, $t2', 'mflo $t0'
    ]);
  });
  it('expands div with immediate divisor', () => {
    expect(pseudoExpansionPreview('div', ['$t0', '$t1', '5'])).toEqual([
      'addi $at, $zero, 5', 'div $t1, $at', 'mflo $t0'
    ]);
  });
  it('expands remu 3-reg', () => {
    expect(pseudoExpansionPreview('remu', ['$t0', '$t1', '$t2'])).toEqual([
      'bne $t2, $zero, 1', 'break', 'divu $t1, $t2', 'mfhi $t0'
    ]);
  });
  it('expands rem with immediate', () => {
    expect(pseudoExpansionPreview('rem', ['$t0', '$t1', '100000'])).toEqual([
      'lui $at, 0x0001', 'ori $at, $at, 0x86a0', 'div $t1, $at', 'mfhi $t0'
    ]);
  });

  // ── beq/bne with immediate ──
  it('expands beq with immediate via $at', () => {
    expect(pseudoExpansionPreview('beq', ['$t0', '5', 'target'])).toEqual([
      'addi $at, $zero, 5', 'beq $at, $t0, target'
    ]);
  });
  it('does not expand beq register-register (real instruction)', () => {
    expect(pseudoExpansionPreview('beq', ['$t0', '$t1', 'target'])).toBeUndefined();
  });

  // ── Branch pseudos ──
  it('expands blt reg-reg', () => {
    expect(pseudoExpansionPreview('blt', ['$t0', '$t1', 'target'])).toEqual([
      'slt $at, $t0, $t1', 'bne $at, $zero, target'
    ]);
  });
  it('expands bgt with immediate', () => {
    expect(pseudoExpansionPreview('bgt', ['$t0', '5', 'target'])).toEqual([
      'addi $at, $zero, 5', 'slt $at, $at, $t0', 'bne $at, $zero, target'
    ]);
  });
  it('expands ble reg-reg', () => {
    expect(pseudoExpansionPreview('ble', ['$t0', '$t1', 'target'])).toEqual([
      'slt $at, $t1, $t0', 'beq $at, $zero, target'
    ]);
  });
  it('expands bge with imm32', () => {
    expect(pseudoExpansionPreview('bge', ['$t0', '100000', 'target'])).toEqual([
      'lui $at, 0x0001', 'ori $at, $at, 0x86a0', 'slt $at, $t0, $at', 'beq $at, $zero, target'
    ]);
  });
  it('expands bgeu reg-reg', () => {
    expect(pseudoExpansionPreview('bgeu', ['$t0', '$t1', 'target'])).toEqual([
      'sltu $at, $t0, $t1', 'beq $at, $zero, target'
    ]);
  });

  // ── Set pseudos ──
  it('expands seq 3-reg', () => {
    expect(pseudoExpansionPreview('seq', ['$t0', '$t1', '$t2'])).toEqual([
      'subu $t0, $t1, $t2', 'ori $at, $zero, 1', 'sltu $t0, $t0, $at'
    ]);
  });
  it('expands sgt 3-reg (just slt reversed)', () => {
    expect(pseudoExpansionPreview('sgt', ['$t0', '$t1', '$t2'])).toEqual(['slt $t0, $t2, $t1']);
  });
  it('expands sle 3-reg', () => {
    expect(pseudoExpansionPreview('sle', ['$t0', '$t1', '$t2'])).toEqual([
      'slt $t0, $t2, $t1', 'ori $at, $zero, 1', 'subu $t0, $at, $t0'
    ]);
  });
  it('expands seq with immediate', () => {
    expect(pseudoExpansionPreview('seq', ['$t0', '$t1', '5'])).toEqual([
      'addi $at, $zero, 5', 'subu $t0, $t1, $at', 'ori $at, $zero, 1', 'sltu $t0, $t0, $at'
    ]);
  });
  it('expands sgeu with imm32', () => {
    expect(pseudoExpansionPreview('sgeu', ['$t0', '$t1', '100000'])).toEqual([
      'lui $at, 0x0001', 'ori $at, $at, 0x86a0',
      'sltu $t0, $t1, $at', 'ori $at, $zero, 1', 'subu $t0, $at, $t0'
    ]);
  });

  // ── Load/store pseudo addressing ──
  it('expands lw with label', () => {
    expect(pseudoExpansionPreview('lw', ['$t0', 'var'])).toEqual([
      'lui $at, %hi(var)', 'lw $t0, %lo(var)($at)'
    ]);
  });
  it('expands sw with imm32 absolute address', () => {
    expect(pseudoExpansionPreview('sw', ['$t0', '100000'])).toEqual([
      'lui $at, 0x0001', 'ori $at, $at, 0x86a0', 'sw $t0, 0($at)'
    ]);
  });
  it('does not expand lw with simm16 offset (real instruction)', () => {
    expect(pseudoExpansionPreview('lw', ['$t0', '4($sp)'])).toBeUndefined();
  });
  it('expands lb with label(base)', () => {
    expect(pseudoExpansionPreview('lb', ['$t0', 'var($t1)'])).toEqual([
      'lui $at, %hi(var)', 'addu $at, $at, $t1', 'lb $t0, %lo(var)($at)'
    ]);
  });
  it('expands sh with large offset(base)', () => {
    expect(pseudoExpansionPreview('sh', ['$t0', '100000($t1)'])).toEqual([
      'lui $at, %hi(100000)', 'addu $at, $at, $t1', 'sh $t0, %lo(100000)($at)'
    ]);
  });
  it('expands lhu with label', () => {
    expect(pseudoExpansionPreview('lhu', ['$t0', 'var'])).toEqual([
      'lui $at, %hi(var)', 'lhu $t0, %lo(var)($at)'
    ]);
  });
  it('expands sb with label(base)', () => {
    expect(pseudoExpansionPreview('sb', ['$t0', 'arr($t1)'])).toEqual([
      'lui $at, %hi(arr)', 'addu $at, $at, $t1', 'sb $t0, %lo(arr)($at)'
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
