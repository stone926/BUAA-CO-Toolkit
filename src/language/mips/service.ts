import { Diagnostic } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { getMipsCodeActions } from './codeActions';
import {
  mipsIgnorePseudoFileCommand,
  mipsIgnorePseudoMnemonicCommand
} from './commands';
import { getMipsCompletions } from './completions';
import { getMipsFormattingEdits } from './formatting';
import { getMipsHover } from './hover';
import { getMipsInlayHints } from './inlayHints';
import {
  getMipsDefinition,
  getMipsDocumentSymbols,
  getMipsReferences
} from './navigation';
import { clearCachedMipsParse, getCachedMipsParse } from './parseCache';
import { getMipsSemanticTokens } from './semanticTokens';
import { MipsServerState } from './state';

export {
  getMipsCodeActions,
  getMipsCompletions,
  getMipsDefinition,
  getMipsDocumentSymbols,
  getMipsFormattingEdits,
  getMipsHover,
  getMipsInlayHints,
  getMipsReferences,
  getMipsSemanticTokens,
  mipsIgnorePseudoFileCommand,
  mipsIgnorePseudoMnemonicCommand
};

export type { MipsServerState } from './state';

export const clearMipsParseCache = clearCachedMipsParse;

export function getMipsDiagnostics(document: TextDocument, settings: CoSettings, state: MipsServerState): Diagnostic[] {
  return getCachedMipsParse(document, settings, state).diagnostics;
}
