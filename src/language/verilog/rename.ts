// @index(Verilog rename provider)
import { Position, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { getCachedVerilogParse } from './parseCache';
import { resolveVerilogSymbol, resolvedRange, sourceRangeAtPosition } from './resolveSymbol';
import { dedupeLocations, getVerilogReferences } from './navigation';

export function getVerilogRenameEdits(document: TextDocument, position: Position, newName: string, settings: CoSettings, index: VerilogWorkspaceIndex): WorkspaceEdit | undefined {
  if (!isIdentifier(newName)) {
    return undefined;
  }
  const references = getVerilogReferences(document, {
    textDocument: { uri: document.uri },
    position,
    context: { includeDeclaration: true }
  }, settings, index);
  if (!references.length) {
    return undefined;
  }
  const changes: Record<string, TextEdit[]> = {};
  for (const location of dedupeLocations(references)) {
    const edits = changes[location.uri] ?? [];
    edits.push(TextEdit.replace(location.range, newName));
    changes[location.uri] = edits;
  }
  return { changes };
}

export function getVerilogRenamePrepare(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): Range | undefined {
  const resolved = resolveVerilogSymbol(document, position, settings, index);
  if (!resolved || resolved.kind === 'include') {
    return undefined;
  }
  const parsed = getCachedVerilogParse(document, settings, false);
  const range = sourceRangeAtPosition(parsed.semantic, position) ?? resolved.sourceRange ?? resolvedRange(resolved);
  if (!range) {
    return undefined;
  }
  const text = document.getText(range);
  return isIdentifier(text) ? range : undefined;
}

function isIdentifier(value: string): boolean {
  if (!value || !isIdentifierStart(value[0])) {
    return false;
  }
  for (let index = 1; index < value.length; index++) {
    if (!isIdentifierPart(value[index])) {
      return false;
    }
  }
  return true;
}

function isIdentifierStart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_';
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || (char >= '0' && char <= '9');
}
