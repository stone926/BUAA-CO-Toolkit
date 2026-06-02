import { Diagnostic, Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsPosition, rangesEqual } from '../common/lsp';
import { rangeKey } from '../common/util';
import { verilogTokenRange } from './cst';
import { VerilogToken } from './lexer';
import {
  systemTasks,
  VerilogDecl,
  VerilogInclude,
  VerilogInstance,
  VerilogMacro,
  VerilogMacroUse,
  VerilogModule,
  VerilogPortConnection,
  verilogKeywords
} from './model';
import { VerilogAstDocument } from './ast';

export type VerilogSemanticSymbolKind =
  | 'module'
  | 'port'
  | 'signal'
  | 'parameter'
  | 'instance'
  | 'macro'
  | 'include';

export type VerilogSemanticReferenceKind =
  | 'module'
  | 'signal'
  | 'instance'
  | 'portConnection'
  | 'macro'
  | 'include'
  | 'unresolved';

export interface VerilogSemanticScope {
  kind: 'file' | 'module';
  name?: string;
  range: Range;
  symbols: Map<string, VerilogSemanticSymbol[]>;
  module?: VerilogModule;
  parent?: VerilogSemanticScope;
}

export interface VerilogSemanticSymbol {
  name: string;
  kind: VerilogSemanticSymbolKind;
  uri: string;
  range: Range;
  selectionRange: Range;
  scope: VerilogSemanticScope;
  module?: VerilogModule;
  decl?: VerilogDecl;
  instance?: VerilogInstance;
  macro?: VerilogMacro;
  include?: VerilogInclude;
}

export interface VerilogSemanticReference {
  name: string;
  kind: VerilogSemanticReferenceKind;
  uri: string;
  range: Range;
  scope: VerilogSemanticScope;
  token?: VerilogToken;
  symbol?: VerilogSemanticSymbol;
  module?: VerilogModule;
  instance?: VerilogInstance;
  portConnection?: VerilogPortConnection;
  macroUse?: VerilogMacroUse;
  include?: VerilogInclude;
}

export interface VerilogSemanticResolution {
  symbol?: VerilogSemanticSymbol;
  reference?: VerilogSemanticReference;
}

export interface VerilogSemanticModel {
  documentUri: string;
  ast: VerilogAstDocument;
  fileScope: VerilogSemanticScope;
  moduleScopes: VerilogSemanticScope[];
  symbols: VerilogSemanticSymbol[];
  references: VerilogSemanticReference[];
  unresolvedReferences: VerilogSemanticReference[];
  diagnostics: Diagnostic[];
  declarationRangeKeys: Set<string>;
  referenceRangeKeys: Set<string>;
}

export interface VerilogSemanticSource {
  document: TextDocument;
  ast: VerilogAstDocument;
  modules: VerilogModule[];
  macros: VerilogMacro[];
  macroUses: VerilogMacroUse[];
  includes: VerilogInclude[];
  diagnostics: Diagnostic[];
}

export function buildVerilogSemanticModel(source: VerilogSemanticSource): VerilogSemanticModel {
  const fileScope: VerilogSemanticScope = {
    kind: 'file',
    range: source.ast.range,
    symbols: new Map()
  };
  const moduleScopes = source.modules.map((module): VerilogSemanticScope => ({
    kind: 'module',
    name: module.name,
    range: module.range,
    symbols: new Map(),
    module,
    parent: fileScope
  }));
  const symbols = collectSymbols(source, fileScope, moduleScopes);
  const declarationRangeKeys = new Set(symbols.map((symbol) => rangeKey(symbol.selectionRange)));
  const references = collectReferences(source.document, source, fileScope, moduleScopes, declarationRangeKeys);
  return {
    documentUri: source.document.uri,
    ast: source.ast,
    fileScope,
    moduleScopes,
    symbols,
    references,
    unresolvedReferences: references.filter((reference) => reference.kind === 'unresolved'),
    diagnostics: source.diagnostics,
    declarationRangeKeys,
    referenceRangeKeys: new Set(references.map((reference) => rangeKey(reference.range)))
  };
}

