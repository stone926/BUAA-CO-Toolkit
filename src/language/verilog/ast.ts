import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  VerilogCstDocument,
  VerilogCstStatement
} from './cst';
import { VerilogToken } from './lexer';
import {
  VerilogDecl,
  VerilogInclude,
  VerilogInstance,
  VerilogMacro,
  VerilogMacroUse,
  VerilogModule
} from './model';
import {
  collectAlwaysBlocksFromCst,
  collectProceduralBlocksFromCst,
  VerilogAlwaysBlockAst,
  VerilogProceduralBlockAst
} from './blockAst';
import { findAssignmentOperator } from './assignmentAnalysis';
import { parseVerilogExpressionTokens, VerilogExpressionAst } from './exprAst';

export interface VerilogAstDocument {
  kind: 'sourceFile';
  uri: string;
  range: Range;
  cst: VerilogCstDocument;
  preprocessor: VerilogPreprocessorAst[];
  modules: VerilogModuleAst[];
  topLevelStatements: VerilogStatementAst[];
}

export type VerilogPreprocessorAst =
  | VerilogMacroDefinitionAst
  | VerilogMacroUseAst
  | VerilogIncludeAst;

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

export type VerilogStatementKind =
  | 'declaration'
  | 'continuousAssign'
  | 'proceduralBlock'
  | 'instance'
  | 'preprocessor'
  | 'moduleHeader'
  | 'other';

export interface VerilogStatementAst {
  kind: VerilogStatementKind;
  range: Range;
  tokens: VerilogToken[];
  expressions: VerilogExpressionAst[];
  assignment?: VerilogAssignmentExpressionAst;
  statement: VerilogCstStatement;
  module?: VerilogModule;
}

export interface VerilogAssignmentExpressionAst {
  operator: '=' | '<=';
  lhs: VerilogExpressionAst;
  rhs: VerilogExpressionAst;
}

const declarationKeywords = new Set([
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

export function buildVerilogAst(
  document: TextDocument,
  cst: VerilogCstDocument,
  modules: VerilogModule[],
  macros: VerilogMacro[],
  macroUses: VerilogMacroUse[],
  includes: VerilogInclude[]
): VerilogAstDocument {
  const moduleAsts = modules.map((module) => buildModuleAst(document, cst, module));
  const moduleRanges = moduleAsts.map((module) => module.range);
  return {
    kind: 'sourceFile',
    uri: document.uri,
    range: documentRange(document),
    cst,
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
      }))
    ],
    modules: moduleAsts,
    topLevelStatements: cst.statements
      .filter((statement) => !moduleRanges.some((range) => containsRange(range, statement.range)))
      .map((statement) => buildStatementAst(statement))
  };
}

