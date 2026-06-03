import { Diagnostic, Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsPosition } from '../common/lsp';
import { rangeKey } from '../common/util';
import {
  directives,
  instructions,
  isFloatingPointRegister,
  isRegister
} from './resources';
import {
  MipsAstDocument,
  MipsStatementAst
} from './ast';
import type {
  MipsLine,
  MipsMacro,
  MipsSymbol
} from './model';
import {
  MipsCstToken,
  isSymbolLike,
  mipsCstTokenRange,
  parseMacroArguments
} from './syntax';

export type MipsSemanticScopeKind = 'global' | 'macro';
export type MipsSemanticReferenceKind =
  | 'label'
  | 'data'
  | 'eqv'
  | 'macro'
  | 'macroParam'
  | 'register'
  | 'unresolved';

export interface MipsSemanticScope {
  kind: MipsSemanticScopeKind;
  name?: string;
  range: Range;
  parent?: MipsSemanticScope;
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
  macroParams: Map<string, MipsSymbol>;
  macro?: MipsMacro;
}

export interface MipsSemanticDeclaration {
  name: string;
  kind: MipsSymbol['kind'] | 'macro';
  range: Range;
  selectionRange: Range;
  symbol?: MipsSymbol;
  macro?: MipsMacro;
  scope: MipsSemanticScope;
}

export interface MipsSemanticReference {
  name: string;
  kind: MipsSemanticReferenceKind;
  range: Range;
  token: MipsCstToken;
  statement: MipsStatementAst;
  scope: MipsSemanticScope;
  symbol?: MipsSymbol;
  macro?: MipsMacro;
}

export interface MipsSemanticModel {
  documentUri: string;
  ast: MipsAstDocument;
  globalScope: MipsSemanticScope;
  macroScopes: MipsSemanticScope[];
  declarations: MipsSemanticDeclaration[];
  references: MipsSemanticReference[];
  unresolvedReferences: MipsSemanticReference[];
  diagnostics: Diagnostic[];
  instructions: MipsLine[];
  macros: MipsMacro[];
  symbols: MipsSymbol[];
  labelSymbols: MipsSymbol[];
  dataSymbols: MipsSymbol[];
  eqvSymbols: MipsSymbol[];
  macroParams: MipsSymbol[];
  declarationRangeKeys: Set<string>;
}

export type MipsSemanticTarget =
  | {
    kind: 'symbol';
    name: string;
    declarationRange: Range;
    symbol: MipsSymbol;
  }
  | {
    kind: 'macro';
    name: string;
    declarationRange: Range;
    macro: MipsMacro;
  };

export interface MipsSemanticSource {
  document: TextDocument;
  ast: MipsAstDocument;
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
  macros: Map<string, MipsMacro[]>;
  instructions: MipsLine[];
  diagnostics: Diagnostic[];
}

export function buildMipsSemanticModel(source: MipsSemanticSource): MipsSemanticModel {
  const macros = [...source.macros.values()].flat();
  const globalScope: MipsSemanticScope = {
    kind: 'global',
    range: source.ast.range,
    labels: source.labels,
    dataSymbols: source.dataSymbols,
    eqvSymbols: source.eqvSymbols,
    macroParams: new Map()
  };
  const macroScopes = macros.map((macro): MipsSemanticScope => ({
    kind: 'macro',
    name: macro.name,
    range: macro.range,
    parent: globalScope,
    labels: macro.labels,
    dataSymbols: macro.dataSymbols,
    eqvSymbols: macro.eqvSymbols,
    macroParams: macro.paramSymbols,
    macro
  }));

  const declarations = collectDeclarations(source, globalScope, macroScopes);
  const declarationRangeKeys = new Set(declarations.map((decl) => rangeKey(decl.selectionRange)));
  const references = collectReferences(source.ast, globalScope, macroScopes, source.macros, declarationRangeKeys);
  const symbols = declarations
    .filter((decl) => decl.symbol)
    .map((decl) => decl.symbol as MipsSymbol);

  return {
    documentUri: source.document.uri,
    ast: source.ast,
    globalScope,
    macroScopes,
    declarations,
    references,
    unresolvedReferences: references.filter((reference) => reference.kind === 'unresolved'),
    diagnostics: source.diagnostics,
    instructions: source.instructions,
    macros,
    symbols,
    labelSymbols: symbols.filter((symbol) => symbol.kind === 'label'),
    dataSymbols: symbols.filter((symbol) => symbol.kind === 'data'),
    eqvSymbols: symbols.filter((symbol) => symbol.kind === 'eqv'),
    macroParams: symbols.filter((symbol) => symbol.kind === 'macroParam'),
    declarationRangeKeys
  };
}

export function findMipsSemanticMacroAtPosition(model: MipsSemanticModel, position: Position): MipsMacro | undefined {
  return findMipsSemanticMacroScopeAtPosition(model, position)?.macro;
}

export function findMipsSemanticMacroScopeAtPosition(model: MipsSemanticModel, position: Position): MipsSemanticScope | undefined {
  return model.macroScopes.find((scope) => containsPosition(scope.range, position));
}

