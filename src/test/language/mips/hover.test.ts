import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { pseudoExpansionPreview, syscallByOperand } from '../../../language/mips/display';
import { getMipsHover } from '../../../language/mips/hover';
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
    expect(text).not.toContain('当前写法：**MARS 扩展伪格式**');
    expect(text).not.toContain('展开预览');
    expect(text).not.toContain('mflo');
  });

  it('shows compact expansion details for mul immediate form', () => {
    const text = hoverText('    mul $s0, $s1, 5', 0, 5);
    expect(text).toContain('当前写法：**MARS 扩展伪格式**');
    expect(text).toContain('addi $at, $zero, 5');
    expect(text).toContain('mul $s0, $s1, $at');
    expect(text).toContain('展开会使用 `$at`');
  });
});

describe('syscallByOperand', () => {
  it('resolves character literal service numbers', () => {
    expect(syscallByOperand("'\\n'")?.code).toBe(10);
  });
});
