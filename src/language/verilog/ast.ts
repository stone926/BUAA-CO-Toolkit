import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { rangesEqual } from '../common/lsp';
import { VerilogLexDiagnostic, VerilogToken } from './lexer';
import {
  VerilogDecl,
  VerilogDirective,
  VerilogInclude,
  VerilogInstance,
  VerilogMacro,
  VerilogMacroUse,
  VerilogModule
} from './model';
import {
  collectAlwaysBlocksFromTokens,
  collectProceduralBlocksFromTokens,
  VerilogAlwaysBlockAst,
  VerilogProceduralBlockAst
} from './blockAst';
import { parseAssignmentTokens } from './assignmentAnalysis';
import { parseVerilogExpressionTokens, VerilogExpressionAst } from './exprAst';
import { isVerilogGatePrimitive } from './gatePrimitives';
import { parseVerilogProceduralBlockBody, VerilogBlockStatementAst } from './proceduralAst';
import type { VerilogStatementSource } from './statementParser';
import {
  findMatchingTokenForward,
  splitTopLevelTokens,
  trimTrailingSemicolonTokens
} from './tokenUtils';
import { verilogDeclarationKeywords } from './declarations';

export interface VerilogAstDocument {
  kind: 'sourceFile';
  uri: string;
  range: Range;
  tokens: VerilogToken[];
  lexicalDiagnostics: VerilogLexDiagnostic[];
  trivia: VerilogTriviaAst[];
  preprocessor: VerilogPreprocessorAst[];
  modules: VerilogModuleAst[];
  topLevelStatements: VerilogStatementAst[];
}

export interface VerilogAstSource {
  tokens: VerilogToken[];
  allTokens: VerilogToken[];
  lexicalDiagnostics: VerilogLexDiagnostic[];
  statements: VerilogStatementSource[];
}

export interface VerilogTriviaAst {
  kind: 'comment' | 'string';
  range: Range;
}

export type VerilogPreprocessorAst =
  | VerilogMacroDefinitionAst
  | VerilogMacroUseAst
  | VerilogIncludeAst
  | VerilogDirectiveAst;

export interface VerilogMacroDefinitionAst {
  kind: 'macroDefinition';
  name: string;
  range: Range;
  selectionRange: Range;
  macro: VerilogMacro;
}

export interface VerilogMacroUseAst {
  kind: 'macroUse';
  name: string;
  range: Range;
  selectionRange: Range;
  macroUse: VerilogMacroUse;
}

export interface VerilogIncludeAst {
  kind: 'include';
  path: string;
  range: Range;
  pathRange: Range;
  include: VerilogInclude;
}

export interface VerilogDirectiveAst {
  kind: 'directive';
  name: string;
  argument?: string;
  range: Range;
  selectionRange: Range;
  argumentRange?: Range;
  directive: VerilogDirective;
}

export interface VerilogModuleAst {
  kind: 'module';
  name: string;
  range: Range;
  selectionRange: Range;
  headerRange: Range;
  bodyRange: Range;
  ports: VerilogDeclAst[];
  parameters: VerilogDeclAst[];
  declarations: VerilogDeclAst[];
  instances: VerilogInstanceAst[];
  alwaysBlocks: VerilogAlwaysBlockAst[];
  proceduralBlocks: VerilogProceduralBlockAst[];
  subroutines: VerilogSubroutineAst[];
  items: VerilogStatementAst[];
  module: VerilogModule;
}

export interface VerilogDeclAst {
  kind: 'declaration';
  name: string;
  range: Range;
  selectionRange: Range;
  decl: VerilogDecl;
}

export interface VerilogInstanceAst {
  kind: 'instance';
  moduleName: string;
  instanceName: string;
  range: Range;
  moduleSelectionRange: Range;
  selectionRange: Range;
  instance: VerilogInstance;
}

