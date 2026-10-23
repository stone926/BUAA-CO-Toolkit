// @index verilog-module-declarations — module-only parse for host commands
import { TextDocument } from 'vscode-languageserver-textdocument';
import { activeVerilogTokens, objectMacroExpressionsFromTokens } from './preprocessor';
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
  const activeStarts = new Set(activeVerilogTokens(text, tokens).map((token) => token.start));
  const lexicalDiagnostics = lexed.diagnostics.filter((diagnostic) =>
    diagnostic.code === 'syntax-unclosed-comment' || activeStarts.has(diagnostic.start));
  const codeTokens = verilogCodeTokens(text, tokens);
  const modules = parseModulesFromTokens(document, text, codeTokens, objectMacroExpressionsFromTokens(text, tokens));
  return { text, lexed, tokens, codeTokens, modules, lexicalDiagnostics };
}

/** Recovered IDE declarations remain navigable, but cannot be selected as runnable tops. */
export function isCompleteVerilogModuleDeclaration(module: VerilogModule): boolean {
  return module.hasEndmodule && module.hasCompleteHeader !== false;
}
