import {
  CodeAction,
  CodeActionKind,
  Command,
  Diagnostic
} from 'vscode-languageserver/node';
import {
  CoSettings,
  diagnosticCodeToString,
  disableDiagnosticCodeCommand,
  isDiagnosticCodeDisabled
} from './settings';

export function filterDisabledDiagnostics(languageId: string, diagnostics: Diagnostic[], settings: CoSettings): Diagnostic[] {
  if (!settings.diagnostics.disabledCodes.length) {
    return diagnostics;
  }
  return diagnostics.filter((diagnostic) => !isDiagnosticCodeDisabled(settings, languageId, diagnostic.code));
}

export function getDiagnosticSuppressActions(languageId: string, diagnostics: Diagnostic[], settings: CoSettings): CodeAction[] {
  const actions: CodeAction[] = [];
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const code = diagnosticCodeToString(diagnostic.code);
    if (!code || seen.has(code) || isDiagnosticCodeDisabled(settings, languageId, code)) {
      continue;
    }
    seen.add(code);
    actions.push({
      title: `Suppress ${code} diagnostics in this workspace`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      command: Command.create(`Suppress ${code}`, disableDiagnosticCodeCommand, languageId, code)
    });
  }
  return actions;
}
