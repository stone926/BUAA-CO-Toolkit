import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { collectVerilogDiagnostics } from './diagnostics';
import { parseModules } from './moduleParser';
import { parseIncludes, parseMacros, parseMacroUses } from './preprocessor';
import { VerilogParseResult } from './model';

export function parseVerilog(document: TextDocument, settings: CoSettings, includeDiagnostics: boolean): VerilogParseResult {
  const text = document.getText();
  const modules = parseModules(document, text);
  const macros = parseMacros(document, text);
  const macroUses = parseMacroUses(document, text, macros);
  const includes = parseIncludes(document, text);
  const diagnostics = includeDiagnostics ? collectVerilogDiagnostics(document, settings, text, modules, includes) : [];
  return {
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
