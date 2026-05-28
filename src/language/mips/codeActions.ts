import {
  CodeAction,
  CodeActionKind,
  Command,
  Diagnostic
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  mipsIgnorePseudoFileCommand,
  mipsIgnorePseudoMnemonicCommand
} from './commands';

export function getMipsCodeActions(document: TextDocument, diagnostics: Diagnostic[]): CodeAction[] {
  const pseudoDiagnostic = diagnostics.find((diagnostic) => typeof diagnostic.code === 'string' && diagnostic.code.startsWith('pseudo-instruction:'));
  if (!pseudoDiagnostic || typeof pseudoDiagnostic.code !== 'string') {
    return [];
  }

  const mnemonic = pseudoDiagnostic.code.slice('pseudo-instruction:'.length);
  return [
    CodeAction.create(
      `Ignore '${mnemonic}' pseudo-instruction warnings until reload`,
      Command.create(`Ignore ${mnemonic}`, mipsIgnorePseudoMnemonicCommand, mnemonic),
      CodeActionKind.QuickFix
    ),
    CodeAction.create(
      'Ignore pseudo-instruction warnings in this file until reload',
      Command.create('Ignore pseudo warnings for file', mipsIgnorePseudoFileCommand, document.uri),
      CodeActionKind.QuickFix
    ),
    CodeAction.create(
      'Disable pseudo-instruction warnings in this workspace',
      Command.create('Disable pseudo warnings', 'co.mips.disablePseudoWarnings'),
      CodeActionKind.QuickFix
    )
  ];
}
