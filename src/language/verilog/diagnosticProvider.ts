// @index verilog-diagnostic-provider — Verilog LSP诊断provider facade
import { Diagnostic } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { rangeKey } from '../common/util';
import { filterDisabledDiagnostics } from '../common/diagnosticActions';
import { getCachedVerilogParse } from './parseCache';
import { addVerilogWorkspaceDiagnostics } from './workspaceDiagnostics';
import { VerilogWorkspaceIndex } from './workspaceIndex';

export function getVerilogDiagnostics(document: TextDocument, settings: CoSettings, index?: VerilogWorkspaceIndex): Diagnostic[] {
  const parsed = getCachedVerilogParse(document, settings, true);
  const diagnostics = index ? addVerilogWorkspaceDiagnostics(document, settings, index, parsed.diagnostics, parsed) : parsed.diagnostics;
  const seen = new Set<string>();
  return filterDisabledDiagnostics(document.languageId, diagnostics, settings, document.uri).filter((diagnostic) => {
    const key = JSON.stringify([diagnostic.code, rangeKey(diagnostic.range), diagnostic.severity, diagnostic.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