export function resolveMipsSemanticMacroParamAtPosition(
  model: MipsSemanticModel,
  name: string,
  position: Position
): MipsSymbol | undefined {
  return findMipsSemanticMacroScopeAtPosition(model, position)?.macroParams.get(name);
}

export function resolveMipsSemanticSymbolAtPosition(
  model: MipsSemanticModel,
  name: string,
  position: Position,
  kinds?: Array<MipsSymbol['kind']>
): MipsSymbol | undefined {
  const macroScope = findMipsSemanticMacroScopeAtPosition(model, position);
  const candidates = [
    macroScope?.labels.get(name),
    macroScope?.dataSymbols.get(name),
    macroScope?.eqvSymbols.get(name),
    model.globalScope.labels.get(name),
    model.globalScope.dataSymbols.get(name),
    model.globalScope.eqvSymbols.get(name)
  ].filter((item): item is MipsSymbol => Boolean(item));
  return kinds?.length
    ? candidates.find((symbol) => kinds.includes(symbol.kind))
    : candidates[0];
}

export function mipsSemanticSymbolsVisibleAtPosition(model: MipsSemanticModel, position: Position): MipsSymbol[] {
  const macroScope = findMipsSemanticMacroScopeAtPosition(model, position);
  return [
    ...(macroScope ? [
      ...macroScope.labels.values(),
      ...macroScope.dataSymbols.values(),
      ...macroScope.eqvSymbols.values()
    ] : []),
    ...model.globalScope.labels.values(),
    ...model.globalScope.dataSymbols.values(),
    ...model.globalScope.eqvSymbols.values()
  ];
}

export function resolveMipsSemanticTarget(
  model: MipsSemanticModel,
  name: string,
  range: Range,
  position: Position
): MipsSemanticTarget | undefined {
  const declaration = model.declarations.find((item) => item.name === name && rangeEquals(item.selectionRange, range));
  if (declaration?.symbol) {
    return {
      kind: 'symbol',
      name,
      declarationRange: declaration.symbol.selectionRange,
      symbol: declaration.symbol
    };
  }
  if (declaration?.macro) {
    return {
      kind: 'macro',
      name,
      declarationRange: declaration.macro.selectionRange,
      macro: declaration.macro
    };
  }

  const reference = model.references.find((item) => item.name === name && rangeEquals(item.range, range))
    ?? model.references.find((item) => item.name === name && containsPosition(item.range, position));
  if (reference?.symbol) {
    return {
      kind: 'symbol',
      name,
      declarationRange: reference.symbol.selectionRange,
      symbol: reference.symbol
    };
  }
  if (reference?.macro) {
    return {
      kind: 'macro',
      name,
      declarationRange: reference.macro.selectionRange,
      macro: reference.macro
    };
  }

  const symbol = resolveMipsSemanticMacroParamAtPosition(model, name, position)
    ?? resolveMipsSemanticSymbolAtPosition(model, name, position);
  if (symbol) {
    return {
      kind: 'symbol',
      name,
      declarationRange: symbol.selectionRange,
      symbol
    };
  }
  const macro = resolveMipsSemanticMacroAtPosition(model, name, position);
  if (macro) {
    return {
      kind: 'macro',
      name,
      declarationRange: macro.selectionRange,
      macro
    };
  }
  return undefined;
}

export function mipsSemanticReferenceRanges(model: MipsSemanticModel, target: MipsSemanticTarget, includeDeclaration: boolean): Range[] {
  const ranges: Range[] = [];
  if (includeDeclaration) {
    ranges.push(target.declarationRange);
  }
  for (const reference of model.references) {
    if (referenceMatchesTarget(reference, target)) {
      ranges.push(reference.range);
    }
  }
  return dedupeRanges(ranges);
}

function collectDeclarations(
  source: MipsSemanticSource,
  globalScope: MipsSemanticScope,
  macroScopes: MipsSemanticScope[]
): MipsSemanticDeclaration[] {
  const declarations: MipsSemanticDeclaration[] = [];
  for (const macro of macroScopes) {
    if (macro.macro) {
      declarations.push({
        name: macro.macro.name,
        kind: 'macro',
        range: macro.macro.range,
        selectionRange: macro.macro.selectionRange,
        macro: macro.macro,
        scope: globalScope
      });
    }
    for (const symbol of [
      ...macro.labels.values(),
      ...macro.dataSymbols.values(),
      ...macro.eqvSymbols.values(),
      ...macro.macroParams.values()
    ]) {
      declarations.push({
        name: symbol.name,
        kind: symbol.kind,
        range: symbol.range,
        selectionRange: symbol.selectionRange,
        symbol,
        scope: macro
      });
    }
  }
  for (const symbol of [
    ...source.labels.values(),
    ...source.dataSymbols.values(),
    ...source.eqvSymbols.values()
  ]) {
    declarations.push({
      name: symbol.name,
      kind: symbol.kind,
      range: symbol.range,
      selectionRange: symbol.selectionRange,
      symbol,
      scope: globalScope
    });
  }
  return declarations;
}

