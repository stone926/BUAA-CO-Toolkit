import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getMipsWordRange } from '../../../language/mips/text';

function doc(text: string): TextDocument {
  return TextDocument.create('test://text.s', 'mipsasm', 1, text);
}

function wordAt(text: string, character: number): string | undefined {
  const document = doc(text);
  const range = getMipsWordRange(document, { line: 0, character });
  return range ? document.getText(range) : undefined;
}

describe('getMipsWordRange', () => {
  it('resolves labels, mnemonics, and typed operands from the AST', () => {
    const text = 'main: lw $t0, arr+4($sp) # arr';

    expect(wordAt(text, 1)).toBe('main');
    expect(wordAt(text, 6)).toBe('lw');
    expect(wordAt(text, 10)).toBe('$t0');
    expect(wordAt(text, 15)).toBe('arr');
    expect(wordAt(text, 18)).toBe('+4');
    expect(wordAt(text, 21)).toBe('$sp');
  });

  it('ignores string literals and comments', () => {
    const text = '.asciiz "hello # world" # comment';

    expect(wordAt(text, 1)).toBe('.asciiz');
    expect(wordAt(text, 10)).toBeUndefined();
    expect(wordAt(text, 27)).toBeUndefined();
  });

  it('keeps character literals addressable as integer operands', () => {
    expect(wordAt("li $v0, '\\n'", 9)).toBe("'\\n'");
  });
});
