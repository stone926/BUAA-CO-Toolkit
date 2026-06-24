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
  const parsed = getCachedMipsParse(document, settings, state);
  const wordRange = getMipsWordRange(document, position, parsed.ast);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const target = resolveMipsSemanticTarget(parsed.semantic, word, wordRange, position);
  return target ? {
    changes: {
      [document.uri]: mipsSemanticReferenceRanges(parsed.semantic, target, true)
        .map((range) => TextEdit.replace(range, newName))
    }
  } : undefined;
}

export function getMipsRenamePrepare(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): Range | undefined {
  const parsed = getCachedMipsParse(document, settings, state);
  const wordRange = getMipsWordRange(document, position, parsed.ast);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  return resolveMipsSemanticTarget(parsed.semantic, word, wordRange, position) ? wordRange : undefined;
}
