import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexVerilogCst, VerilogLexDiagnostic, VerilogToken } from './lexer';
import { collectVerilogStatementSources, VerilogStatementSource } from './statementParser';
export { verilogTokenRange } from './tokenUtils';

export type VerilogCstStatement = VerilogStatementSource;

export interface VerilogCstDocument {
  tokens: VerilogToken[];
  codeTokens: VerilogToken[];
  diagnostics: VerilogLexDiagnostic[];
  statements: VerilogCstStatement[];
}

export function parseVerilogCst(document: TextDocument, text = document.getText()): VerilogCstDocument {
  const lexed = lexVerilogCst(text);
  const codeTokens = lexed.tokens.filter((token) => token.kind !== 'comment');
  return {
    tokens: lexed.tokens,
    codeTokens,
    diagnostics: lexed.diagnostics,
    statements: collectVerilogStatementSources(document, codeTokens)
  };
}
