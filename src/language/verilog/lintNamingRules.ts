import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings, isVerilogLintRuleEnabled } from '../common/settings';
import { VerilogModule } from './model';

export function collectNamingDiagnostics(settings: CoSettings, module: VerilogModule, diagnostics: Diagnostic[]): void {
  const styleCounts = new Map<string, number>();
  for (const decl of module.declarations.values()) {
    const style = identifierStyle(decl.name);
    if (!style) {
      if (isVerilogLintRuleEnabled(settings, 'vc-001')) {
        diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-001: signal '${decl.name}' should use snake_case, camelCase, or PascalCase.`, DiagnosticSeverity.Information, 'vc-001-name-style'));
      }
    } else {
      styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
    }
    if (isVerilogLintRuleEnabled(settings, 'vc-002') && looksLowActiveWithoutSuffix(decl.name)) {
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-002: low-active signal '${decl.name}' should use the _n suffix.`, DiagnosticSeverity.Information, 'vc-002-low-active-suffix'));
    }
    if (isVerilogLintRuleEnabled(settings, 'vc-003') && /mux/i.test(decl.name) && !/\d/.test(decl.name)) {
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-003: multiplexer signal '${decl.name}' should reflect its width or input count.`, DiagnosticSeverity.Information, 'vc-003-mux-name'));
    }
  }
  if (isVerilogLintRuleEnabled(settings, 'vc-001') && styleCounts.size > 1) {
    diagnostics.push(makeDiagnostic(module.selectionRange, 'VC-001: this module mixes signal naming styles; keep one of snake_case, camelCase, or PascalCase consistently.', DiagnosticSeverity.Information, 'vc-001-mixed-name-style'));
  }
}

function identifierStyle(name: string): 'snake' | 'camel' | 'pascal' | undefined {
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name)) {
    return 'snake';
  }
  if (/^[a-z][A-Za-z0-9]*$/.test(name)) {
    return 'camel';
  }
  if (/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    return 'pascal';
  }
  return undefined;
}

function looksLowActiveWithoutSuffix(name: string): boolean {
  const lower = name.toLowerCase();
  return !lower.endsWith('_n') && /(?:^|_)(?:nreset|nrst|rstn|resetn|wen|webar|enbar)(?:_|$)/.test(lower);
}