export function resolveVerilogSemanticAtPosition(model: VerilogSemanticModel, position: Position): VerilogSemanticResolution | undefined {
  const reference = smallestContainingReference(model.references, position);
  if (reference) {
    return {
      reference,
      symbol: reference.symbol
    };
  }
  const symbol = smallestContainingSymbol(model.symbols, position);
  return symbol ? { symbol } : undefined;
}

export function moduleScopeAtPosition(model: VerilogSemanticModel, position: Position): VerilogSemanticScope | undefined {
  return model.moduleScopes.find((scope) => containsPosition(scope.range, position));
}

function collectSymbols(
  source: VerilogSemanticSource,
  fileScope: VerilogSemanticScope,
  moduleScopes: VerilogSemanticScope[]
): VerilogSemanticSymbol[] {
  const symbols: VerilogSemanticSymbol[] = [];
  for (const macro of source.macros) {
    symbols.push(addSymbol(fileScope, {
      name: macro.name,
      kind: 'macro',
      uri: source.document.uri,
      range: macro.range,
      selectionRange: macro.selectionRange,
      scope: fileScope,
      macro
    }));
  }
  for (const include of source.includes) {
    symbols.push(addSymbol(fileScope, {
      name: include.path,
      kind: 'include',
      uri: source.document.uri,
      range: include.range,
      selectionRange: include.pathRange,
      scope: fileScope,
      include
    }));
  }
  for (const module of source.modules) {
    const scope = moduleScopes.find((candidate) => candidate.module === module) ?? fileScope;
    symbols.push(addSymbol(fileScope, {
      name: module.name,
      kind: 'module',
      uri: source.document.uri,
      range: module.range,
      selectionRange: module.selectionRange,
      scope: fileScope,
      module
    }));
    for (const decl of module.declarations.values()) {
      symbols.push(addSymbol(scope, {
        name: decl.name,
        kind: declSymbolKind(decl),
        uri: source.document.uri,
        range: decl.range,
        selectionRange: decl.selectionRange,
        scope,
        module,
        decl
      }));
    }
    for (const instance of module.instances) {
      symbols.push(addSymbol(scope, {
        name: instance.instanceName,
        kind: 'instance',
        uri: source.document.uri,
        range: instance.range,
        selectionRange: instance.selectionRange,
        scope,
        module,
        instance
      }));
    }
  }
  return symbols;
}

function collectReferences(
  document: TextDocument,
  source: VerilogSemanticSource,
  fileScope: VerilogSemanticScope,
  moduleScopes: VerilogSemanticScope[],
  declarationRangeKeys: Set<string>
): VerilogSemanticReference[] {
  const references: VerilogSemanticReference[] = [];
  const moduleSymbols = symbolsByKind(fileScope, 'module');
  const macroSymbols = symbolsByKind(fileScope, 'macro');

  for (const include of source.includes) {
    references.push({
      name: include.path,
      kind: 'include',
      uri: document.uri,
      range: include.pathRange,
      scope: fileScope,
      symbol: findSymbol(fileScope, include.path, 'include'),
      include
    });
  }
  for (const macroUse of source.macroUses) {
    references.push({
      name: macroUse.name,
      kind: 'macro',
      uri: document.uri,
      range: macroUse.selectionRange,
      scope: fileScope,
      symbol: macroSymbols.get(macroUse.name)?.[0],
      macroUse
    });
  }

  for (const module of source.modules) {
    const scope = moduleScopes.find((candidate) => candidate.module === module) ?? fileScope;
    for (const instance of module.instances) {
      references.push({
        name: instance.moduleName,
        kind: 'module',
        uri: document.uri,
        range: instance.moduleSelectionRange,
        scope,
        symbol: moduleSymbols.get(instance.moduleName)?.[0],
        module,
        instance
      });
      for (const connection of [...instance.portConnections, ...instance.parameterConnections]) {
        if (!connection.name || !connection.nameRange) {
          continue;
        }
        references.push({
          name: connection.name,
          kind: 'portConnection',
          uri: document.uri,
          range: connection.nameRange,
          scope,
          module,
          instance,
          portConnection: connection
        });
      }
    }

    const moduleStart = document.offsetAt(module.range.start);
    const moduleEnd = document.offsetAt(module.range.end);
    for (let index = 0; index < source.ast.cst.codeTokens.length; index++) {
      const token = source.ast.cst.codeTokens[index];
      if (token.start < moduleStart || token.end > moduleEnd || token.kind !== 'identifier') {
        continue;
      }
      const range = verilogTokenRange(document, token);
      if (declarationRangeKeys.has(rangeKey(range)) || isNonReferenceIdentifier(source.ast.cst.codeTokens, index)) {
        continue;
      }
      if (references.some((reference) => rangesEqual(reference.range, range))) {
        continue;
      }
      const symbol = resolveIdentifierInScope(scope, token.value);
      references.push({
        name: token.value,
        kind: symbol ? symbol.kind === 'instance' ? 'instance' : 'signal' : 'unresolved',
        uri: document.uri,
        range,
        scope,
        token,
        symbol,
        module
      });
    }
  }

  return references;
}

