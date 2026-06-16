import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings, isVerilogLintRuleEnabled } from '../common/settings';
import { VerilogModule } from './model';

export function collectInstantiationStyleDiagnostics(settings: CoSettings, module: VerilogModule, diagnostics: Diagnostic[]): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-017')) {
    return;
  }
  for (const instance of module.instances) {
    if (instance.portConnections.some((connection) => !connection.name)) {
      diagnostics.push(makeDiagnostic(instance.selectionRange, `Testbench/VC-017: instance '${instance.instanceName}' should use named port mapping.`, DiagnosticSeverity.Information, 'vc-017-named-ports'));
    }
    if (instance.portConnections.length > 1 && instance.range.start.line === instance.range.end.line) {
      diagnostics.push(makeDiagnostic(instance.selectionRange, `VC-017: instance '${instance.instanceName}' should use multi-line formatting with one port connection per line.`, DiagnosticSeverity.Information, 'vc-017-multiline-instance'));
    }
    const lines = new Set(instance.portConnections.map((connection) => connection.range.start.line));
    if (lines.size < instance.portConnections.length) {
      diagnostics.push(makeDiagnostic(instance.selectionRange, `VC-017: instance '${instance.instanceName}' should place each port connection on a separate line.`, DiagnosticSeverity.Information, 'vc-017-one-port-per-line'));
    }
  }
}
