import { Commands } from '../../constants';
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
      `忽略伪指令「${mnemonic}」的警告，直到重新加载窗口`,
      Command.create(`忽略伪指令「${mnemonic}」的警告，直到重新加载窗口`, mipsIgnorePseudoMnemonicCommand, mnemonic),
      CodeActionKind.QuickFix
    ),
    CodeAction.create(
      '忽略此文件中的伪指令警告，直到重新加载窗口',
      Command.create('忽略此文件中的伪指令警告，直到重新加载窗口', mipsIgnorePseudoFileCommand, document.uri),
      CodeActionKind.QuickFix
    ),
    CodeAction.create(
      '在此工作区禁用伪指令警告',
      Command.create('在此工作区禁用伪指令警告', Commands.Mips.DisablePseudoWarnings, document.uri),
      CodeActionKind.QuickFix
    )
  ];
}