export interface VerilogSubroutineAst {
  kind: 'subroutine';
  subroutineKind: 'task' | 'function';
  name?: string;
  range: Range;
  headerRange: Range;
  bodyRange: Range;
  tokens: VerilogToken[];
  bodyTokens: VerilogToken[];
  statementTree: VerilogBlockStatementAst;
}

export type VerilogStatementKind =
  | 'declaration'
  | 'continuousAssign'
  | 'proceduralBlock'
  | 'gatePrimitive'
  | 'instance'
  | 'preprocessor'
  | 'moduleHeader'
  | 'other';

export interface VerilogStatementAst {
  kind: VerilogStatementKind;
  range: Range;
  start: number;
  end: number;
  tokens: VerilogToken[];
  expressions: VerilogExpressionAst[];
  assignment?: VerilogAssignmentExpressionAst;
  module?: VerilogModule;
}

export interface VerilogAssignmentExpressionAst {
  operator: '=' | '<=';
  lhs: VerilogExpressionAst;
  rhs: VerilogExpressionAst;
}

export function buildVerilogAst(
  document: TextDocument,
  source: VerilogAstSource,
  modules: VerilogModule[],
  macros: VerilogMacro[],
  macroUses: VerilogMacroUse[],
  includes: VerilogInclude[],
  directives: VerilogDirective[]
): VerilogAstDocument {
  const moduleAsts = modules.map((module) => buildModuleAst(document, source.statements, source.tokens, module));
  const moduleRanges = moduleAsts.map((module) => module.range);
  return {
    kind: 'sourceFile',
    uri: document.uri,
    range: documentRange(document),
    tokens: source.tokens,
    lexicalDiagnostics: source.lexicalDiagnostics,
    trivia: source.allTokens
      .filter((token): token is VerilogToken & { kind: 'comment' | 'string' } => token.kind === 'comment' || token.kind === 'string')
      .map((token): VerilogTriviaAst => ({
        kind: token.kind,
        range: Range.create(document.positionAt(token.start), document.positionAt(token.end))
      })),
    preprocessor: [
      ...macros.map((macro): VerilogMacroDefinitionAst => ({
        kind: 'macroDefinition',
        name: macro.name,
        range: macro.range,
        selectionRange: macro.selectionRange,
        macro
      })),
      ...macroUses.map((macroUse): VerilogMacroUseAst => ({
        kind: 'macroUse',
        name: macroUse.name,
        range: macroUse.range,
        selectionRange: macroUse.selectionRange,
        macroUse
      })),
      ...includes.map((include): VerilogIncludeAst => ({
        kind: 'include',
        path: include.path,
        range: include.range,
        pathRange: include.pathRange,
        include
      })),
      ...directives.map((directive): VerilogDirectiveAst => ({
        kind: 'directive',
        name: directive.name,
        argument: directive.argument,
        range: directive.range,
        selectionRange: directive.selectionRange,
        argumentRange: directive.argumentRange,
        directive
      }))
    ],
    modules: moduleAsts,
    topLevelStatements: source.statements
      .filter((statement) => !moduleRanges.some((range) => containsRange(range, statement.range)))
      .map((statement) => buildStatementAst(statement))
  };
}

function buildModuleAst(document: TextDocument, statements: VerilogStatementSource[], tokens: VerilogToken[], module: VerilogModule): VerilogModuleAst {
  const headerRange = Range.create(module.range.start, module.headerEnd);
  const bodyRange = Range.create(module.headerEnd, module.endmoduleRange?.start ?? module.range.end);
  const items = statements
    .filter((statement) => containsRange(module.range, statement.range))
    .map((statement) => buildStatementAst(statement, module));
  return {
    kind: 'module',
    name: module.name,
    range: module.range,
    selectionRange: module.selectionRange,
    headerRange,
    bodyRange,
    ports: module.ports.map((decl) => declAst(decl)),
    parameters: module.parameters.map((decl) => declAst(decl)),
    declarations: [...module.declarations.values()].map((decl) => declAst(decl)),
    instances: module.instances.map((instance) => ({
      kind: 'instance',
      moduleName: instance.moduleName,
      instanceName: instance.instanceName,
      range: instance.range,
      moduleSelectionRange: instance.moduleSelectionRange,
      selectionRange: instance.selectionRange,
      instance
    })),
    alwaysBlocks: collectAlwaysBlocksFromTokens(document, tokens, module),
    proceduralBlocks: collectProceduralBlocksFromTokens(document, tokens, module),
    subroutines: collectSubroutineAsts(document, tokens, module),
    items,
    module
  };
}

