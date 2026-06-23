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
import { parseVerilogExpression } from './exprAst';
import type { VerilogExpressionAst } from './exprAst';
import { walkVerilogExpression } from './exprAstUtils';
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
  const blockScopes = collectBlockScopes(source.document, source.ast.cst.codeTokens, source.modules, moduleScopes);
  const symbols = collectSymbols(source, fileScope, moduleScopes, blockScopes);
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
  blockScopes: VerilogSemanticScope[]
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
    for (const decl of collectBlockLocalDeclarations(source.document, source.ast.cst.codeTokens, module, blockScopes)) {
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
          collectReferencesFromConnectionExpression(document, source, references, declarationRangeKeys, connectionScope, module, connection);
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
        collectReferencesFromConnectionExpression(document, source, references, declarationRangeKeys, connectionScope, module, connection);
      }
    }

    for (const decl of module.declarations.values()) {
      if (!decl.initializer || !decl.initializerRange) {
        continue;
      }
      const initScope = scopeAtPosition(scope, blockScopes, decl.initializerRange.start);
      if (decl.initializerAst) {
        collectReferencesFromExpressionAst(document, references, declarationRangeKeys, initScope, module, decl.initializerAst, 0);
      } else {
        collectReferencesFromExpressionText(document, references, declarationRangeKeys, initScope, module, decl.initializer, decl.initializerRange);
        collectReferencesFromRange(document, source, references, declarationRangeKeys, initScope, module, decl.initializerRange);
      }
    }

    const moduleStart = document.offsetAt(module.range.start);
    const moduleEnd = document.offsetAt(module.range.end);
    collectAstDrivenModuleReferences(document, source, references, declarationRangeKeys, module, scope, blockScopes, moduleStart, moduleEnd);
  }

  return references;
}

