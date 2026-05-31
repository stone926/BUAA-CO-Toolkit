import {
  Position,
  Range,
  TextEdit,
  WorkspaceEdit
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt, rangesEqual } from '../common/lsp';
import { createMipsTokenRegex } from '../common/util';
import { CoSettings } from '../common/settings';
import {
  allMacroParams,
  allMacros,
  allSymbols,
  findMacroAtPosition,
  findMacroParamAtPosition,
  resolveSymbolAtPosition
} from './parser';
import { getCachedMipsParse } from './parseCache';
import { findMacroOverloadAtPosition } from './queries';
import { MipsServerState } from './state';
import { findCommentIndex, getStringRanges, isInsideAnyRange } from './syntax';
import { getMipsWordRange } from './text';

export function getMipsRenameEdits(document: TextDocument, position: Position, newName: string, settings: CoSettings, state: MipsServerState): WorkspaceEdit | undefined {
  const wordRange = getMipsWordRange(document, position);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const parsed = getCachedMipsParse(document, settings, state);

  // Check macro parameter rename
  const param = findMacroParamAtPosition(parsed, word, position) ?? allMacroParams(parsed).find((item) => rangesEqual(item.selectionRange, wordRange));
  if (param) {
    return buildRenameForToken(document, word, (range) => {
      const macro = findMacroAtPosition(parsed, range.start);
      return Boolean(macro && macro.name === param.macroName && macro.paramSymbols.get(word)?.selectionRange.start.line === param.selectionRange.start.line);
    }, param.selectionRange, newName);
  }

  // Check symbol rename (label, data, eqv)
  const symbol = resolveSymbolAtPosition(parsed, word, position) ?? allSymbols(parsed).find((item) => rangesEqual(item.selectionRange, wordRange));
  if (symbol) {
    return buildRenameForToken(document, word, (range) => {
      return resolveSymbolAtPosition(parsed, word, range.start)?.selectionRange.start.line === symbol.selectionRange.start.line;
    }, symbol.selectionRange, newName);
  }

  // Check macro name rename
  const macro = findMacroOverloadAtPosition(document, parsed, word, position) ?? allMacros(parsed).find((item) => rangesEqual(item.selectionRange, wordRange));
  if (macro) {
    const targetMacro = macro;
    return buildRenameForToken(document, word, (range) => {
      const overload = findMacroOverloadAtPosition(document, parsed, word, range.start);
      return overload?.selectionRange.start.line === targetMacro.selectionRange.start.line;
    }, targetMacro.selectionRange, newName);
  }

  return undefined;
}

export function getMipsRenamePrepare(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): Range | undefined {
  const wordRange = getMipsWordRange(document, position);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const parsed = getCachedMipsParse(document, settings, state);

  // Check if the word is a renameable entity
  if (findMacroParamAtPosition(parsed, word, position)) {
    return wordRange;
  }
  if (resolveSymbolAtPosition(parsed, word, position)) {
    return wordRange;
  }
  if (findMacroOverloadAtPosition(document, parsed, word, position)) {
    return wordRange;
  }
  return undefined;
}

function buildRenameForToken(
  document: TextDocument,
  name: string,
  matchesTarget: (range: Range) => boolean,
  declarationRange: Range | undefined,
  newName: string
): WorkspaceEdit {
  const edits: TextEdit[] = [];

  // Include declaration
  if (declarationRange) {
    edits.push(TextEdit.replace(declarationRange, newName));
  }

  // Find all references
  const tokenRegex = createMipsTokenRegex();
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const text = lineAt(document, lineNumber).text;
    const commentIndex = findCommentIndex(text);
    const code = commentIndex >= 0 ? text.slice(0, commentIndex) : text;
    const stringRanges = getStringRanges(code);
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(code))) {
      if (match[0] !== name || isInsideAnyRange(match.index, stringRanges)) {
        continue;
      }
      const previous = match.index > 0 ? code[match.index - 1] : '';
      if (previous === '$') {
        continue;
      }
      const range = Range.create(lineNumber, match.index, lineNumber, match.index + name.length);
      if (declarationRange && rangesEqual(range, declarationRange)) {
        continue;
      }
      if (matchesTarget(range)) {
        edits.push(TextEdit.replace(range, newName));
      }
    }
  }

  return {
    changes: {
      [document.uri]: edits
    }
  };
}
