import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { FormattingOptions } from 'vscode-languageserver/node';
import { getMipsFormattingEdits } from '../../../language/mips/formatting';
import { findCommentIndex, tokenizeCode } from '../../../mips/core/assembler/syntax';
import { assembleMarsSource } from '../../../mips/core/assembler/marsAssembler';

function format(text: string, options?: FormattingOptions): string {
  const document = TextDocument.create('test://format.asm', 'mipsasm', 1, text);
  return TextDocument.applyEdits(document, getMipsFormattingEdits(document, options));
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

  it('keeps macro call parentheses attached to the macro name', () => {
    expect(format('read_int ($s0)')).toBe('    read_int($s0)');
  });

  it('adds a space after comment markers', () => {
    expect(format('nop #comment')).toBe('    nop'.padEnd(32) + '# comment');
    expect(format('#comment')).toBe('# comment');
  });

  it('preserves literal values and the assembled program when commas occur in characters and strings', () => {
    const input = [
      '.data',
      "chars:.byte ',', '(', ')', '#', '\\'', '\\\\'",
      'text:.asciiz "a,b # c", "escaped \\"quote\\""',
      '.text',
      'li $a0,44',
      'li $v0,10',
      'syscall'
    ].join('\n');
    const output = format(input);
    expect(output).toContain("chars: .byte ',', '(', ')', '#', '\\'', '\\\\'");
    expect(format("li $a0,','")).toBe("    li $a0, ','");
    const before = assembleMarsSource({ id: 'source', text: input });
    const after = assembleMarsSource({ id: 'source', text: output });
    expect(before.diagnostics).toEqual([]);
    expect(after.diagnostics).toEqual([]);
    expect(after.image?.segments).toEqual(before.image?.segments);
  });

  it('normalizes commas inside macro argument lists without changing quoted arguments', () => {
    const input = ['.macro put(%x,%y)', 'li %x,%y', '.end_macro', "put($a0,',')"].join('\n');
    expect(format(input)).toBe(['.macro put(%x, %y)', '    li %x, %y', '.end_macro', "    put($a0, ',')"].join('\n'));
  });

  it.each([
    '%op $t0,$t1',
    'main: ??? # unfinished',
    '123 garbage',
    '    $',
    '.asciiz "unfinished, with spaces  ',
    '.asciiz "escaped closing quote\\"  ',
    ".byte 'unterminated,   ",
    '\ufeff.data',
    '$name.sub:',
    '$name.sub: nop',
    '$name.sub $t0,$t1',
    'main: $name.sub $t0,$t1'
  ])('preserves unsupported or incomplete source: %j', (input) => {
    expect(format(input)).toBe(input);
  });

  it('still formats adjacent labels and mnemonics when parser boundaries match lexer tokens', () => {
    expect(format('$name:nop')).toBe('$name: nop');
    expect(format('name.sub:nop')).toBe('name.sub: nop');
    expect(format('main:add.s $f0,$f1,$f2')).toBe('main: add.s $f0, $f1, $f2');
    expect(format('main:next:nop')).toBe('main: next: nop');
  });

  it('keeps non-whitespace lexical tokens unchanged, including escapes and adjacent comments', () => {
    const input = [
      '.eqv COMMA,\',\'',
      'main :add $t0,$t1,$t2#comment',
      '.asciiz "a,b", "slash\\\\", "quote\\\"#inside" #tail',
      "pass('(', ',', '#')"
    ].join('\n');
    const tokens = (text: string) => text.split('\n').flatMap((line) => {
      const comment = findCommentIndex(line);
      return tokenizeCode(comment < 0 ? line : line.slice(0, comment), '', 0).map((token) => [token.kind, token.text]);
    });
    const output = format(input);
    expect(tokens(output)).toEqual(tokens(input));
    expect(format(output)).toBe(output);
  });

  it.each([
    [{ tabSize: 2, insertSpaces: true }, '  '],
    [{ tabSize: 8, insertSpaces: false }, '\t']
  ] satisfies Array<[FormattingOptions, string]>)('uses editor indentation options %j and aligns comments by display columns', (options, indent) => {
    const input = '.macro test\nnop #comment\n.data\n.end_macro';
    const code = `${indent}nop`;
    const visualLength = options.tabSize + 3;
    const output = format(input, options);
    expect(output).toBe(`.macro test\n${code}${' '.repeat(32 - visualLength)}# comment\n${indent}.data\n.end_macro`);
    expect(format(output, options)).toBe(output);
  });

  it.each(['\n', '\r\n', '\r'])('preserves line endings and EOF by default (%j)', (eol) => {
    for (const suffix of ['', eol, eol + eol]) {
      const output = format(`.text${eol}nop${suffix}`);
      expect(output).toBe(`.text${eol}    nop${suffix}`);
      expect(format(output)).toBe(output);
    }
  });

  it.each([
    [NaN, 4], [Infinity, 4], [-Infinity, 4],
    [-100, 1], [0, 1], [0.5, 1], [2.9, 2],
    [Number.MAX_VALUE, 16]
  ])('bounds tabSize %s to %i for indentation and comment alignment', (supplied, bounded) => {
    for (const insertSpaces of [true, false]) {
      const options = { tabSize: supplied, insertSpaces };
      const indent = insertSpaces ? ' '.repeat(bounded) : '\t';
      const output = format('nop #comment', options);
      expect(output).toBe(`${indent}nop${' '.repeat(32 - bounded - 3)}# comment`);
      expect(format(output, options)).toBe(output);
    }
  });

  it('honors final newline and trailing whitespace options', () => {
    const options: FormattingOptions = { tabSize: 2, insertSpaces: true, insertFinalNewline: true, trimFinalNewlines: true };
    expect(format('nop', options)).toBe('  nop\n');
    expect(format('nop\r\n\r\n\r\n', options)).toBe('  nop\r\n');
    expect(format('nop  \n \n#comment  ', { ...options, trimTrailingWhitespace: false })).toBe('  nop  \n \n# comment  \n');
    expect(format('', options)).toBe('');
  });

  it('returns an empty edit list for already formatted source and edits only through the real EOF', () => {
    const document = TextDocument.create('test://format.asm', 'mipsasm', 1, 'nop');
    expect(getMipsFormattingEdits(document)[0]?.range.end).toEqual({ line: 0, character: 3 });
    expect(getMipsFormattingEdits(TextDocument.create(document.uri, document.languageId, 2, '    nop'))).toEqual([]);
  });
});
