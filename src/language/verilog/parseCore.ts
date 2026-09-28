// @index verilog-parse-core — diagnostic-free parser shared with extension-host features
import { TextDocument } from 'vscode-languageserver-textdocument';
import { buildVerilogAst } from './ast';
import { parseVerilogModuleSource } from './moduleDeclarations';
import { parseDirectivesFromTokens, parseIncludesFromTokens, parseMacrosFromTokens, parseMacroUsesFromTokens } from './preprocessor';
import { VerilogParseResult } from './model';
import { collectVerilogStatementSources } from './statementParser';
import { buildVerilogSemanticModel } from './semanticModel';

export function parseVerilogCore(document: TextDocument): VerilogParseResult {
  const { text, lexed, tokens, codeTokens, modules } = parseVerilogModuleSource(document);
  const macros = parseMacrosFromTokens(document, tokens);
  const macroUses = parseMacroUsesFromTokens(document, macros, tokens);
  const includes = parseIncludesFromTokens(document, tokens);
  const directives = parseDirectivesFromTokens(document, tokens);
  const ast = buildVerilogAst(document, {
    tokens: codeTokens,
    allTokens: lexed.tokens,
    lexicalDiagnostics: lexed.diagnostics,
    statements: collectVerilogStatementSources(document, codeTokens)
  }, modules, macros, macroUses, includes, directives);
  const semantic = buildVerilogSemanticModel({
    document, ast, modules, macros, macroUses, includes, diagnostics: []
  });
  return { ast, semantic, modules, macros, macroUses, includes, diagnostics: [] };
}
