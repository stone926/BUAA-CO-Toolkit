// @index parser — lexer→statementParser→astParser主入口
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { collectVerilogDiagnostics } from './diagnostics';
import { parseVerilogCore } from './parseCore';
import { VerilogParseResult } from './model';

export function parseVerilog(document: TextDocument, settings: CoSettings, includeDiagnostics: boolean): VerilogParseResult {
  const parsed = parseVerilogCore(document);
  return includeDiagnostics ? addVerilogDiagnostics(document, settings, parsed) : parsed;
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
