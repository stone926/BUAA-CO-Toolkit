import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  VerilogCstDocument,
  VerilogCstStatement
} from './cst';
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
  collectAlwaysBlocksFromCst,
  collectProceduralBlocksFromCst,
  VerilogAlwaysBlockAst,
  VerilogProceduralBlockAst
} from './blockAst';
import { parseAssignmentTokens } from './assignmentAnalysis';
import { parseVerilogExpressionTokens, VerilogExpressionAst } from './exprAst';

export interface VerilogAstDocument {
  kind: 'sourceFile';
  uri: string;
  range: Range;
  cst: VerilogCstDocument;
  tokens: VerilogToken[];
  lexicalDiagnostics: VerilogLexDiagnostic[];
  trivia: VerilogTriviaAst[];
  preprocessor: VerilogPreprocessorAst[];
  modules: VerilogModuleAst[];
  topLevelStatements: VerilogStatementAst[];
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
  includes: VerilogInclude[],
  directives: VerilogDirective[]
): VerilogAstDocument {
  const moduleAsts = modules.map((module) => buildModuleAst(document, cst, module));
  const moduleRanges = moduleAsts.map((module) => module.range);
  return {
    kind: 'sourceFile',
    uri: document.uri,
    range: documentRange(document),
    cst,
    tokens: cst.codeTokens,
    lexicalDiagnostics: cst.diagnostics,
    trivia: cst.tokens
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
  const parsed = parseAssignmentTokens(rawTokens);
  if (!parsed) {
    return undefined;
  }
  const lhs = parseVerilogExpressionTokens(parsed.lhsTokens);
  const rhs = parseVerilogExpressionTokens(parsed.rhsTokens);
  return lhs && rhs ? { operator: parsed.operator, lhs, rhs } : undefined;
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
