import {
  DocumentSymbol,
  SymbolKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import {
  declDetail
} from './parser';
import { getCachedVerilogParse } from './parseCache';
import { VerilogSemanticSymbol } from './semanticModel';

export function getVerilogDocumentSymbols(document: TextDocument, settings: CoSettings): DocumentSymbol[] {
  const parsed = getCachedVerilogParse(document, settings, false);
  const symbols: DocumentSymbol[] = parsed.semantic.symbols
    .filter((symbol) => symbol.kind === 'macro')
    .map((symbol) => DocumentSymbol.create(symbol.name, 'macro', SymbolKind.Constant, symbol.range, symbol.selectionRange));
  for (const moduleAst of parsed.ast.modules) {
    const moduleSymbol = parsed.semantic.symbols.find((symbol) => symbol.kind === 'module' && symbol.module === moduleAst.module);
    if (!moduleSymbol) {
      continue;
    }
    const symbol = DocumentSymbol.create(moduleSymbol.name, 'module', SymbolKind.Module, moduleSymbol.range, moduleSymbol.selectionRange, []);
    const children = parsed.semantic.symbols
      .filter((child) => child.scope.module === moduleAst.module)
      .sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character)
      .map((child) => symbolFromSemantic(child))
      .filter((child): child is DocumentSymbol => Boolean(child));
    symbol.children?.push(...children);
    symbols.push(symbol);
  }
  return symbols.sort((a, b) => a.range.start.line - b.range.start.line);
}

function symbolFromSemantic(symbol: VerilogSemanticSymbol): DocumentSymbol | undefined {
  if (symbol.decl) {
    return DocumentSymbol.create(symbol.name, declDetail(symbol.decl), symbolKind(symbol), symbol.range, symbol.selectionRange);
  }
  if (symbol.instance) {
    return DocumentSymbol.create(symbol.name, symbol.instance.moduleName, SymbolKind.Object, symbol.range, symbol.selectionRange);
  }
  return undefined;
}

function symbolKind(symbol: VerilogSemanticSymbol): SymbolKind {
  switch (symbol.kind) {
    case 'parameter':
      return SymbolKind.Constant;
    case 'port':
      return SymbolKind.Field;
    case 'instance':
      return SymbolKind.Object;
    default:
      return SymbolKind.Variable;
  }
}
