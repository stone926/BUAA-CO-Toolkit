import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { collectVerilogDiagnostics } from './diagnostics';
import { parseModules } from './moduleParser';
import { parseIncludes, parseMacros, parseMacroUses } from './preprocessor';
import { VerilogParseResult } from './model';
import { parseVerilogCst } from './cst';

export function parseVerilog(document: TextDocument, settings: CoSettings, includeDiagnostics: boolean): VerilogParseResult {
  const text = document.getText();
  const cst = parseVerilogCst(document, text);
  const modules = parseModules(document, text, cst);
  const macros = parseMacros(document, text, cst);
  const macroUses = parseMacroUses(document, text, macros, cst);
  const includes = parseIncludes(document, text, cst);
  const diagnostics = includeDiagnostics ? collectVerilogDiagnostics(document, settings, text, modules, includes, cst) : [];
  return {
    cst,
    modules,
    macros,
    macroUses,
    includes,
    diagnostics
  };
}

export {
  parseModules
} from './moduleParser';

export {
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
  shouldReportWidthMismatch,
  widthOfDecl,
  widthOfExpression
} from './expressions';

export type {
  WidthInfo
} from './expressions';

export {
  normalizeWidth,
  splitTopLevelCommas,
  splitTopLevelCommaSpans,
  stripCommentsAndStrings
} from './textUtils';
