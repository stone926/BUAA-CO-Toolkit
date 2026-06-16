import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings, isVerilogLintRuleEnabled } from '../common/settings';
import { VerilogModule } from './model';

export function collectExplicitWidthDiagnostics(settings: CoSettings, module: VerilogModule, diagnostics: Diagnostic[]): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-021')) {
    return;
  }
  for (const decl of module.declarations.values()) {
    if (decl.kind === 'parameter' || decl.kind === 'localparam' || decl.kind === 'integer' || decl.kind === 'genvar') {
      continue;
    }
    if (!decl.width && !['clk', 'clock', 'reset', 'rst'].includes(decl.name.toLowerCase())) {
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-021: signal '${decl.name}' should declare an explicit width, even if it is 1 bit.`, DiagnosticSeverity.Information, 'vc-021-explicit-width'));
    }
  }
}

export function collectInoutDiagnostics(settings: CoSettings, module: VerilogModule, diagnostics: Diagnostic[]): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-015')) {
    return;
  }
  const topName = settings.project.topModule.trim() || 'mips';
  if (module.name === topName) {
    return;
  }
  for (const port of module.ports) {
    if (port.direction === 'inout') {
      diagnostics.push(makeDiagnostic(port.selectionRange, `VC-015: internal module '${module.name}' should not use inout port '${port.name}'.`, DiagnosticSeverity.Warning, 'vc-015-inout'));
    }
  }
}
