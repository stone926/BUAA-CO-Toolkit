import type { VerilogAstDocument, VerilogStatementAst } from './ast';
import type { VerilogToken } from './lexer';

export function verilogAstCodeTokens(ast: VerilogAstDocument): VerilogToken[] {
  return ast.tokens
    .filter((token) => token.kind !== 'eof')
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

export function verilogAstStatementTokens(ast: VerilogAstDocument): VerilogToken[] {
  const tokens: VerilogToken[] = [];
  for (const statement of ast.topLevelStatements) {
    tokens.push(...verilogStatementTokens(statement));
  }
  for (const moduleAst of ast.modules) {
    for (const statement of moduleAst.items) {
      tokens.push(...verilogStatementTokens(statement));
    }
  }
  return tokens;
}

export function verilogStatementTokens(statement: VerilogStatementAst): VerilogToken[] {
  return statement.tokens;
}
