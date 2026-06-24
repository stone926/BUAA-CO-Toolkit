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
import { VerilogAstDocument, VerilogModuleAst } from './ast';
import { verilogAstCodeTokens } from './astTokens';
import type { VerilogProceduralBlockAst } from './blockAst';
import { parseVerilogExpressionTokens } from './exprAst';
import type { VerilogExpressionAst } from './exprAst';
import { walkVerilogExpression } from './exprAstUtils';
import type { VerilogProceduralStatementAst } from './proceduralAst';
import {
  findMatchingTokenForward as findMatchingToken,
  findTopLevelToken as firstTopLevelToken,
  splitTopLevelTokens as splitTopLevel,
  trimTrailingSemicolonTokens
} from './tokenUtils';

export type VerilogSemanticSymbolKind =
  | 'module'
  | 'port'
  | 'signal'
  | 'parameter'
  | 'instance'
  | 'task'
  | 'macro'
  | 'include';

export type VerilogSemanticReferenceKind =
  | 'module'
  | 'signal'
  | 'instance'
  | 'task'
  | 'portConnection'
  | 'macro'
  | 'include'
  | 'unresolved';

export interface VerilogSemanticScope {
  kind: 'file' | 'module' | 'block';
  name?: string;
  range: Range;
  symbols: Map<string, VerilogSemanticSymbol[]>;
  children: VerilogSemanticScope[];
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

export interface VerilogSemanticTarget {
  name: string;
  symbol: VerilogSemanticSymbol;
}

export interface VerilogSemanticModel {
  documentUri: string;
  ast: VerilogAstDocument;
  fileScope: VerilogSemanticScope;
  moduleScopes: VerilogSemanticScope[];
  blockScopes: VerilogSemanticScope[];
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

const collectedReferenceRangeKeys = new WeakMap<VerilogSemanticReference[], Set<string>>();

export function buildVerilogSemanticModel(source: VerilogSemanticSource): VerilogSemanticModel {
  const fileScope: VerilogSemanticScope = {
    kind: 'file',
    range: source.ast.range,
    symbols: new Map(),
    children: []
  };
  const moduleScopes = source.modules.map((module): VerilogSemanticScope => ({
    kind: 'module',
    name: module.name,
    range: module.range,
    symbols: new Map(),
    children: [],
    module,
    parent: fileScope
  }));
  fileScope.children.push(...moduleScopes);
  const astTokens = verilogAstCodeTokens(source.ast);
  const blockScopes = collectBlockScopes(source.document, source.ast.modules, astTokens, moduleScopes);
  const symbols = collectSymbols(source, fileScope, moduleScopes, blockScopes, astTokens);
  const declarationRangeKeys = new Set(symbols.map((symbol) => rangeKey(symbol.selectionRange)));
  const references = collectReferences(source.document, source, fileScope, moduleScopes, blockScopes, declarationRangeKeys);
  return {
    documentUri: source.document.uri,
    ast: source.ast,
    fileScope,
    moduleScopes,
    blockScopes,
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

export function verilogSemanticTargetFromSymbol(symbol: VerilogSemanticSymbol): VerilogSemanticTarget {
  return {
    name: symbol.name,
    symbol
  };
}

export function verilogSemanticReferenceRanges(model: VerilogSemanticModel, target: VerilogSemanticTarget, includeDeclaration: boolean): Range[] {
  const ranges: Range[] = [];
  if (includeDeclaration) {
    ranges.push(target.symbol.selectionRange);
  }
  for (const reference of model.references) {
    if (referenceMatchesTarget(reference, target)) {
      ranges.push(reference.range);
    }
  }
  return dedupeRanges(ranges);
}

export function findVerilogSemanticSymbol(
  model: VerilogSemanticModel,
  predicate: (symbol: VerilogSemanticSymbol) => boolean
): VerilogSemanticSymbol | undefined {
  return model.symbols.find(predicate);
}

function collectSymbols(
  source: VerilogSemanticSource,
  fileScope: VerilogSemanticScope,
  moduleScopes: VerilogSemanticScope[],
  blockScopes: VerilogSemanticScope[],
  astTokens: VerilogToken[]
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
      const declScope = declarationScopeFor(module, scope, blockScopes, decl);
      symbols.push(addSymbol(declScope, {
        name: decl.name,
        kind: declSymbolKind(decl),
        uri: source.document.uri,
        range: decl.range,
        selectionRange: decl.selectionRange,
        scope: declScope,
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
    const moduleAst = source.ast.modules.find((item) => item.module === module);
    for (const decl of collectBlockLocalDeclarations(source.document, moduleAst, astTokens, module, blockScopes)) {
      const declScope = declarationScopeFor(module, scope, blockScopes, decl);
      if (declScope.symbols.get(decl.name)?.some((symbol) => rangesEqual(symbol.selectionRange, decl.selectionRange))) {
        continue;
      }
      symbols.push(addSymbol(declScope, {
        name: decl.name,
        kind: declSymbolKind(decl),
        uri: source.document.uri,
        range: decl.range,
        selectionRange: decl.selectionRange,
        scope: declScope,
        module,
        decl
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
  blockScopes: VerilogSemanticScope[],
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
        const connectionScope = scopeAtPosition(scope, blockScopes, connection.expressionRange.start);
        if (!connection.name || !connection.nameRange) {
          collectReferencesFromConnectionExpression(document, references, declarationRangeKeys, connectionScope, module, connection);
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
        collectReferencesFromConnectionExpression(document, references, declarationRangeKeys, connectionScope, module, connection);
      }
    }

    for (const decl of module.declarations.values()) {
      for (const widthExpression of decl.widthAst ?? []) {
        const widthScope = scopeAtPosition(scope, blockScopes, decl.widthRange?.start ?? decl.range.start);
        collectReferencesFromExpressionAst(document, references, declarationRangeKeys, widthScope, module, widthExpression, 0);
      }
      if (!decl.initializer || !decl.initializerRange) {
        continue;
      }
      const initScope = scopeAtPosition(scope, blockScopes, decl.initializerRange.start);
      if (decl.initializerAst) {
        collectReferencesFromExpressionAst(document, references, declarationRangeKeys, initScope, module, decl.initializerAst, 0);
      }
    }

    collectAstDrivenModuleReferences(document, source, references, declarationRangeKeys, module, scope, blockScopes);
  }

  return references;
}

function collectBlockScopes(
  document: TextDocument,
  moduleAsts: VerilogModuleAst[],
  tokens: VerilogToken[],
  moduleScopes: VerilogSemanticScope[]
): VerilogSemanticScope[] {
  const result: VerilogSemanticScope[] = [];
  for (const moduleAst of moduleAsts) {
    const module = moduleAst.module;
    const moduleScope = moduleScopes.find((scope) => scope.module === module);
    if (!moduleScope) {
      continue;
    }
    for (const block of moduleAst.proceduralBlocks) {
      result.push(...collectProceduralStatementBlockScopes(module, moduleScope, block.statementTree));
    }
    result.push(...collectSubroutineBlockScopes(document, tokens, module, moduleScope));
  }
  return result;
}

function collectProceduralStatementBlockScopes(
  module: VerilogModule,
  parent: VerilogSemanticScope,
  statement: VerilogProceduralStatementAst
): VerilogSemanticScope[] {
  const result: VerilogSemanticScope[] = [];
  const pushScope = (name: string, range: Range): VerilogSemanticScope => {
    const scope = makeBlockScopeFromRange(module, parent, name, range);
    parent.children.push(scope);
    result.push(scope);
    return scope;
  };
  switch (statement.kind) {
    case 'block': {
      const explicitBegin = statement.tokens[0]?.value === 'begin';
      const scope = explicitBegin ? pushScope('begin', statement.range) : parent;
      for (const child of statement.statements) {
        result.push(...collectProceduralStatementBlockScopes(module, scope, child));
      }
      return result;
    }
    case 'case': {
      const scope = pushScope('case', statement.range);
      for (const item of statement.items) {
        result.push(...collectProceduralStatementBlockScopes(module, scope, item.body));
      }
      return result;
    }
    case 'loop': {
      const scope = statement.loopKind === 'for' ? pushScope('for', statement.range) : parent;
      result.push(...collectProceduralStatementBlockScopes(module, scope, statement.body));
      return result;
    }
    case 'if':
      result.push(...collectProceduralStatementBlockScopes(module, parent, statement.consequent));
      if (statement.alternate) {
        result.push(...collectProceduralStatementBlockScopes(module, parent, statement.alternate));
      }
      return result;
    case 'assignment':
    case 'declaration':
    case 'other':
      return result;
  }
}

function collectSubroutineBlockScopes(
  document: TextDocument,
  tokens: VerilogToken[],
  module: VerilogModule,
  moduleScope: VerilogSemanticScope
): VerilogSemanticScope[] {
  const result: VerilogSemanticScope[] = [];
  const moduleStart = document.offsetAt(module.headerEnd);
  const moduleEnd = document.offsetAt(module.endmoduleRange?.start ?? module.range.end);
  const moduleTokens = tokens.filter((token) => token.start >= moduleStart && token.start < moduleEnd && token.kind !== 'eof');
  for (let index = 0; index < moduleTokens.length; index++) {
    const token = moduleTokens[index];
    if (token.value !== 'task' && token.value !== 'function') {
      continue;
    }
    const close = findSubroutineEndToken(moduleTokens, index);
    const end = close >= 0 ? moduleTokens[close].end : moduleEnd;
    const scope = makeBlockScopeFromRange(
      module,
      moduleScope,
      token.value,
      Range.create(document.positionAt(token.start), document.positionAt(end))
    );
    moduleScope.children.push(scope);
    result.push(scope);
    if (close >= 0) {
      index = close;
    }
  }
  return result;
}

function findSubroutineEndToken(tokens: VerilogToken[], start: number): number {
  const opener = tokens[start]?.value;
  const closer = opener === 'task' ? 'endtask' : opener === 'function' ? 'endfunction' : undefined;
  if (!closer) {
    return -1;
  }
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    const value = tokens[index].value;
    if (value === opener) {
      depth++;
    } else if (value === closer) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

const declarationKinds = new Set([
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'integer',
  'real',
  'realtime',
  'time',
  'parameter',
  'localparam',
  'genvar'
]);

const declarationModifiers = new Set([
  'automatic',
  'signed',
  'unsigned',
  'wire',
  'reg',
  'logic'
]);

function splitBySemicolon(tokens: VerilogToken[]): VerilogToken[][] {
  const result: VerilogToken[][] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    } else if (token.value === ';' && paren === 0 && bracket === 0 && brace === 0) {
      result.push(tokens.slice(start, index + 1).filter((item) => item.kind !== 'eof'));
      start = index + 1;
    }
  }
  if (start < tokens.length) {
    result.push(tokens.slice(start).filter((item) => item.kind !== 'eof'));
  }
  return result.filter((part) => part.length > 0);
}

function declarationNameToken(tokens: VerilogToken[]): VerilogToken | undefined {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '[') {
      const close = findMatchingToken(tokens, index, '[', ']');
      if (close >= 0) {
        index = close;
        continue;
      }
    }
    if (declarationKinds.has(token.value) || declarationModifiers.has(token.value)) {
      continue;
    }
    if (token.kind === 'identifier') {
      return token;
    }
  }
  return undefined;
}

function dedupeDecls(declarations: VerilogDecl[]): VerilogDecl[] {
  const seen = new Set<string>();
  const result: VerilogDecl[] = [];
  for (const decl of declarations) {
    const key = `${decl.name}:${rangeKey(decl.selectionRange)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(decl);
  }
  return result;
}

function nextTokenValue(tokens: VerilogToken[], start: number, value: string): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].value === value) {
      return index;
    }
    if (tokens[index].value !== 'automatic') {
      return -1;
    }
  }
  return -1;
}

function looksLikeInstanceStatement(module: VerilogModule, tokens: VerilogToken[]): boolean {
  const first = tokens[0];
  if (!first || !isIdentifierToken(first) || first.value === module.name) {
    return false;
  }
  if (declarationKinds.has(first.value) || proceduralKeywords.has(first.value)) {
    return false;
  }
  let index = 1;
  if (tokens[index]?.value === '#') {
    if (tokens[index + 1]?.value !== '(') {
      return false;
    }
    const close = findMatchingToken(tokens, index + 1, '(', ')');
    if (close < 0) {
      return false;
    }
    index = close + 1;
  }
  return Boolean(isIdentifierToken(tokens[index]) && (tokens[index + 1]?.value === '(' || tokens[index + 1]?.value === ';'));
}

const proceduralKeywords = new Set([
  'always',
  'initial',
  'begin',
  'end',
  'if',
  'else',
  'case',
  'casex',
  'casez',
  'endcase',
  'for',
  'forever',
  'repeat',
  'while',
  'task',
  'endtask',
  'function',
  'endfunction'
]);

function isIdentifierToken(token: VerilogToken | undefined): token is VerilogToken {
  return Boolean(token && token.kind === 'identifier');
}

function referenceKindForSymbol(symbol: VerilogSemanticSymbol | undefined): VerilogSemanticReferenceKind {
  if (!symbol) {
    return 'unresolved';
  }
  if (symbol.kind === 'instance') {
    return 'instance';
  }
  if (symbol.kind === 'task') {
    return 'task';
  }
  return 'signal';
}

function makeBlockScopeFromRange(
  module: VerilogModule,
  parent: VerilogSemanticScope,
  name: string,
  range: Range
): VerilogSemanticScope {
  return {
    kind: 'block',
    name,
    range,
    symbols: new Map(),
    children: [],
    module,
    parent
  };
}

function declarationScopeFor(
  module: VerilogModule,
  moduleScope: VerilogSemanticScope,
  blockScopes: VerilogSemanticScope[],
  decl: VerilogDecl
): VerilogSemanticScope {
  if (decl.kind === 'task' || decl.kind === 'function' || decl.direction || decl.kind === 'parameter' || decl.kind === 'localparam') {
    return moduleScope;
  }
  return scopeAtPosition(moduleScope, blockScopes.filter((scope) => scope.module === module), decl.selectionRange.start);
}

function scopeAtPosition(
  moduleScope: VerilogSemanticScope,
  blockScopes: VerilogSemanticScope[],
  position: Position
): VerilogSemanticScope {
  return blockScopes
    .filter((scope) => scope.module === moduleScope.module && containsPosition(scope.range, position))
    .sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0]
    ?? moduleScope;
}

function collectBlockLocalDeclarations(
  document: TextDocument,
  moduleAst: VerilogModuleAst | undefined,
  tokens: VerilogToken[],
  module: VerilogModule,
  blockScopes: VerilogSemanticScope[]
): VerilogDecl[] {
  const result: VerilogDecl[] = [];
  if (moduleAst) {
    for (const block of moduleAst.proceduralBlocks) {
      result.push(...collectProceduralLocalDeclarations(document, block.statementTree));
    }
  }
  result.push(...collectSubroutineLocalDeclarations(document, tokens, module, blockScopes));
  return dedupeDecls(result);
}

function collectProceduralLocalDeclarations(document: TextDocument, statement: VerilogProceduralStatementAst): VerilogDecl[] {
  switch (statement.kind) {
    case 'block':
      return statement.statements.flatMap((child) => collectProceduralLocalDeclarations(document, child));
    case 'declaration':
      return localDeclarationsFromTokens(document, statement.tokens);
    case 'loop':
      return [
        ...forControlDeclarationsFromControlTokens(document, statement.controlTokens),
        ...collectProceduralLocalDeclarations(document, statement.body)
      ];
    case 'if':
      return [
        ...collectProceduralLocalDeclarations(document, statement.consequent),
        ...(statement.alternate ? collectProceduralLocalDeclarations(document, statement.alternate) : [])
      ];
    case 'case':
      return statement.items.flatMap((item) => collectProceduralLocalDeclarations(document, item.body));
    case 'assignment':
    case 'other':
      return [];
  }
}

function forControlDeclarationsFromControlTokens(document: TextDocument, tokens: VerilogToken[]): VerilogDecl[] {
  const semicolon = tokens.findIndex((token) => token.value === ';');
  const initTokens = semicolon >= 0 ? tokens.slice(0, semicolon) : tokens;
  return localDeclarationsFromTokens(document, initTokens);
}

function collectSubroutineLocalDeclarations(
  document: TextDocument,
  tokens: VerilogToken[],
  module: VerilogModule,
  blockScopes: VerilogSemanticScope[]
): VerilogDecl[] {
  const result: VerilogDecl[] = [];
  const subroutineScopes = blockScopes.filter((scope) => scope.module === module && (scope.name === 'task' || scope.name === 'function'));
  for (const scope of subroutineScopes) {
    const start = document.offsetAt(scope.range.start);
    const end = document.offsetAt(scope.range.end);
    const scopeTokens = tokens.filter((token) => token.start >= start && token.end <= end && token.kind !== 'eof');
    for (const statement of splitBySemicolon(scopeTokens)) {
      for (let index = 0; index < statement.length; index++) {
        if (declarationKinds.has(statement[index].value)) {
          result.push(...localDeclarationsFromTokens(document, statement.slice(index)));
        }
      }
      result.push(...forControlDeclarations(document, statement));
    }
  }
  return result;
}

function localDeclarationsFromTokens(document: TextDocument, tokens: VerilogToken[]): VerilogDecl[] {
  const first = tokens[0];
  if (!first || !declarationKinds.has(first.value)) {
    return [];
  }
  const kind = first.value as VerilogDecl['kind'];
  const declarations: VerilogDecl[] = [];
  for (const part of splitTopLevel(tokens.slice(1), ',')) {
    const name = declarationNameToken(part);
    if (!name) {
      continue;
    }
    declarations.push({
      name: name.value,
      kind,
      range: Range.create(document.positionAt(first.start), document.positionAt(tokens[tokens.length - 1].end)),
      selectionRange: verilogTokenRange(document, name)
    });
  }
  return declarations;
}

function forControlDeclarations(document: TextDocument, tokens: VerilogToken[]): VerilogDecl[] {
  const result: VerilogDecl[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== 'for') {
      continue;
    }
    const open = nextTokenValue(tokens, index + 1, '(');
    if (open < 0) {
      continue;
    }
    const close = findMatchingToken(tokens, open, '(', ')');
    if (close < 0) {
      continue;
    }
    const init = tokens.slice(open + 1, close);
    const semicolon = init.findIndex((token) => token.value === ';');
    const initTokens = semicolon >= 0 ? init.slice(0, semicolon) : init;
    result.push(...localDeclarationsFromTokens(document, initTokens));
  }
  return result;
}

function collectAstDrivenModuleReferences(
  document: TextDocument,
  source: VerilogSemanticSource,
  references: VerilogSemanticReference[],
  declarationRangeKeys: Set<string>,
  module: VerilogModule,
  moduleScope: VerilogSemanticScope,
  blockScopes: VerilogSemanticScope[]
): void {
  const moduleAst = source.ast.modules.find((item) => item.module === module);
  if (!moduleAst) {
    return;
  }
  const proceduralBlocks = moduleAst.proceduralBlocks;
  for (const statementAst of moduleAst.items) {
    const block = proceduralBlockForStatement(document, statementAst.start, proceduralBlocks);
    if (block) {
      collectReferencesFromProceduralBlockAst(document, source, references, declarationRangeKeys, module, moduleScope, blockScopes, block);
      continue;
    }
    if (isInsideProceduralBlockBody(document, statementAst.start, statementAst.end, proceduralBlocks)) {
      continue;
    }
    const tokens = statementAst.tokens.filter((token) => token.kind !== 'eof');
    const first = tokens[0];
    if (!first) {
      continue;
    }
    if (first.value === 'module' || first.value === 'endmodule') {
      continue;
    }
    if (declarationKinds.has(first.value)) {
      const equal = firstTopLevelToken(tokens, '=');
      if (equal >= 0) {
        const scope = scopeAtPosition(moduleScope, blockScopes, statementAst.range.start);
        const expressionTokens = tokens.slice(equal + 1);
        collectReferencesFromExpressionTokens(document, references, declarationRangeKeys, scope, module, expressionTokens);
        collectReferencesFromTokens(document, source, references, declarationRangeKeys, scope, module, expressionTokens);
      }
      continue;
    }
    if (looksLikeInstanceStatement(module, tokens)) {
      continue;
    }
    const scope = scopeAtPosition(moduleScope, blockScopes, statementAst.range.start);
    for (const expression of statementAst.expressions) {
      collectReferencesFromExpressionAst(document, references, declarationRangeKeys, scope, module, expression, 0);
    }
    if (statementAst.expressions.length > 0) {
      continue;
    }
    collectReferencesFromTokens(document, source, references, declarationRangeKeys, scope, module, tokens);
  }
}

function proceduralBlockForStatement(document: TextDocument, start: number, blocks: VerilogProceduralBlockAst[]): VerilogProceduralBlockAst | undefined {
  return blocks.find((block) => blockStartsAt(document, block, start));
}

function isInsideProceduralBlockBody(document: TextDocument, start: number, end: number, blocks: VerilogProceduralBlockAst[]): boolean {
  return blocks.some((block) => !blockStartsAt(document, block, start) && start >= block.bodyStart && end <= block.bodyEnd);
}

function blockStartsAt(document: TextDocument, block: VerilogProceduralBlockAst, offset: number): boolean {
  return document.offsetAt(block.range.start) === offset;
}

function collectReferencesFromProceduralBlockAst(
  document: TextDocument,
  source: VerilogSemanticSource,
  references: VerilogSemanticReference[],
  declarationRangeKeys: Set<string>,
  module: VerilogModule,
  moduleScope: VerilogSemanticScope,
  blockScopes: VerilogSemanticScope[],
  block: VerilogProceduralBlockAst
): void {
  const controlScope = scopeAtPosition(moduleScope, blockScopes, block.headerRange.start);
  collectReferencesFromTokens(document, source, references, declarationRangeKeys, controlScope, module, block.controlTokens);
  collectReferencesFromProceduralStatementAst(document, source, references, declarationRangeKeys, module, moduleScope, blockScopes, block.statementTree);
}

function collectReferencesFromProceduralStatementAst(
  document: TextDocument,
  source: VerilogSemanticSource,
  references: VerilogSemanticReference[],
  declarationRangeKeys: Set<string>,
  module: VerilogModule,
  moduleScope: VerilogSemanticScope,
  blockScopes: VerilogSemanticScope[],
  statement: VerilogProceduralStatementAst
): void {
  const scope = scopeAtPosition(moduleScope, blockScopes, statement.range.start);
  switch (statement.kind) {
    case 'block':
      for (const child of statement.statements) {
        collectReferencesFromProceduralStatementAst(document, source, references, declarationRangeKeys, module, moduleScope, blockScopes, child);
      }
      return;
    case 'assignment':
      if (statement.lhs && statement.rhs) {
        collectReferencesFromExpressionAst(document, references, declarationRangeKeys, scope, module, statement.lhs, 0);
        collectReferencesFromExpressionAst(document, references, declarationRangeKeys, scope, module, statement.rhs, 0);
        return;
      }
      collectReferencesFromTokens(document, source, references, declarationRangeKeys, scope, module, statement.tokens);
      return;
    case 'if':
      if (statement.condition) {
        collectReferencesFromExpressionAst(document, references, declarationRangeKeys, scope, module, statement.condition, 0);
      }
      collectReferencesFromProceduralStatementAst(document, source, references, declarationRangeKeys, module, moduleScope, blockScopes, statement.consequent);
      if (statement.alternate) {
        collectReferencesFromProceduralStatementAst(document, source, references, declarationRangeKeys, module, moduleScope, blockScopes, statement.alternate);
      }
      return;
    case 'case':
      if (statement.expression) {
        collectReferencesFromExpressionAst(document, references, declarationRangeKeys, scope, module, statement.expression, 0);
      }
      for (const item of statement.items) {
        for (const label of item.labels) {
          collectReferencesFromExpressionAst(document, references, declarationRangeKeys, scope, module, label, 0);
        }
        collectReferencesFromProceduralStatementAst(document, source, references, declarationRangeKeys, module, moduleScope, blockScopes, item.body);
      }
      return;
    case 'loop':
      if (statement.condition) {
        collectReferencesFromExpressionAst(document, references, declarationRangeKeys, scope, module, statement.condition, 0);
      } else if (statement.controlTokens.length) {
        collectReferencesFromTokens(document, source, references, declarationRangeKeys, scope, module, statement.controlTokens);
      }
      collectReferencesFromProceduralStatementAst(document, source, references, declarationRangeKeys, module, moduleScope, blockScopes, statement.body);
      return;
    case 'declaration':
      collectReferencesFromTokens(document, source, references, declarationRangeKeys, scope, module, statement.tokens);
      return;
    case 'other':
      if (statement.expression) {
        collectReferencesFromExpressionAst(document, references, declarationRangeKeys, scope, module, statement.expression, 0);
        return;
      }
      collectReferencesFromTokens(document, source, references, declarationRangeKeys, scope, module, statement.tokens);
      return;
  }
}

function collectReferencesFromConnectionExpression(
  document: TextDocument,
  references: VerilogSemanticReference[],
  declarationRangeKeys: Set<string>,
  scope: VerilogSemanticScope,
  module: VerilogModule,
  connection: VerilogPortConnection
): void {
  if (!connection.expression.trim()) {
    return;
  }
  if (connection.expressionAst) {
    collectReferencesFromExpressionAst(document, references, declarationRangeKeys, scope, module, connection.expressionAst, 0);
  }
}

function collectReferencesFromExpressionTokens(
  document: TextDocument,
  references: VerilogSemanticReference[],
  declarationRangeKeys: Set<string>,
  scope: VerilogSemanticScope,
  module: VerilogModule,
  tokens: VerilogToken[]
): void {
  const expressionTokens = trimTrailingSemicolonTokens(tokens);
  if (!expressionTokens.length) {
    return;
  }
  const expression = parseVerilogExpressionTokens(expressionTokens);
  if (!expression) {
    return;
  }
  collectReferencesFromExpressionAst(document, references, declarationRangeKeys, scope, module, expression, 0);
}

function collectReferencesFromExpressionAst(
  document: TextDocument,
  references: VerilogSemanticReference[],
  declarationRangeKeys: Set<string>,
  scope: VerilogSemanticScope,
  module: VerilogModule,
  expression: VerilogExpressionAst,
  baseOffset: number
): void {
  walkVerilogExpression(expression, (candidate) => {
    if (candidate.kind !== 'identifier') {
      return;
    }
    const range = Range.create(
      document.positionAt(baseOffset + candidate.start),
      document.positionAt(baseOffset + candidate.end)
    );
    addIdentifierReference(document, references, declarationRangeKeys, scope, module, candidate.name, range);
  });
}

function collectReferencesFromTokens(
  document: TextDocument,
  source: VerilogSemanticSource,
  references: VerilogSemanticReference[],
  declarationRangeKeys: Set<string>,
  scope: VerilogSemanticScope,
  module: VerilogModule,
  tokens: VerilogToken[]
): void {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'identifier') {
      continue;
    }
    const range = verilogTokenRange(document, token);
    if (declarationRangeKeys.has(rangeKey(range)) || isNonReferenceIdentifier(tokens, index)) {
      continue;
    }
    addIdentifierReference(document, references, declarationRangeKeys, scope, module, token.value, range, token);
  }
}

function addIdentifierReference(
  document: TextDocument,
  references: VerilogSemanticReference[],
  declarationRangeKeys: Set<string>,
  scope: VerilogSemanticScope,
  module: VerilogModule,
  name: string,
  range: Range,
  token?: VerilogToken
): void {
  const key = rangeKey(range);
  if (declarationRangeKeys.has(key)) {
    return;
  }
  const referenceRangeKeys = rangeKeysForReferences(references);
  if (referenceRangeKeys.has(key)) {
    return;
  }
  const symbol = resolveIdentifierInScope(scope, name);
  referenceRangeKeys.add(key);
  references.push({
    name,
    kind: referenceKindForSymbol(symbol),
    uri: document.uri,
    range,
    scope,
    token,
    symbol,
    module
  });
}

function rangeKeysForReferences(references: VerilogSemanticReference[]): Set<string> {
  let keys = collectedReferenceRangeKeys.get(references);
  if (!keys) {
    keys = new Set(references.map((reference) => rangeKey(reference.range)));
    collectedReferenceRangeKeys.set(references, keys);
  }
  return keys;
}


function addSymbol(scope: VerilogSemanticScope, symbol: VerilogSemanticSymbol): VerilogSemanticSymbol {
  const entries = scope.symbols.get(symbol.name) ?? [];
  entries.push(symbol);
  scope.symbols.set(symbol.name, entries);
  return symbol;
}

function resolveIdentifierInScope(scope: VerilogSemanticScope, name: string): VerilogSemanticSymbol | undefined {
  let current: VerilogSemanticScope | undefined = scope;
  while (current) {
    const symbol = current.symbols.get(name)?.[0];
    if (symbol) {
      return symbol;
    }
    current = current.parent;
  }
  return undefined;
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
  if (decl.kind === 'task' || decl.kind === 'function') {
    return 'task';
  }
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

// 未绑定引用只允许这些"裸标识符使用"类别按名字回退匹配。结构化引用——端口/参数连接名
// （`.clk`）、模块名、宏名、include 名——指向的是其它实体，只是恰好与某个本地信号/端口同名，
// 不应被当作该信号的引用（否则会污染 find-references / rename / 信号连线面板）。
const nameMatchableReferenceKinds = new Set<VerilogSemanticReferenceKind>(['signal', 'instance', 'task', 'unresolved']);

function referenceMatchesTarget(reference: VerilogSemanticReference, target: VerilogSemanticTarget): boolean {
  if (reference.symbol) {
    return reference.symbol === target.symbol;
  }
  if (!nameMatchableReferenceKinds.has(reference.kind)) {
    return false;
  }
  return reference.name === target.symbol.name
    && reference.scope === target.symbol.scope
    && (target.symbol.kind === 'signal' || target.symbol.kind === 'port' || target.symbol.kind === 'parameter' || target.symbol.kind === 'instance' || target.symbol.kind === 'task');
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