function collectBlockScopes(
  document: TextDocument,
  tokens: VerilogToken[],
  modules: VerilogModule[],
  moduleScopes: VerilogSemanticScope[]
): VerilogSemanticScope[] {
  const result: VerilogSemanticScope[] = [];
  for (const module of modules) {
    const moduleScope = moduleScopes.find((scope) => scope.module === module);
    if (!moduleScope) {
      continue;
    }
    const moduleStart = document.offsetAt(module.headerEnd);
    const moduleEnd = document.offsetAt(module.endmoduleRange?.start ?? module.range.end);
    const moduleTokens = tokens.filter((token) => token.start >= moduleStart && token.start < moduleEnd && token.kind !== 'eof');
    const stack: VerilogSemanticScope[] = [];
    const parentScope = (): VerilogSemanticScope => stack[stack.length - 1] ?? moduleScope;
    for (let index = 0; index < moduleTokens.length; index++) {
      const token = moduleTokens[index];
      if (token.value === 'for') {
        const end = forScopeEnd(moduleTokens, index, moduleEnd);
        const scope = makeBlockScope(document, module, parentScope(), token, end);
        parentScope().children.push(scope);
        result.push(scope);
        continue;
      }
      const opener = blockScopeOpener(token.value);
      if (opener) {
        const scope = makeBlockScope(document, module, parentScope(), token, moduleEnd);
        scope.name = opener;
        parentScope().children.push(scope);
        result.push(scope);
        stack.push(scope);
        continue;
      }
      const closer = blockScopeCloser(token.value);
      if (!closer) {
        continue;
      }
      for (let cursor = stack.length - 1; cursor >= 0; cursor--) {
        const candidate = stack[cursor];
        if (candidate.name !== closer && !((closer === 'begin' || closer === 'case') && candidate.name === closer)) {
          continue;
        }
        candidate.range = Range.create(candidate.range.start, document.positionAt(token.end));
        stack.length = cursor;
        break;
      }
    }
  }
  return result;
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

function blockScopeOpener(value: string): 'begin' | 'case' | 'task' | 'function' | undefined {
  if (value === 'begin') {
    return 'begin';
  }
  if (value === 'case' || value === 'casex' || value === 'casez') {
    return 'case';
  }
  if (value === 'task' || value === 'function') {
    return value;
  }
  return undefined;
}

function blockScopeCloser(value: string): 'begin' | 'case' | 'task' | 'function' | undefined {
  if (value === 'end') {
    return 'begin';
  }
  if (value === 'endcase') {
    return 'case';
  }
  if (value === 'endtask') {
    return 'task';
  }
  if (value === 'endfunction') {
    return 'function';
  }
  return undefined;
}

function forScopeEnd(tokens: VerilogToken[], forIndex: number, moduleEnd: number): number {
  const open = nextTokenValue(tokens, forIndex + 1, '(');
  if (open < 0) {
    return tokens[forIndex].end;
  }
  const close = findMatchingToken(tokens, open, '(', ')');
  if (close < 0) {
    return tokens[open].end;
  }
  const bodyStart = close + 1;
  if (tokens[bodyStart]?.value === 'begin') {
    const end = findMatchingToken(tokens, bodyStart, 'begin', 'end');
    return end >= 0 ? tokens[end].end : moduleEnd;
  }
  const semicolon = findStatementSemicolon(tokens, bodyStart);
  return semicolon >= 0 ? tokens[semicolon].end : tokens[close].end;
}

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

function findStatementSemicolon(tokens: VerilogToken[], start: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = start; index < tokens.length; index++) {
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
      return index;
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

function makeBlockScope(
  document: TextDocument,
  module: VerilogModule,
  parent: VerilogSemanticScope,
  open: VerilogToken,
  endOffset: number
): VerilogSemanticScope {
  return {
    kind: 'block',
    name: open.value,
    range: Range.create(document.positionAt(open.start), document.positionAt(endOffset)),
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
  tokens: VerilogToken[],
  module: VerilogModule,
  blockScopes: VerilogSemanticScope[]
): VerilogDecl[] {
  const result: VerilogDecl[] = [];
  const moduleBlockScopes = blockScopes.filter((scope) => scope.module === module);
  for (const scope of moduleBlockScopes) {
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
  return dedupeDecls(result);
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
  blockScopes: VerilogSemanticScope[],
  moduleStart: number,
  moduleEnd: number
): void {
  const moduleAst = source.ast.modules.find((item) => item.module === module);
  for (const statement of source.ast.cst.statements) {
    if (statement.start < moduleStart || statement.end > moduleEnd) {
      continue;
    }
    const tokens = statement.tokens.filter((token) => token.kind !== 'eof');
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
        const scope = scopeAtPosition(moduleScope, blockScopes, statement.range.start);
        const expressionTokens = tokens.slice(equal + 1);
        collectReferencesFromExpressionTokens(document, references, declarationRangeKeys, scope, module, expressionTokens);
        collectReferencesFromTokens(document, source, references, declarationRangeKeys, scope, module, expressionTokens);
      }
      continue;
    }
    if (looksLikeInstanceStatement(module, tokens)) {
      continue;
    }
    const scope = scopeAtPosition(moduleScope, blockScopes, statement.range.start);
    const statementAst = moduleAst?.items.find((item) => item.statement === statement);
    if (statementAst) {
      for (const expression of statementAst.expressions) {
        collectReferencesFromExpressionAst(document, references, declarationRangeKeys, scope, module, expression, 0);
      }
    }
    collectReferencesFromTokens(document, source, references, declarationRangeKeys, scope, module, tokens);
  }
}

function collectReferencesFromConnectionExpression(
  document: TextDocument,
  source: VerilogSemanticSource,
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
    return;
  }
  collectReferencesFromExpressionText(document, references, declarationRangeKeys, scope, module, connection.expression, connection.expressionRange);
  collectReferencesFromRange(document, source, references, declarationRangeKeys, scope, module, connection.expressionRange);
}

function collectReferencesFromRange(
  document: TextDocument,
  source: VerilogSemanticSource,
  references: VerilogSemanticReference[],
  declarationRangeKeys: Set<string>,
  scope: VerilogSemanticScope,
  module: VerilogModule,
  range: Range
): void {
  const start = document.offsetAt(range.start);
  const end = document.offsetAt(range.end);
  const tokens = source.ast.cst.codeTokens.filter((token) => token.start >= start && token.end <= end);
  collectReferencesFromTokens(document, source, references, declarationRangeKeys, scope, module, tokens);
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
  const text = document.getText(Range.create(
    document.positionAt(expressionTokens[0].start),
    document.positionAt(expressionTokens[expressionTokens.length - 1].end)
  ));
  const expression = parseVerilogExpression(text);
  if (!expression) {
    return;
  }
  collectReferencesFromExpressionAst(document, references, declarationRangeKeys, scope, module, expression, expressionTokens[0].start);
}

function collectReferencesFromExpressionText(
  document: TextDocument,
  references: VerilogSemanticReference[],
  declarationRangeKeys: Set<string>,
  scope: VerilogSemanticScope,
  module: VerilogModule,
  text: string,
  range: Range
): void {
  if (!text.trim()) {
    return;
  }
  const expression = parseVerilogExpression(text);
  if (!expression) {
    return;
  }
  collectReferencesFromExpressionAst(
    document,
    references,
    declarationRangeKeys,
    scope,
    module,
    expression,
    expressionBaseOffset(document, range, text)
  );
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
  if (declarationRangeKeys.has(rangeKey(range)) || references.some((reference) => rangesEqual(reference.range, range))) {
    return;
  }
  const symbol = resolveIdentifierInScope(scope, name);
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

function expressionBaseOffset(document: TextDocument, range: Range, expressionText: string): number {
  const rangeStart = document.offsetAt(range.start);
  const rangeText = document.getText(range);
  const index = rangeText.indexOf(expressionText);
  return rangeStart + Math.max(0, index);
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
