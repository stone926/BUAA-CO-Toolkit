import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { collectVerilogDiagnostics } from './diagnostics';
import { buildVerilogAst } from './ast';
import { parseModules } from './moduleParser';
import { parseDirectives, parseIncludes, parseMacros, parseMacroUses } from './preprocessor';
import { VerilogParseResult } from './model';
import { parseVerilogCst } from './cst';
import { buildVerilogSemanticModel } from './semanticModel';

export function parseVerilog(document: TextDocument, settings: CoSettings, includeDiagnostics: boolean): VerilogParseResult {
  const text = document.getText();
  const cst = parseVerilogCst(document, text);
  const modules = parseModules(document, text, cst);
  const macros = parseMacros(document, text, cst);
  const macroUses = parseMacroUses(document, text, macros, cst);
  const includes = parseIncludes(document, text, cst);
  const directives = parseDirectives(document, text, cst);
  const ast = buildVerilogAst(document, cst, modules, macros, macroUses, includes, directives);
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
    cst,
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
  const diagnostics = collectVerilogDiagnostics(document, settings, text, parsed.modules, parsed.includes, parsed.cst, parsed.ast, parsed.semantic);
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
  parseModules
} from './moduleParser';

export {
  parseDirectives,
  parseIncludes,
  parseMacros,
  parseMacroUses
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
