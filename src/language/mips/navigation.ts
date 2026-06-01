import {
  DocumentSymbol,
  Location,
  Position,
  Range,
  ReferenceParams,
  SymbolKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { rangesEqual } from '../common/lsp';
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
import {
  findMacroOverloadAtPosition
} from './queries';
import { MipsServerState } from './state';
import { mipsCstTokenRange } from './syntax';
import { getMipsWordRange } from './text';

export function getMipsDefinition(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): Location | undefined {
  const wordRange = getMipsWordRange(document, position);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const parsed = getCachedMipsParse(document, settings, state);
  const param = findMacroParamAtPosition(parsed, word, position);
  if (param) {
    return Location.create(document.uri, param.selectionRange);
  }
  const symbol = resolveSymbolAtPosition(parsed, word, position);
  if (symbol) {
    return Location.create(document.uri, symbol.selectionRange);
  }
  const macro = findMacroOverloadAtPosition(document, parsed, word, position);
  if (macro) {
    return Location.create(document.uri, macro.selectionRange);
  }
  return undefined;
}

export function getMipsReferences(document: TextDocument, params: ReferenceParams, settings: CoSettings, state: MipsServerState): Location[] {
  const position = params.position;
  const wordRange = getMipsWordRange(document, position);
  if (!wordRange) {
    return [];
  }
  const word = document.getText(wordRange);
  const parsed = getCachedMipsParse(document, settings, state);

  const param = findMacroParamAtPosition(parsed, word, position) ?? allMacroParams(parsed).find((item) => rangesEqual(item.selectionRange, wordRange));
  if (param) {
    return collectTokenReferences(document, parsed, word, (range) => {
      const macro = findMacroAtPosition(parsed, range.start);
      return Boolean(macro && macro.name === param.macroName && macro.paramSymbols.get(word)?.selectionRange.start.line === param.selectionRange.start.line);
    }, param.selectionRange, params.context.includeDeclaration);
  }

  const symbol = resolveSymbolAtPosition(parsed, word, position) ?? allSymbols(parsed).find((item) => rangesEqual(item.selectionRange, wordRange));
  if (symbol) {
    return collectTokenReferences(document, parsed, word, (range) => resolveSymbolAtPosition(parsed, word, range.start)?.selectionRange.start.line === symbol.selectionRange.start.line, symbol.selectionRange, params.context.includeDeclaration);
  }

  const macro = findMacroOverloadAtPosition(document, parsed, word, position) ?? allMacros(parsed).find((item) => rangesEqual(item.selectionRange, wordRange));
  if (macro) {
    const targetMacro = macro;
    return collectTokenReferences(document, parsed, word, (range) => {
      const overload = findMacroOverloadAtPosition(document, parsed, word, range.start);
      return overload?.selectionRange.start.line === targetMacro.selectionRange.start.line;
    }, targetMacro.selectionRange, params.context.includeDeclaration);
  }

  return [];
}

export function getMipsDocumentSymbols(document: TextDocument, settings: CoSettings, state: MipsServerState): DocumentSymbol[] {
  const parsed = getCachedMipsParse(document, settings, state);
  const symbols: DocumentSymbol[] = [];
  for (const symbol of allSymbols(parsed)) {
    const kind = symbol.kind === 'data' || symbol.kind === 'eqv' ? SymbolKind.Variable : SymbolKind.Function;
    symbols.push(DocumentSymbol.create(symbol.name, symbol.kind, kind, symbol.range, symbol.selectionRange));
  }
  for (const macro of allMacros(parsed)) {
    symbols.push(DocumentSymbol.create(macro.name, `macro(${macro.params.join(', ')})`, SymbolKind.Function, macro.range, macro.selectionRange));
  }
  return symbols.sort((a, b) => a.range.start.line - b.range.start.line);
}

function collectTokenReferences(
  document: TextDocument,
  parsed: ReturnType<typeof getCachedMipsParse>,
  name: string,
  matchesTarget: (range: Range) => boolean,
  declarationRange?: Range,
  includeDeclaration = false
): Location[] {
  const locations: Location[] = [];
  if (declarationRange && includeDeclaration) {
    locations.push(Location.create(document.uri, declarationRange));
  }

  for (const line of parsed.lines) {
    for (const token of line.tokens) {
      if (token.value !== name || !isReferenceTokenKind(token.kind)) {
        continue;
      }
      const range = mipsCstTokenRange(token);
      if (declarationRange && rangesEqual(range, declarationRange)) {
        continue;
      }
      if (matchesTarget(range)) {
        locations.push(Location.create(document.uri, range));
      }
    }
  }

  return locations;
}

function isReferenceTokenKind(kind: string): boolean {
  return kind === 'identifier' || kind === 'macroParameter' || kind === 'register';
}
