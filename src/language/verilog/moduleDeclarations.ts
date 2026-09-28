// @index verilog-module-declarations — module-only parse for host commands
import { TextDocument } from 'vscode-languageserver-textdocument';
import { verilogCodeTokens } from './directiveBoundaries';
import { lexVerilogWithTrivia } from './lexer';
import { parseModulesFromTokens } from './moduleParser';
import type { VerilogModule } from './model';

/** Match parseVerilog's directive filtering without building AST or symbols. */
export function parseVerilogModuleDeclarations(document: TextDocument): VerilogModule[] {
  return parseVerilogModuleSource(document).modules;
}

/** Shared lexical result for callers that also need directives and AST nodes. */
export function parseVerilogModuleSource(document: TextDocument) {
  const text = document.getText();
  const lexed = lexVerilogWithTrivia(text);
  const tokens = lexed.tokens.filter((token) => token.kind !== 'comment');
  const codeTokens = verilogCodeTokens(text, tokens);
  const modules = parseModulesFromTokens(document, text, codeTokens);
  return { text, lexed, tokens, codeTokens, modules };
}