function declAst(decl: VerilogDecl): VerilogDeclAst {
  return {
    kind: 'declaration',
    name: decl.name,
    range: decl.range,
    selectionRange: decl.selectionRange,
    decl
  };
}

function buildStatementAst(statement: VerilogStatementSource, module?: VerilogModule): VerilogStatementAst {
  const kind = classifyStatement(statement, module);
  const assignment = statementExpressionAsts(statement.tokens, kind);
  return {
    kind,
    range: statement.range,
    start: statement.start,
    end: statement.end,
    tokens: statement.tokens,
    expressions: assignment.expressions,
    assignment: assignment.assignment,
    module
  };
}

function statementExpressionAsts(rawTokens: VerilogToken[], kind: VerilogStatementKind): {
  assignment?: VerilogAssignmentExpressionAst;
  expressions: VerilogExpressionAst[];
} {
  const parsed = parseAssignmentTokens(rawTokens);
  if (!parsed) {
    return {
      expressions: kind === 'gatePrimitive' ? gatePrimitiveExpressionAsts(rawTokens) : []
    };
  }
  const lhs = parseVerilogExpressionTokens(parsed.lhsTokens);
  const rhs = parseVerilogExpressionTokens(parsed.rhsTokens);
  return {
    assignment: lhs && rhs ? { operator: parsed.operator, lhs, rhs } : undefined,
    expressions: [lhs, rhs].filter((expression): expression is VerilogExpressionAst => Boolean(expression))
  };
}

function gatePrimitiveExpressionAsts(rawTokens: VerilogToken[]): VerilogExpressionAst[] {
  const tokens = trimTrailingSemicolonTokens(rawTokens);
  const primitive = tokens[0];
  if (!primitive || !isVerilogGatePrimitive(primitive.value)) {
    return [];
  }
  return splitTopLevelTokens(tokens.slice(1), ',')
    .flatMap((instanceTokens) => gatePrimitivePortExpressions(instanceTokens));
}

function gatePrimitivePortExpressions(tokens: VerilogToken[]): VerilogExpressionAst[] {
  const open = gatePrimitivePortListOpen(tokens);
  if (open < 0) {
    return [];
  }
  const close = findMatchingTokenForward(tokens, open, '(', ')');
  if (close < 0) {
    return [];
  }
  return splitTopLevelTokens(tokens.slice(open + 1, close), ',')
    .map((part) => parseVerilogExpressionTokens(part))
    .filter((expression): expression is VerilogExpressionAst => Boolean(expression));
}

function gatePrimitivePortListOpen(tokens: VerilogToken[]): number {
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== '(') {
      continue;
    }
    const close = findMatchingTokenForward(tokens, index, '(', ')');
    if (close === tokens.length - 1) {
      return index;
    }
  }
  return -1;
}

