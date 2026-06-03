import {
  Position,
  Range,
  TextEdit,
  WorkspaceEdit
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { getCachedMipsParse } from './parseCache';
import { mipsSemanticReferenceRanges, resolveMipsSemanticTarget } from './semantic';
import { MipsServerState } from './state';
import { getMipsWordRange } from './text';

export function getMipsRenameEdits(document: TextDocument, position: Position, newName: string, settings: CoSettings, state: MipsServerState): WorkspaceEdit | undefined {
  const wordRange = getMipsWordRange(document, position);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const parsed = getCachedMipsParse(document, settings, state);
  const target = resolveMipsSemanticTarget(parsed.semantic, word, wordRange, position);
  return target ? {
    changes: {
      [document.uri]: mipsSemanticReferenceRanges(parsed.semantic, target, true)
        .map((range) => TextEdit.replace(range, newName))
    }
  } : undefined;
}

export function getMipsRenamePrepare(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): Range | undefined {
  const wordRange = getMipsWordRange(document, position);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const parsed = getCachedMipsParse(document, settings, state);
  return resolveMipsSemanticTarget(parsed.semantic, word, wordRange, position) ? wordRange : undefined;
}