function collectReferences(
  ast: MipsAstDocument,
  globalScope: MipsSemanticScope,
  macroScopes: MipsSemanticScope[],
  macros: Map<string, MipsMacro[]>,
  declarationRangeKeys: Set<string>
): MipsSemanticReference[] {
  const references: MipsSemanticReference[] = [];
  for (const statement of ast.statements) {
    const scope = macroScopes.find((candidate) => containsPosition(candidate.range, statement.range.start)) ?? globalScope;
    for (const token of statement.tokens) {
      if (!isReferenceToken(token)) {
        continue;
      }
      const range = mipsCstTokenRange(token);
      if (declarationRangeKeys.has(rangeKey(range))) {
        continue;
      }
      if (isExecutableMnemonicRange(statement, range) && !macros.has(token.value)) {
        continue;
      }
      const reference = classifyReference(token, range, statement, scope, globalScope, macros);
      if (reference) {
        references.push(reference);
      }
    }
  }
  return references;
}

function classifyReference(
  token: MipsCstToken,
  range: Range,
  statement: MipsStatementAst,
  scope: MipsSemanticScope,
  globalScope: MipsSemanticScope,
  macros: Map<string, MipsMacro[]>
): MipsSemanticReference | undefined {
  const name = token.value;
  if (name.startsWith('.') && directives.has(name.toLowerCase())) {
    return undefined;
  }
  if (instructions[name.toLowerCase()]) {
    return undefined;
  }
  if (name.startsWith('$') && (isRegister(name) || isFloatingPointRegister(name))) {
    return {
      name,
      kind: 'register',
      range,
      token,
      statement,
      scope
    };
  }
  if (name.startsWith('%')) {
    const symbol = scope.macroParams.get(name);
    return {
      name,
      kind: symbol ? 'macroParam' : 'unresolved',
      range,
      token,
      statement,
      scope,
      symbol
    };
  }
  const macro = resolveMacroReference(name, macros, statement);
  if (macro) {
    return {
      name,
      kind: 'macro',
      range,
      token,
      statement,
      scope,
      macro
    };
  }
  const symbol = resolveSymbolInScope(name, scope, globalScope);
  if (symbol) {
    return {
      name,
      kind: symbol.kind,
      range,
      token,
      statement,
      scope,
      symbol
    };
  }
  if (!name.startsWith('.') && isSymbolLike(name)) {
    return {
      name,
      kind: 'unresolved',
      range,
      token,
      statement,
      scope
    };
  }
  return undefined;
}

function resolveSymbolInScope(name: string, scope: MipsSemanticScope, globalScope: MipsSemanticScope): MipsSymbol | undefined {
  return scope.labels.get(name)
    ?? scope.dataSymbols.get(name)
    ?? scope.eqvSymbols.get(name)
    ?? globalScope.labels.get(name)
    ?? globalScope.dataSymbols.get(name)
    ?? globalScope.eqvSymbols.get(name);
}

function resolveMacroReference(name: string, macros: Map<string, MipsMacro[]>, statement: MipsStatementAst): MipsMacro | undefined {
  const overloads = macros.get(name);
  if (!overloads?.length) {
    return undefined;
  }
  const operandText = statement.executable?.cst.operandText ?? '';
  const argumentCount = parseMacroArguments(operandText).length;
  return overloads.find((macro) => macro.params.length === argumentCount) ?? overloads[0];
}

function isReferenceToken(token: MipsCstToken): boolean {
  return token.kind === 'identifier' || token.kind === 'macroParameter' || token.kind === 'register';
}

function isExecutableMnemonicRange(statement: MipsStatementAst, range: Range): boolean {
  return Boolean(statement.executable && rangeKey(statement.executable.mnemonicRange) === rangeKey(range));
}

export function resolveMipsSemanticMacroAtPosition(model: MipsSemanticModel, name: string, position: Position): MipsMacro | undefined {
  const currentMacro = findMipsSemanticMacroAtPosition(model, position);
  if (currentMacro?.name === name) {
    return currentMacro;
  }
  const reference = model.references.find((item) => item.kind === 'macro' && item.name === name && containsPosition(item.range, position));
  if (reference?.macro) {
    return reference.macro;
  }
  const overloads = model.macros.filter((macro) => macro.name === name);
  return overloads[0];
}

function referenceMatchesTarget(reference: MipsSemanticReference, target: MipsSemanticTarget): boolean {
  if (target.kind === 'symbol') {
    return Boolean(reference.symbol && reference.symbol === target.symbol);
  }
  return Boolean(reference.macro && reference.macro === target.macro);
}

function dedupeRanges(ranges: Range[]): Range[] {
  const result: Range[] = [];
  const seen = new Set<string>();
  for (const range of ranges) {
    const key = rangeKey(range);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(range);
  }
  return result;
}

function rangeEquals(left: Range, right: Range): boolean {
  return rangeKey(left) === rangeKey(right);
}