function buildModuleAst(document: TextDocument, cst: VerilogCstDocument, module: VerilogModule): VerilogModuleAst {
  const headerRange = Range.create(module.range.start, module.headerEnd);
  const bodyRange = Range.create(module.headerEnd, module.endmoduleRange?.start ?? module.range.end);
  const items = cst.statements
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
    alwaysBlocks: collectAlwaysBlocksFromCst(document, cst, module),
    proceduralBlocks: collectProceduralBlocksFromCst(document, cst, module),
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

function buildStatementAst(statement: VerilogCstStatement, module?: VerilogModule): VerilogStatementAst {
  const assignment = assignmentExpressionAst(statement.tokens);
  return {
    kind: classifyStatement(statement, module),
    range: statement.range,
    tokens: statement.tokens,
    expressions: assignment ? [assignment.lhs, assignment.rhs] : [],
    assignment,
    statement,
    module
  };
}

function assignmentExpressionAst(rawTokens: VerilogToken[]): VerilogAssignmentExpressionAst | undefined {
  const tokens = trimTrailingSemicolon(rawTokens.filter((token) => token.kind !== 'eof'));
  const operatorIndex = findAssignmentOperator(tokens);
  if (operatorIndex < 0 || isDeclarationStatement(tokens)) {
    return undefined;
  }
  const operator = tokens[operatorIndex].value;
  if (operator !== '=' && operator !== '<=') {
    return undefined;
  }
  const lhsStart = assignmentLhsStart(tokens, operatorIndex);
  const lhsTokens = tokens.slice(lhsStart, operatorIndex);
  const rhsTokens = tokens.slice(operatorIndex + 1);
  const lhs = parseVerilogExpressionTokens(lhsTokens);
  const rhs = parseVerilogExpressionTokens(rhsTokens);
  return lhs && rhs ? { operator, lhs, rhs } : undefined;
}

function assignmentLhsStart(tokens: VerilogToken[], operatorIndex: number): number {
  if (tokens[0]?.value === 'assign') {
    return 1;
  }
  let start = 0;
  while (start < operatorIndex) {
    const token = tokens[start];
    if (token.value === 'if' || token.value === 'while' || token.value === 'repeat' || token.value === 'for') {
      const open = nextTokenIndex(tokens, start + 1, '(');
      if (open < 0) {
        return start;
      }
      const close = findMatchingToken(tokens, open, '(', ')');
      if (close < 0 || close >= operatorIndex) {
        return start;
      }
      start = close + 1;
      continue;
    }
    if (token.value === 'forever') {
      start++;
      continue;
    }
    if (token.value === '#') {
      const next = skipDelayControl(tokens, start);
      if (next <= start || next > operatorIndex) {
        return start;
      }
      start = next;
      continue;
    }
    break;
  }

  const label = lastTopLevelToken(tokens, ':', start, operatorIndex);
  if (label >= 0) {
    start = label + 1;
  }

  while (tokens[start]?.value === '#') {
    const next = skipDelayControl(tokens, start);
    if (next <= start || next > operatorIndex) {
      break;
    }
    start = next;
  }
  return start;
}

function isDeclarationStatement(tokens: VerilogToken[]): boolean {
  const first = tokens.find((token) => token.kind !== 'eof');
  return Boolean(first && declarationKeywords.has(first.value));
}

function skipDelayControl(tokens: VerilogToken[], hashIndex: number): number {
  if (tokens[hashIndex + 1]?.value === '(') {
    const close = findMatchingToken(tokens, hashIndex + 1, '(', ')');
    return close >= 0 ? close + 1 : hashIndex + 2;
  }
  return Math.min(tokens.length, hashIndex + 2);
}

function nextTokenIndex(tokens: VerilogToken[], start: number, value: string): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].value === value) {
      return index;
    }
  }
  return -1;
}

function findMatchingToken(tokens: VerilogToken[], openIndex: number, openValue: string, closeValue: string): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    if (tokens[index].value === openValue) {
      depth++;
    } else if (tokens[index].value === closeValue) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function lastTopLevelToken(tokens: VerilogToken[], value: string, from: number, to: number): number {
  let result = -1;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = from; index < to; index++) {
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
    } else if (token.value === value && paren === 0 && bracket === 0 && brace === 0) {
      result = index;
    }
  }
  return result;
}

function classifyStatement(statement: VerilogCstStatement, module?: VerilogModule): VerilogStatementKind {
  const first = statement.tokens.find((token) => token.kind !== 'eof');
  if (!first) {
    return 'other';
  }
  if (first.kind === 'directive') {
    return 'preprocessor';
  }
  if (first.value === 'module') {
    return 'moduleHeader';
  }
  if (declarationKeywords.has(first.value)) {
    return 'declaration';
  }
  if (first.value === 'assign') {
    return 'continuousAssign';
  }
  if (first.value === 'always' || first.value === 'initial') {
    return 'proceduralBlock';
  }
  if (module && first.kind === 'identifier' && first.value !== module.name) {
    return 'instance';
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

function trimTrailingSemicolon(tokens: VerilogToken[]): VerilogToken[] {
  return tokens[tokens.length - 1]?.value === ';' ? tokens.slice(0, -1) : tokens;
}
