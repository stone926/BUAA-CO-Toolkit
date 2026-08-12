import { SemanticTokens } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentResultCache } from '../common/documentResultCache';
import { SemanticTokenCollector } from '../common/semanticTokens';
import { CoSettings, defaultCoSettings } from '../common/settings';
import { mipsSemanticTokenTypes } from '../mips/resources';
import { getCachedVerilogParse } from './parseCache';
import {
  VerilogSemanticTokenType,
  verilogSemanticTokenTypes
} from './model';
import { VerilogSemanticReference, VerilogSemanticSymbol } from './semanticModel';

const semanticTokenCache = new DocumentResultCache<SemanticTokens>();

/**
 * Verilog semantic highlighting deliberately contains only identifiers whose
 * role cannot be known lexically. Comments, strings, numbers, directives,
 * keywords, system tasks, operators and punctuation are owned by TextMate.
 */
export function getVerilogSemanticTokens(document: TextDocument, _settings: CoSettings): SemanticTokens {
  return semanticTokenCache.getOrCreate(
    document,
    'verilog-semantic-v2',
    () => buildVerilogSemanticTokens(document)
  );
}

export function clearVerilogSemanticTokenCache(uri?: string): void {
  semanticTokenCache.clear(uri);
}

function buildVerilogSemanticTokens(document: TextDocument): SemanticTokens {
  const parsed = getCachedVerilogParse(document, defaultCoSettings, false);
  const collector = new SemanticTokenCollector(
    verilogSemanticTokenTypes,
    mipsSemanticTokenTypes.length
  );

  for (const symbol of parsed.semantic.symbols) {
    const tokenType = semanticSymbolTokenType(symbol);
    if (tokenType) {
      collector.add(symbol.selectionRange, tokenType, ['declaration']);
    }
  }
  for (const reference of parsed.semantic.references) {
    const tokenType = semanticReferenceTokenType(reference);
    if (tokenType) {
      collector.add(reference.macroUse?.range ?? reference.range, tokenType);
    }
  }
  return collector.build();
}

function semanticSymbolTokenType(symbol: VerilogSemanticSymbol): VerilogSemanticTokenType | undefined {
  switch (symbol.kind) {
    case 'module':
      return 'verilogModule';
    case 'port':
      return 'verilogPort';
    case 'signal':
      return 'verilogSignal';
    case 'parameter':
      return 'verilogParameter';
    case 'instance':
      return 'verilogInstance';
    case 'macro':
      return 'verilogMacro';
    case 'task':
      return symbol.decl?.kind === 'function' ? 'verilogFunction' : 'verilogTask';
    case 'include':
      return undefined;
  }
}

function semanticReferenceTokenType(reference: VerilogSemanticReference): VerilogSemanticTokenType | undefined {
  if (reference.kind === 'portConnection') {
    return 'verilogPort';
  }
  if (reference.kind === 'parameterConnection') {
    return 'verilogParameter';
  }
  if (reference.kind === 'macro') {
    return 'verilogMacro';
  }
  if (reference.kind === 'module') {
    return 'verilogModule';
  }
  if (reference.kind === 'unresolved') {
    // Verilog implicitly declares an unresolved bare identifier as a one-bit
    // net unless `default_nettype none is active. Diagnostics still report
    // misspellings; the lexical role remains a signal in either case.
    return 'verilogSignal';
  }
  return reference.symbol ? semanticSymbolTokenType(reference.symbol) : undefined;
}
