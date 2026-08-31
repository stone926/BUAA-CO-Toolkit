import {
  CodeAction,
  CodeActionKind,
  Command,
  Diagnostic
} from 'vscode-languageserver/node';
import {
  CoSettings,
  diagnosticCodeToString,
  diagnosticFileCodeKey,
  disableDiagnosticCodeCommand,
  isDiagnosticCodeDisabledForFile
} from './settings';

export function filterDisabledDiagnostics(languageId: string, diagnostics: Diagnostic[], settings: CoSettings, documentUri?: string): Diagnostic[] {
  if (!settings.diagnostics.disabledCodes.length && !settings.diagnostics.disabledFileCodes.length) {
    return diagnostics;
  }
  return diagnostics.filter((diagnostic) => !isDiagnosticCodeDisabledForFile(settings, languageId, diagnostic.code, documentUri));
}

export function getDiagnosticSuppressActions(languageId: string, diagnostics: Diagnostic[], settings: CoSettings, documentUri: string): CodeAction[] {
  const actions: CodeAction[] = [];
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const code = diagnosticCodeToString(diagnostic.code);
    if (!code || seen.has(code) || isDiagnosticCodeDisabledForFile(settings, languageId, code, documentUri)) {
      continue;
    }
    seen.add(code);
    const fileKey = diagnosticFileCodeKey(languageId, code, documentUri);
    if (!settings.diagnostics.disabledFileCodes.includes(fileKey)) {
      actions.push({
        title: `Suppress ${code} diagnostics in this file for this workspace`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        command: Command.create(
          `Suppress ${code} for file`,
          disableDiagnosticCodeCommand,
          languageId,
          code,
          'file',
          documentUri
        )
      });
    }
    actions.push({
      title: `Suppress ${code} diagnostics in this workspace`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      command: Command.create(
        `Suppress ${code}`,
        disableDiagnosticCodeCommand,
        languageId,
        code,
        'workspace',
        documentUri
      )
    });
  }
  return actions;
}
