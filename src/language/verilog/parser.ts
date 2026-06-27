// @index parser — lexer→statementParser→astParser主入口
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { collectVerilogDiagnostics } from './diagnostics';
import { buildVerilogAst } from './ast';
import { parseModulesFromTokens } from './moduleParser';
import { parseDirectivesFromTokens, parseIncludesFromTokens, parseMacrosFromTokens, parseMacroUsesFromTokens } from './preprocessor';
import { VerilogParseResult } from './model';
import { lexVerilogWithTrivia } from './lexer';
import { collectVerilogStatementSources } from './statementParser';
import { buildVerilogSemanticModel } from './semanticModel';

export function parseVerilog(document: TextDocument, settings: CoSettings, includeDiagnostics: boolean): VerilogParseResult {
  const text = document.getText();
  const lexed = lexVerilogWithTrivia(text);
  const tokens = lexed.tokens.filter((token) => token.kind !== 'comment');
  const modules = parseModulesFromTokens(document, text, tokens);
  const macros = parseMacrosFromTokens(document, tokens);
  const macroUses = parseMacroUsesFromTokens(document, macros, tokens);
  const includes = parseIncludesFromTokens(document, tokens);
  const directives = parseDirectivesFromTokens(document, tokens);
  const ast = buildVerilogAst(
    document,
    {
      tokens,
      allTokens: lexed.tokens,
      lexicalDiagnostics: lexed.diagnostics,
      statements: collectVerilogStatementSources(document, tokens)
    },
    modules,
    macros,
    macroUses,
    includes,
    directives
  );
  const semantic = buildVerilogSemanticModel({
    document,
    ast,
    modules,
    macros,
    macroUses,
    includes,
    diagnostics: []
  });
  const parsed: VerilogParseResult = {
    ast,
    semantic,
    modules,
    macros,
    macroUses,
    includes,
    diagnostics: []
  };
  return includeDiagnostics ? addVerilogDiagnostics(document, settings, parsed, text) : parsed;
}

export function addVerilogDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  parsed: VerilogParseResult,
  text = document.getText()
): VerilogParseResult {
  const diagnostics = collectVerilogDiagnostics(document, settings, text, parsed.modules, parsed.includes, parsed.ast, parsed.semantic);
  return {
    ...parsed,
    diagnostics,
    semantic: {
      ...parsed.semantic,
      diagnostics
    }
  };
}

export {
  parseModules,
  parseModulesFromTokens
} from './moduleParser';

export {
  parseDirectives,
  parseDirectivesFromTokens,
  parseIncludes,
  parseIncludesFromTokens,
  parseMacros,
  parseMacrosFromTokens,
  parseMacroUses,
  parseMacroUsesFromTokens
} from './preprocessor';

export {
  buildTestbench,
  declDetail,
  moduleAtPosition
} from './moduleUtils';

export {
  evalExpressionAstConstant,
  evalExpressionConstant,
  shouldReportWidthMismatch,
  widthOfDecl,
  widthOfExpression,
  widthOfExpressionAst
} from './expressions';

export type {
  WidthInfo
} from './expressions';

export {
  parseVerilogExpression,
  parseVerilogExpressionTokens,
  verilogExpressionHasError
} from './exprAst';

export type {
  ParsedVerilogNumberLiteral,
  VerilogErrorExpressionAst,
  VerilogExpressionAst,
  VerilogMissingTokenAst
} from './exprAst';

export type {
  VerilogAssignmentExpressionAst
} from './ast';

export {
  childrenOfVerilogExpression,
  findSmallestVerilogExpressionAtOffset,
  walkVerilogExpression
} from './exprAstUtils';

export {
  normalizeWidth,
  splitTopLevelCommas,
  splitTopLevelCommaSpans,
  stripCommentsAndStrings
} from './textUtils';
