import type { VerilogAstDocument } from './ast';
import type { VerilogToken } from './lexer';

export function verilogAstCodeTokens(ast: VerilogAstDocument): VerilogToken[] {
  return ast.tokens
    .filter((token) => token.kind !== 'eof')
    .sort((left, right) => left.start - right.start || left.end - right.end);
}