function collectSubroutineAsts(document: TextDocument, tokens: VerilogToken[], module: VerilogModule): VerilogSubroutineAst[] {
  const moduleStart = document.offsetAt(module.headerEnd);
  const moduleEnd = document.offsetAt(module.endmoduleRange?.start ?? module.range.end);
  const moduleTokens = tokens.filter((token) => token.start >= moduleStart && token.start < moduleEnd && token.kind !== 'eof');
  const subroutines: VerilogSubroutineAst[] = [];
  for (let index = 0; index < moduleTokens.length; index++) {
    const token = moduleTokens[index];
    if (token.value !== 'task' && token.value !== 'function') {
      continue;
    }
    const close = findSubroutineEndToken(moduleTokens, index);
    const endIndex = close >= 0 ? close : moduleTokens.length - 1;
    const subroutineTokens = moduleTokens.slice(index, endIndex + 1);
    const headerEnd = findTopLevelSemicolon(moduleTokens, index + 1, endIndex + 1);
    const bodyStart = headerEnd >= 0 ? headerEnd + 1 : index + 1;
    const bodyEnd = close >= 0 ? close : endIndex + 1;
    const bodyTokens = moduleTokens.slice(bodyStart, bodyEnd);
    const headerEndOffset = headerEnd >= 0
      ? moduleTokens[headerEnd].end
      : (moduleTokens[bodyStart]?.start ?? token.end);
    const bodyStartOffset = bodyTokens[0]?.start ?? headerEndOffset;
    const bodyEndOffset = bodyTokens[bodyTokens.length - 1]?.end ?? bodyStartOffset;
    const endToken = moduleTokens[endIndex] ?? token;
    subroutines.push({
      kind: 'subroutine',
      subroutineKind: token.value,
      name: subroutineName(moduleTokens, index, headerEnd >= 0 ? headerEnd : endIndex + 1),
      range: Range.create(document.positionAt(token.start), document.positionAt(endToken.end)),
      headerRange: Range.create(document.positionAt(token.start), document.positionAt(headerEndOffset)),
      bodyRange: Range.create(document.positionAt(bodyStartOffset), document.positionAt(bodyEndOffset)),
      tokens: subroutineTokens,
      bodyTokens,
      statementTree: parseVerilogProceduralBlockBody(document, bodyTokens)
    });
    if (close >= 0) {
      index = close;
    }
  }
  return subroutines;
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

function findTopLevelSemicolon(tokens: VerilogToken[], start: number, end: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = start; index < end; index++) {
    const value = tokens[index].value;
    if (value === '(') {
      paren++;
    } else if (value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (value === '[') {
      bracket++;
    } else if (value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (value === '{') {
      brace++;
    } else if (value === '}') {
      brace = Math.max(0, brace - 1);
    } else if (value === ';' && paren === 0 && bracket === 0 && brace === 0) {
      return index;
    }
  }
  return -1;
}

function subroutineName(tokens: VerilogToken[], start: number, end: number): string | undefined {
  const paren = tokens.findIndex((token, index) => index > start && index < end && token.value === '(');
  const limit = paren >= 0 ? paren : end;
  for (let index = limit - 1; index > start; index--) {
    if (tokens[index].kind === 'identifier') {
      return tokens[index].value;
    }
  }
  return undefined;
}

function classifyStatement(statement: VerilogStatementSource, module?: VerilogModule): VerilogStatementKind {
  const tokens = statement.tokens;
  const first = tokens.find((token) => token.kind !== 'eof');
  if (!first) {
    return 'other';
  }
  if (first.kind === 'directive') {
    return 'preprocessor';
  }
  if (isVerilogGatePrimitive(first.value)) {
    return 'gatePrimitive';
  }
  if (module && module.instances.some((instance) => rangesEqual(instance.range, statement.range))) {
    return 'instance';
  }
  if (first.value === 'module') {
    return 'moduleHeader';
  }
  if (verilogDeclarationKeywords.has(first.value)) {
    return 'declaration';
  }
  if (first.value === 'assign') {
    return 'continuousAssign';
  }
  if (first.value === 'always' || first.value === 'initial') {
    return 'proceduralBlock';
  }
  return 'other';
}

function containsRange(outer: Range, inner: Range): boolean {
  return comparePosition(outer.start, inner.start) <= 0 && comparePosition(outer.end, inner.end) >= 0;
}

function comparePosition(left: { line: number; character: number }, right: { line: number; character: number }): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.character - right.character;
}

function documentRange(document: TextDocument): Range {
  const lines = document.getText().split(/\r?\n/);
  const lastLine = Math.max(0, lines.length - 1);
  return Range.create(0, 0, lastLine, lines[lastLine]?.length ?? 0);
}
