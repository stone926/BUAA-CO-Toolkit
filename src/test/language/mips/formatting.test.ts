import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getMipsFormattingEdits } from '../../../language/mips/formatting';

function format(text: string): string {
  const document = TextDocument.create('test://format.asm', 'mipsasm', 1, text);
  const edit = getMipsFormattingEdits(document)[0];
  return edit?.newText ?? text;
}

describe('MIPS AST formatting', () => {
  it('formats whole documents through the formatter AST', () => {
    const input = [
      '.data',
      'msg:.asciiz "hello,world"',
      '.text',
      'main:add $t0,$t1,$t2 # comment',
      'syscall'
    ].join('\n');

    expect(format(input)).toBe([
      '.data',
      'msg: .asciiz "hello,world"',
      '.text',
      'main: add $t0, $t1, $t2'.padEnd(32) + '# comment',
      '    syscall'
    ].join('\n'));
  });

  it('uses macro context when formatting directives inside macro bodies', () => {
    const input = [
      '.macro save($reg)',
      '.data',
      'slot:.word 0',
      '.text',
      'sw $reg,0($sp)',
      '.end_macro'
    ].join('\n');

    expect(format(input)).toBe([
      '.macro save($reg)',
      '    .data',
      'slot: .word 0',
      '    .text',
      '    sw $reg, 0($sp)',
      '.end_macro'
    ].join('\n'));
  });
});