function addSymbol(scope: VerilogSemanticScope, symbol: VerilogSemanticSymbol): VerilogSemanticSymbol {
  const entries = scope.symbols.get(symbol.name) ?? [];
  entries.push(symbol);
  scope.symbols.set(symbol.name, entries);
  return symbol;
}

function resolveIdentifierInScope(scope: VerilogSemanticScope, name: string): VerilogSemanticSymbol | undefined {
  return scope.symbols.get(name)?.[0] ?? scope.parent?.symbols.get(name)?.[0];
}

function findSymbol(scope: VerilogSemanticScope, name: string, kind: VerilogSemanticSymbolKind): VerilogSemanticSymbol | undefined {
  return scope.symbols.get(name)?.find((symbol) => symbol.kind === kind);
}

function symbolsByKind(scope: VerilogSemanticScope, kind: VerilogSemanticSymbolKind): Map<string, VerilogSemanticSymbol[]> {
  const result = new Map<string, VerilogSemanticSymbol[]>();
  for (const [name, symbols] of scope.symbols) {
    const filtered = symbols.filter((symbol) => symbol.kind === kind);
    if (filtered.length) {
      result.set(name, filtered);
    }
  }
  return result;
}

function smallestContainingReference(references: VerilogSemanticReference[], position: Position): VerilogSemanticReference | undefined {
  return references
    .filter((reference) => containsPosition(reference.range, position))
    .sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0];
}

function smallestContainingSymbol(symbols: VerilogSemanticSymbol[], position: Position): VerilogSemanticSymbol | undefined {
  return symbols
    .filter((symbol) => containsPosition(symbol.selectionRange, position))
    .sort((left, right) => rangeSize(left.selectionRange) - rangeSize(right.selectionRange))[0];
}

function rangeSize(range: Range): number {
  if (range.start.line !== range.end.line) {
    return (range.end.line - range.start.line) * 10000 + range.end.character - range.start.character;
  }
  return range.end.character - range.start.character;
}

function declSymbolKind(decl: VerilogDecl): VerilogSemanticSymbolKind {
  if (decl.kind === 'parameter' || decl.kind === 'localparam') {
    return 'parameter';
  }
  if (decl.direction) {
    return 'port';
  }
  return 'signal';
}

function isNonReferenceIdentifier(tokens: VerilogToken[], index: number): boolean {
  const token = tokens[index];
  if (verilogKeywords.has(token.value) || systemTasks.has(token.value)) {
    return true;
  }
  const previous = previousSignificantToken(tokens, index);
  if (!previous) {
    return false;
  }
  return previous.value === '.'
    || previous.kind === 'directive'
    || previous.kind === 'systemIdentifier'
    || previous.value === "'"
    || previous.value === '`';
}

function previousSignificantToken(tokens: VerilogToken[], index: number): VerilogToken | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const token = tokens[cursor];
    if (token.kind !== 'comment') {
      return token;
    }
  }
  return undefined;
}
