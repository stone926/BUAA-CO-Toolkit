import { Diagnostic, FoldingRange, SignatureHelp, WorkspaceEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { getMipsCodeActions } from './codeActions';
import {
  mipsIgnorePseudoFileCommand,
  mipsIgnorePseudoMnemonicCommand
} from './commands';
import { getMipsCompletions } from './completions';
import { getMipsFoldingRanges } from './folding';
import { getMipsFormattingEdits } from './formatting';
import { getMipsHover } from './hover';
import { getMipsInlayHints } from './inlayHints';
import {
  getMipsDefinition,
  getMipsDocumentSymbols,
  getMipsReferences
} from './navigation';
import { clearCachedMipsParse, getCachedMipsParse } from './parseCache';
import { getMipsRenameEdits, getMipsRenamePrepare } from './rename';
import { getMipsSemanticTokens } from './semanticTokens';
import { getMipsSignatureHelp } from './signatureHelp';
import { MipsServerState } from './state';

export {
  getMipsCodeActions,
  getMipsCompletions,
  getMipsDefinition,
  getMipsDocumentSymbols,
  getMipsFoldingRanges,
  getMipsFormattingEdits,
  getMipsHover,
  getMipsInlayHints,
  getMipsReferences,
  getMipsRenameEdits,
  getMipsRenamePrepare,
  getMipsSemanticTokens,
  getMipsSignatureHelp,
  mipsIgnorePseudoFileCommand,
  mipsIgnorePseudoMnemonicCommand
};

export type { MipsServerState } from './state';

export const clearMipsParseCache = clearCachedMipsParse;

export function getMipsDiagnostics(document: TextDocument, settings: CoSettings, state: MipsServerState): Diagnostic[] {
  return getCachedMipsParse(document, settings, state).diagnostics;
}
