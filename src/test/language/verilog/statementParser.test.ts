import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexVerilogCst } from '../../../language/verilog/lexer';
import { collectVerilogStatementSources } from '../../../language/verilog/statementParser';

function doc(text: string): TextDocument {
  return TextDocument.create('test://cst.v', 'verilog', 1, text);
}

describe('Verilog statement sources', () => {
  it('keeps comments as trivia while exposing comment-free code tokens', () => {
    const text = [
      'module m;',
      '  wire [3:0] a; // data bus',
      '  /* block',
      '     comment */ assign a = 4\'h0;',
      'endmodule'
    ].join('\n');
    const { tokens } = lexVerilogCst(text);
    const codeTokens = tokens.filter((token) => token.kind !== 'comment');
    const statements = collectVerilogStatementSources(doc(text), codeTokens);

    expect(tokens.filter((token) => token.kind === 'comment')).toHaveLength(2);
    expect(codeTokens.some((token) => token.kind === 'comment')).toBe(false);
    expect(codeTokens.map((token) => token.value)).toContain('module');
    expect(statements.some((statement) => statement.tokens.some((token) => token.value === 'assign'))).toBe(true);
  });
});
