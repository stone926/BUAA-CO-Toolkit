import {
  DocumentSymbol,
  Location,
  Position,
  ReferenceParams,
  SymbolKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { getCachedMipsParse } from './parseCache';
import { mipsSemanticReferenceRanges, resolveMipsSemanticTarget } from './semantic';
import { MipsServerState } from './state';
import { getMipsWordRange } from './text';

export function getMipsDefinition(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): Location | undefined {
  const parsed = getCachedMipsParse(document, settings, state);
  const wordRange = getMipsWordRange(document, position, parsed.ast);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const target = resolveMipsSemanticTarget(parsed.semantic, word, wordRange, position);
  return target ? Location.create(document.uri, target.declarationRange) : undefined;
}

export function getMipsReferences(document: TextDocument, params: ReferenceParams, settings: CoSettings, state: MipsServerState): Location[] {
  const position = params.position;
  const parsed = getCachedMipsParse(document, settings, state);
  const wordRange = getMipsWordRange(document, position, parsed.ast);
  if (!wordRange) {
    return [];
  }
  const word = document.getText(wordRange);
  const target = resolveMipsSemanticTarget(parsed.semantic, word, wordRange, position);
  return target
    ? mipsSemanticReferenceRanges(parsed.semantic, target, params.context.includeDeclaration)
      .map((range) => Location.create(document.uri, range))
    : [];
}

export function getMipsDocumentSymbols(document: TextDocument, settings: CoSettings, state: MipsServerState): DocumentSymbol[] {
  const parsed = getCachedMipsParse(document, settings, state);
  const symbols: DocumentSymbol[] = [];
  for (const declaration of parsed.semantic.declarations) {
    if (declaration.macro) {
      symbols.push(DocumentSymbol.create(
        declaration.macro.name,
        `macro(${declaration.macro.params.join(', ')})`,
        SymbolKind.Function,
        declaration.macro.range,
        declaration.macro.selectionRange
      ));
      continue;
    }
    if (declaration.symbol) {
      const kind = declaration.symbol.kind === 'data' || declaration.symbol.kind === 'eqv' ? SymbolKind.Variable : SymbolKind.Function;
      symbols.push(DocumentSymbol.create(
        declaration.symbol.name,
        declaration.symbol.kind,
        kind,
        declaration.symbol.range,
        declaration.symbol.selectionRange
      ));
    }
  }
  return symbols.sort((a, b) => a.range.start.line - b.range.start.line);
}
