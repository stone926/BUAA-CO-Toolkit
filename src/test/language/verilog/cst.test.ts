import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseVerilogCst } from '../../../language/verilog/cst';

function doc(text: string): TextDocument {
  return TextDocument.create('test://cst.v', 'verilog', 1, text);
}

describe('Verilog CST', () => {
  it('keeps comments as trivia while exposing comment-free code tokens', () => {
    const text = [
      'module m;',
      '  wire [3:0] a; // data bus',
      '  /* block',
      '     comment */ assign a = 4\'h0;',
      'endmodule'
    ].join('\n');
    const cst = parseVerilogCst(doc(text), text);

    expect(cst.tokens.filter((token) => token.kind === 'comment')).toHaveLength(2);
    expect(cst.codeTokens.some((token) => token.kind === 'comment')).toBe(false);
    expect(cst.codeTokens.map((token) => token.value)).toContain('module');
    expect(cst.statements.some((statement) => statement.tokens.some((token) => token.value === 'assign'))).toBe(true);
  });
});
