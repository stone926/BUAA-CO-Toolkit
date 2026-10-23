import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsRange, makeDiagnostic } from '../common/lsp';
import { continuousAssignmentParts, isVerilogLvalueExpression, parseAssignmentTokens } from './assignmentAnalysis';
import { VerilogAstDocument, VerilogModuleAst, VerilogStatementAst, VerilogSubroutineAst } from './ast';
import { verilogAstCodeTokens } from './astTokens';
import { VerilogProceduralBlockAst } from './blockAst';
import { parseVerilogExpressionTokens, parseVerilogNumberLiteral, verilogExpressionHasError } from './exprAst';
import { declarationRangeSyntaxIssues, expressionSyntaxIssues, mintypmaxExpressionSyntaxIssues, ExpressionSyntaxIssue } from './syntaxExpressionValidation';
import { isVerilogGatePrimitive } from './gatePrimitives';
import { instanceDeclaratorPortIndex, splitInstanceTokenGroup } from './instanceSyntax';
import { stripDriveStrength } from './driveStrength';
import { isIdentifierLike, VerilogToken } from './lexer';
import { systemTasks, VerilogModule, verilogKeywords } from './model';
import {
  verilogDeclarationKeywords,
  verilogDeclarationModifiers,
  verilogDeclarationPrefixKeywords,
  verilogParameterTypeKeywords,
  verilogPortDeclarationTypes,
  verilogPortDirections
} from './declarations';
import {
  findMatchingTokenForward as findMatchingToken,
  findTopLevelToken as firstTopLevelToken,
  findTopLevelTokenIndexes as topLevelIndexes,
  nextSignificantTokenIndex,
  splitTopLevelTokens as splitTopLevel,
  stripLeadingGenerateBlockLabelTokens,
  trimTrailingSemicolonTokens as trimTrailingSemicolon
} from './tokenUtils';

export type VerilogSyntaxNodeKind =
  | 'sourceFile'
  | 'module'
  | 'declaration'
  | 'continuousAssign'
  | 'proceduralBlock'
  | 'blockStatement'
  | 'if'
  | 'case'
  | 'for'
  | 'generate'
  | 'task'
  | 'instance'
  | 'gatePrimitive'
  | 'expression';

export interface VerilogSyntaxNode {
  kind: VerilogSyntaxNodeKind;
  range: Range;
  children: VerilogSyntaxNode[];
}

export interface VerilogSyntaxParseResult {
  root: VerilogSyntaxNode;
  diagnostics: Diagnostic[];
}

const unsupportedConstructs = new Set([
  'specify',
  'primitive',
  'defparam',
  'fork',
  'event'
]);

interface GenerateBlockRange {
  start: number;
  end: number;
  tokens: VerilogToken[];
}

export function parseVerilogSyntax(
  document: TextDocument,
  ast: VerilogAstDocument,
  modules: VerilogModule[]
): VerilogSyntaxParseResult {
  const diagnostics: Diagnostic[] = [];
  const tokens = verilogAstCodeTokens(ast);
  const root: VerilogSyntaxNode = {
    kind: 'sourceFile',
    range: documentRange(document),
    children: []
  };
  collectNumberLiteralDiagnostics(document, tokens, diagnostics);
  collectUnsupportedConstructDiagnostics(document, tokens, diagnostics);

  for (const module of modules) {
    const moduleAst = ast.modules.find((item) => item.module === module);
    if (!moduleAst) {
      continue;
    }
    const moduleNode: VerilogSyntaxNode = {
      kind: 'module',
      range: module.range,
      children: []
    };
    root.children.push(moduleNode);
    collectModuleHeaderDiagnostics(document, tokens, moduleAst, diagnostics);
    collectModuleItemDiagnostics(document, tokens, moduleAst, moduleNode, diagnostics);
  }

  collectOrphanControlDiagnostics(document, tokens, diagnostics);
  return { root, diagnostics: dedupeDiagnostics(diagnostics) };
}

function collectModuleHeaderDiagnostics(
  document: TextDocument,
  tokens: VerilogToken[],
  moduleAst: VerilogModuleAst,
  diagnostics: Diagnostic[]
): void {
  const module = moduleAst.module;
  const moduleStart = document.offsetAt(module.range.start);
  const headerEnd = document.offsetAt(module.headerEnd);
  const headerTokens = tokens.filter((token) =>
    token.start >= moduleStart &&
    token.end <= headerEnd &&
    token.kind !== 'eof'
  );
  let headerDepth = 0;
  for (const token of headerTokens) {
    if (token.value === '(') headerDepth++;
    if (token.value === ')') headerDepth--;
  }
  if (headerTokens[headerTokens.length - 1]?.value !== ';' || headerDepth !== 0) {
    diagnostics.push(makeDiagnostic(module.selectionRange,
      'Syntax error: module header requires balanced parentheses followed by a semicolon.',
      DiagnosticSeverity.Error, 'syntax-module-declaration'));
  }
  const lists = moduleHeaderLists(headerTokens);
  if (lists.parameters) {
    validateDeclarationList(document, headerTokens.slice(lists.parameters[0] + 1, lists.parameters[1]), diagnostics, false, true);
  }
  if (lists.ports) validateModulePortList(document, headerTokens.slice(lists.ports[0] + 1, lists.ports[1]), diagnostics);
}

function moduleHeaderLists(tokens: VerilogToken[]): { parameters?: [number, number]; ports?: [number, number] } {
  const result: { parameters?: [number, number]; ports?: [number, number] } = {};
  const moduleIndex = tokens.findIndex((token) => token.value === 'module');
  if (moduleIndex < 0) return result;
  const nameIndex = nextSignificantTokenIndex(tokens, moduleIndex + 1);
  if (nameIndex < 0 || tokens[nameIndex].kind !== 'identifier') return result;
  let index = nextSignificantTokenIndex(tokens, nameIndex + 1);
  if (index < 0) return result;
  if (tokens[index].value === '#') {
    const open = nextSignificantTokenIndex(tokens, index + 1);
    if (open < 0 || tokens[open].value !== '(') return result;
    const close = findMatchingToken(tokens, open, '(', ')');
    if (close < 0) return result;
    result.parameters = [open, close];
    index = nextSignificantTokenIndex(tokens, close + 1);
  }
  if (tokens[index]?.value === '(') {
    const close = findMatchingToken(tokens, index, '(', ')');
    if (close >= 0) result.ports = [index, close];
  }
  return result;
}

function validateModulePortList(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[], subroutine = false): void {
  let inheritsDeclarationPrefix = false;
  for (const part of splitTopLevel(tokens, ',')) {
    const directionIndexes = topLevelPortDirectionIndexes(part);
    if (directionIndexes.length > 1) {
      const direction = part[directionIndexes[1]];
      diagnostics.push(makeDiagnostic(
        tokenRange(document, direction),
        `Syntax error: unexpected port direction '${direction.value}' in the same module port declaration. Did you forget a comma?`,
        DiagnosticSeverity.Error,
        'syntax-malformed-port-list'
      ));
      continue;
    }
    if (directionIndexes.length === 1) {
      if (directionIndexes[0] !== 0) {
        const direction = part[directionIndexes[0]];
        diagnostics.push(makeDiagnostic(
          tokenRange(document, direction),
          `Syntax error: port direction '${direction.value}' must start a module port declaration.`,
          DiagnosticSeverity.Error,
          'syntax-malformed-port-list'
        ));
        continue;
      }
      inheritsDeclarationPrefix = true;
      validateModulePortDeclaration(document, part, diagnostics, subroutine);
      continue;
    }
    if (inheritsDeclarationPrefix && looksLikeInheritedPortDeclarator(part)) {
      validateModulePortDeclarator(document, part, diagnostics);
    }
  }
}

function validateModulePortDeclaration(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[], subroutine: boolean): void {
  const declaratorStart = modulePortDeclaratorStart(document, tokens, diagnostics, subroutine);
  if (declaratorStart < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[tokens.length - 1] ?? tokens[0]),
      `Syntax error: '${tokens[0].value}' port declaration is missing a port name.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-port-list'
    ));
    return;
  }
  validateModulePortDeclarator(document, tokens.slice(declaratorStart), diagnostics);
}

function modulePortDeclaratorStart(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[],
  subroutine: boolean
): number {
  let index = 1;
  let sawType = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.value === '[') {
      const close = findMatchingToken(tokens, index, '[', ']');
      if (close < 0) {
        return -1;
      }
      validateDeclarationRangeSyntax(document, tokens, index, close, diagnostics, 'syntax-malformed-port-list');
      index = close + 1;
      continue;
    }
    if (verilogDeclarationModifiers.has(token.value)) {
      index++;
      continue;
    }
    if (!sawType && isAllowedDeclarationType(tokens[0].value, token.value, subroutine)) {
      sawType = true;
      index++;
      continue;
    }
    if (token.kind === 'keyword' && verilogDeclarationPrefixKeywords.has(token.value)) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        `Syntax error: unexpected declaration keyword '${token.value}' in module port declaration.`,
        DiagnosticSeverity.Error,
        'syntax-malformed-port-list'
      ));
      return firstIdentifierIndex(tokens, index + 1);
    }
    return token.kind === 'identifier' ? index : -1;
  }
  return -1;
}

function validateModulePortDeclarator(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const name = tokens[0];
  if (!name || name.kind !== 'identifier') {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, name ?? tokens[0]),
      'Syntax error: module port declaration is missing a port name.',
      DiagnosticSeverity.Error,
      'syntax-malformed-port-list'
    ));
    return;
  }
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '[') {
      const close = findMatchingToken(tokens, index, '[', ']');
      if (close < 0) {
        return;
      }
      validateDeclarationRangeSyntax(document, tokens, index, close, diagnostics, 'syntax-malformed-port-list');
      index = close;
      continue;
    }
    diagnostics.push(makeDiagnostic(
      tokenRange(document, token),
      `Syntax error: unexpected token '${token.value}' after module port '${name.value}'.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-port-list'
    ));
    return;
  }
}

function topLevelPortDirectionIndexes(tokens: VerilogToken[]): number[] {
  return topLevelIndexes(tokens, (token) => verilogPortDirections.has(token.value));
}

function looksLikeInheritedPortDeclarator(tokens: VerilogToken[]): boolean {
  return tokens[0]?.kind === 'identifier' || tokens[0]?.value === '[';
}

function collectModuleItemDiagnostics(
  document: TextDocument,
  tokens: VerilogToken[],
  moduleAst: VerilogModuleAst,
  moduleNode: VerilogSyntaxNode,
  diagnostics: Diagnostic[]
): void {
  const visitedSubroutines = new Set<VerilogSubroutineAst>();
  const generateBlocks = collectGenerateBlocks(document, tokens, moduleAst);
  const generateCases = collectGenerateCases(document, tokens, moduleAst);
  for (const block of generateCases) validateParenthesizedControl(document, block.tokens, 0, 'case', diagnostics);
  const visitedGenerateBlocks = new Set<GenerateBlockRange>();
  for (const statement of [...moduleAst.items].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const generateBlock = generateBlockForStatement(statement, generateBlocks);
    if (generateBlock) {
      if (!visitedGenerateBlocks.has(generateBlock) && statement.start === generateBlock.start) {
        visitedGenerateBlocks.add(generateBlock);
        moduleNode.children.push(nodeFromRange('generate', rangeFromOffsets(document, generateBlock.start, generateBlock.end)));
        validateGenerateBlock(document, generateBlock.tokens, diagnostics);
      }
      if (isGenerateControlStatement(statement)) {
        continue;
      }
    }
    const subroutine = subroutineForStatement(statement, moduleAst.subroutines);
    if (subroutine) {
      if (!visitedSubroutines.has(subroutine) && statementStartsAt(document, statement, subroutine.range)) {
        visitedSubroutines.add(subroutine);
        moduleNode.children.push(nodeFromRange('task', subroutine.range));
        validateSubroutine(document, subroutine.tokens, diagnostics);
      }
      continue;
    }
    if (statement.kind === 'moduleHeader' || isEndmoduleStatement(statement)) {
      continue;
    }
    const block = proceduralBlockForStatement(statement, moduleAst.proceduralBlocks);
    if (block && statementStartsAt(document, statement, block.range)) {
      const item = proceduralBlockTokens(statement, block);
      moduleNode.children.push(nodeFromRange('proceduralBlock', block.range));
      validateProceduralBlock(document, item, diagnostics);
      continue;
    }
    if (isInsideProceduralBlockBody(statement, moduleAst.proceduralBlocks)) {
      continue;
    }
    if (isGenerateControlStatement(statement)) {
      validateGenerateBlock(document, statement.tokens, diagnostics);
      continue;
    }
    let item = stripLeadingGenerateBlockLabelTokens(statement.tokens.filter((token) => token.kind !== 'eof'));
    if (generateCases.some((block) => statement.start >= block.start && statement.end <= block.end)) {
      const colon = firstTopLevelToken(item, ':', 0);
      if (colon >= 0) item = item.slice(colon + 1);
    }
    const first = item[0];
    if (!first) {
      continue;
    }
    if (first.kind === 'directive') {
      continue;
    }
    if (verilogDeclarationKeywords.has(first.value)) {
      moduleNode.children.push(nodeFromRange('declaration', statement.range));
      validateDeclarationLikeStatement(document, item, diagnostics);
      continue;
    }
    if (first.value === 'assign') {
      moduleNode.children.push(nodeFromRange('continuousAssign', statement.range));
      validateContinuousAssign(document, item, diagnostics);
      continue;
    }
    if (isVerilogGatePrimitive(first.value)) {
      moduleNode.children.push(nodeFromRange('gatePrimitive', statement.range));
      validateGatePrimitiveStatement(document, item, diagnostics);
      continue;
    }
    if (first.value === 'else' || first.value === 'default' || first.value === 'endcase') {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, first),
        `Syntax error: '${first.value}' is not valid at module scope.`,
        DiagnosticSeverity.Error,
        first.value === 'else' ? 'syntax-orphan-else' : `syntax-orphan-${first.value}`
      ));
      continue;
    }
    if (isIdentifierLike(first.kind) && !verilogKeywords.has(first.value)) {
      moduleNode.children.push(nodeFromRange('instance', statement.range));
      validateInstanceStatement(document, item, diagnostics);
      continue;
    }
    if (unsupportedConstructs.has(first.value)) {
      continue;
    }
    diagnostics.push(makeDiagnostic(
      tokenRange(document, first),
      `Syntax error: unexpected token '${first.value}' at module scope.`,
      DiagnosticSeverity.Error,
      'syntax-unexpected-token'
    ));
  }
  for (const subroutine of moduleAst.subroutines) {
    if (visitedSubroutines.has(subroutine)) {
      continue;
    }
    moduleNode.children.push(nodeFromRange('task', subroutine.range));
    validateSubroutine(document, subroutine.tokens, diagnostics);
  }
}

function collectGenerateBlocks(document: TextDocument, tokens: VerilogToken[], moduleAst: VerilogModuleAst): GenerateBlockRange[] {
  const bodyStart = document.offsetAt(moduleAst.bodyRange.start);
  const bodyEnd = document.offsetAt(moduleAst.bodyRange.end);
  const moduleTokens = tokens.filter((token) =>
    token.kind !== 'eof' &&
    token.start >= bodyStart &&
    token.start < bodyEnd
  );
  const blocks: GenerateBlockRange[] = [];
  for (let index = 0; index < moduleTokens.length; index++) {
    if (moduleTokens[index].value !== 'generate') {
      continue;
    }
    let depth = 1;
    let endIndex = -1;
    for (let cursor = index + 1; cursor < moduleTokens.length; cursor++) {
      if (moduleTokens[cursor].value === 'generate') {
        depth++;
      } else if (moduleTokens[cursor].value === 'endgenerate') {
        depth--;
        if (depth === 0) {
          endIndex = cursor;
          break;
        }
      }
    }
    const end = endIndex >= 0 ? moduleTokens[endIndex].end : bodyEnd;
    const blockTokens = moduleTokens.slice(index, endIndex >= 0 ? endIndex + 1 : moduleTokens.length);
    blocks.push({
      start: moduleTokens[index].start,
      end,
      tokens: blockTokens
    });
    if (endIndex >= 0) {
      index = endIndex;
    }
  }
  return blocks;
}

function generateBlockForStatement(statement: VerilogStatementAst, blocks: GenerateBlockRange[]): GenerateBlockRange | undefined {
  return blocks.find((block) => statement.start >= block.start && statement.end <= block.end);
}

function isGenerateControlStatement(statement: VerilogStatementAst): boolean {
  const tokens = statement.tokens.filter((token) => token.kind !== 'eof');
  const stripped = stripLeadingGenerateBlockLabelTokens(tokens);
  if (stripped.length === 0) {
    return true;
  }
  const first = stripped[0]?.value;
  return first === 'generate' ||
    first === 'endgenerate' ||
    first === 'case' ||
    first === 'endcase' ||
    first === 'for' ||
    first === 'if' ||
    first === 'else' ||
    first === 'begin' ||
    first === 'end';
}

function validateGenerateBlock(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value === 'for') validateForStatement(document, tokens, index, diagnostics);
    if (tokens[index].value === 'if') validateParenthesizedControl(document, tokens, index, 'if', diagnostics);
  }
}

function subroutineForStatement(
  statement: VerilogStatementAst,
  subroutines: VerilogSubroutineAst[]
): VerilogSubroutineAst | undefined {
  return subroutines.find((subroutine) => containsRange(subroutine.range, statement.range));
}

function proceduralBlockForStatement(
  statement: VerilogStatementAst,
  blocks: VerilogProceduralBlockAst[]
): VerilogProceduralBlockAst | undefined {
  return blocks.find((block) => containsRange(block.range, statement.range));
}

function isInsideProceduralBlockBody(statement: VerilogStatementAst, blocks: VerilogProceduralBlockAst[]): boolean {
  return blocks.some((block) => statement.start >= block.bodyStart && statement.end <= block.bodyEnd);
}

function statementStartsAt(document: TextDocument, statement: VerilogStatementAst, range: Range): boolean {
  return statement.start === document.offsetAt(range.start);
}

function proceduralBlockTokens(statement: VerilogStatementAst, block: VerilogProceduralBlockAst): VerilogToken[] {
  const tokens = statement.tokens.filter((token) => token.kind !== 'eof');
  if (statement.end >= block.bodyEnd) {
    return tokens;
  }
  return [...tokens, ...block.bodyTokens.filter((token) => token.kind !== 'eof')];
}

function isEndmoduleStatement(statement: VerilogStatementAst): boolean {
  return statement.tokens.find((token) => token.kind !== 'eof')?.value === 'endmodule';
}

function rangeFromOffsets(document: TextDocument, start: number, end: number): Range {
  return Range.create(document.positionAt(start), document.positionAt(end));
}

function validateGatePrimitiveStatement(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  if (!hasTrailingSemicolon(tokens)) {
    reportMissingSemicolon(document, tokens[0], tokens, diagnostics);
  }
  const statement = trimTrailingSemicolon(tokens);
  const instances = splitTopLevel(statement.slice(1), ',');
  if (instances.length === 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[0]),
      `Syntax error: gate primitive '${tokens[0].value}' is missing a port list.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-gate-primitive'
    ));
    return;
  }
  for (const instance of instances) {
    validateGatePrimitiveInstance(document, tokens[0].value, instance, diagnostics);
  }
}

function validateGatePrimitiveInstance(
  document: TextDocument,
  primitiveName: string,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[]
): void {
  const open = gatePrimitivePortListOpen(tokens);
  if (open < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[0]),
      `Syntax error: gate primitive '${primitiveName}' is missing a parenthesized port list.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-gate-primitive'
    ));
    return;
  }
  const close = findMatchingToken(tokens, open, '(', ')');
  if (close < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[open]),
      `Syntax error: gate primitive '${primitiveName}' port list is missing a closing parenthesis.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-gate-primitive'
    ));
    return;
  }
  if (close !== tokens.length - 1) {
    const extra = tokens[close + 1];
    diagnostics.push(makeDiagnostic(
      tokenRange(document, extra),
      `Syntax error: unexpected token '${extra.value}' after gate primitive '${primitiveName}' port list.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-gate-primitive'
    ));
    return;
  }
  const ports = splitTopLevel(tokens.slice(open + 1, close), ',');
  if (ports.length === 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[open]),
      `Syntax error: gate primitive '${primitiveName}' port list is empty.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-gate-primitive'
    ));
    return;
  }
  for (const port of ports) {
    validateExpressionSyntax(document, port, diagnostics, 'syntax-malformed-gate-primitive');
  }
}

function gatePrimitivePortListOpen(tokens: VerilogToken[]): number {
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== '(') {
      continue;
    }
    const close = findMatchingToken(tokens, index, '(', ')');
    if (close === tokens.length - 1) {
      return index;
    }
  }
  return -1;
}

function validateDeclarationLikeStatement(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[], subroutine = false): void {
  if (!hasTrailingSemicolon(tokens)) reportMissingSemicolon(document, tokens[0], tokens, diagnostics);
  validateDeclarationList(document, stripDriveStrength(trimTrailingSemicolon(tokens)), diagnostics, subroutine);
}

/** Body declarations and module parameter headers share declaration prefixes and declarators. */
function validateDeclarationList(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[], subroutine = false, parameterHeader = false): void {
  const parts = splitTopLevel(tokens, ',', true);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part.length) continue;
    const declaresPrefix = index === 0 || (parameterHeader && part[0].value === 'parameter');
    if (declaresPrefix) {
      const start = declarationDeclaratorStart(document, part, diagnostics, subroutine);
      if (start < 0) {
        diagnostics.push(makeDiagnostic(tokenRange(document, part[0]),
          `Syntax error: '${part[0].value}' declaration is missing an identifier.`,
          DiagnosticSeverity.Error, 'syntax-malformed-declaration'));
        continue;
      }
      validateDeclarationDeclarator(document, part.slice(start), diagnostics);
    } else {
      validateDeclarationDeclarator(document, part, diagnostics);
    }
  }
}

function declarationDeclaratorStart(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[],
  subroutine: boolean
): number {
  let index = 1;
  let sawType = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.value === '[') {
      const close = findMatchingToken(tokens, index, '[', ']');
      if (close < 0) {
        return -1;
      }
      validateDeclarationRangeSyntax(document, tokens, index, close, diagnostics, 'syntax-malformed-declaration');
      index = close + 1;
      continue;
    }
    if (verilogDeclarationModifiers.has(token.value)) {
      index++;
      continue;
    }
    if (!sawType && isAllowedDeclarationType(tokens[0].value, token.value, subroutine)) {
      sawType = true;
      index++;
      continue;
    }
    if (token.kind === 'keyword' && verilogDeclarationPrefixKeywords.has(token.value)) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        `Syntax error: unexpected declaration keyword '${token.value}' after '${tokens[0].value}'.`,
        DiagnosticSeverity.Error,
        'syntax-malformed-declaration'
      ));
      return firstIdentifierIndex(tokens, index + 1);
    }
    return token.kind === 'identifier' ? index : -1;
  }
  return -1;
}

function isAllowedDeclarationType(firstKeyword: string, value: string, subroutine = false): boolean {
  if (verilogPortDirections.has(firstKeyword)) {
    return verilogPortDeclarationTypes.has(value) || (subroutine && verilogParameterTypeKeywords.has(value));
  }
  if (firstKeyword === 'parameter' || firstKeyword === 'localparam') {
    return verilogParameterTypeKeywords.has(value);
  }
  return false;
}

function firstIdentifierIndex(tokens: VerilogToken[], start: number): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind === 'identifier') {
      return index;
    }
  }
  return -1;
}

function validateDeclarationDeclarator(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const name = tokens[0];
  if (!name || name.kind !== 'identifier') {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, name ?? tokens[0]),
      'Syntax error: declaration declarator is missing an identifier.',
      DiagnosticSeverity.Error,
      'syntax-malformed-declaration'
    ));
    return;
  }
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '[') {
      const close = findMatchingToken(tokens, index, '[', ']');
      if (close < 0) {
        return;
      }
      validateDeclarationRangeSyntax(document, tokens, index, close, diagnostics, 'syntax-malformed-declaration');
      index = close;
      continue;
    }
    if (token.value === '=') {
      const initializer = tokens.slice(index + 1);
      if (initializer.filter(isExpressionOperandToken).length === 0) {
        diagnostics.push(makeDiagnostic(
          tokenRange(document, token),
          `Syntax error: declaration '${name.value}' initializer is missing an expression.`,
          DiagnosticSeverity.Error,
          'syntax-malformed-declaration'
        ));
        return;
      }
      validateExpressionSyntax(document, initializer, diagnostics, 'syntax-malformed-declaration');
      return;
    }
    diagnostics.push(makeDiagnostic(
      tokenRange(document, token),
      `Syntax error: unexpected token '${token.value}' in declaration '${name.value}'.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-declaration'
    ));
    return;
  }
}

function validateContinuousAssign(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  if (!hasTrailingSemicolon(tokens)) {
    reportMissingSemicolon(document, tokens[0], tokens, diagnostics);
  }
  const normalizedTokens = stripDriveStrength(tokens);
  const semicolon = firstTopLevelToken(normalizedTokens, ';', 1);
  const limit = semicolon >= 0 ? semicolon : normalizedTokens.length;
  for (const part of continuousAssignmentParts(normalizedTokens.slice(0, limit))) {
    if (part.length) {
      validateContinuousAssignmentPart(document, part, diagnostics);
    } else {
      diagnostics.push(makeDiagnostic(tokenRange(document, tokens[0]),
        'Syntax error: expected an assignment between commas.', DiagnosticSeverity.Error, 'syntax-malformed-assignment'));
    }
  }
}

function validateContinuousAssignmentPart(document: TextDocument, normalizedTokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const assignment = parseAssignmentTokens(normalizedTokens);
  if (!assignment) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, normalizedTokens[0]),
      'Syntax error: continuous assign is missing an assignment operator.',
      DiagnosticSeverity.Error,
      'syntax-malformed-assignment'
    ));
    return;
  }
  if (assignment.lhsTokens.filter(isExpressionOperandToken).length === 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, normalizedTokens[assignment.operatorIndex]),
      'Syntax error: assignment is missing a left-hand side.',
      DiagnosticSeverity.Error,
      'syntax-malformed-assignment'
    ));
  }
  validateAssignmentTarget(document, assignment.lhsTokens, diagnostics);
  if (assignment.rhsTokens.filter(isExpressionOperandToken).length === 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, normalizedTokens[assignment.operatorIndex]),
      'Syntax error: assignment is missing a right-hand side.',
      DiagnosticSeverity.Error,
      'syntax-malformed-assignment'
    ));
  }
  validateExpressionSyntax(document, assignment.rhsTokens, diagnostics, 'syntax-malformed-assignment');
}

function appendSyntaxIssues(issues: ExpressionSyntaxIssue[], diagnostics: Diagnostic[], code: string): void {
  for (const issue of issues) diagnostics.push(makeDiagnostic(issue.range, issue.message, DiagnosticSeverity.Error, code));
}

function validateExpressionSyntax(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[], code: string, requiredAnchor?: VerilogToken): void {
  appendSyntaxIssues(expressionSyntaxIssues(document, tokens, requiredAnchor), diagnostics, code);
}

function validateMintypmaxExpressionSyntax(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[], code: string, requiredAnchor?: VerilogToken): void {
  appendSyntaxIssues(mintypmaxExpressionSyntaxIssues(document, tokens, requiredAnchor), diagnostics, code);
}

function validateDeclarationRangeSyntax(document: TextDocument, tokens: VerilogToken[], open: number, close: number, diagnostics: Diagnostic[], code: string): void {
  appendSyntaxIssues(declarationRangeSyntaxIssues(document, tokens, open, close), diagnostics, code);
}

function validateInstanceStatement(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const group = splitInstanceTokenGroup(tokens);
  if (!group || group.declarators.length === 1) {
    validateSingleInstance(document, tokens, diagnostics);
    return;
  }
  const terminator = tokens[tokens.length - 1];
  for (const declarator of group.declarators) {
    validateSingleInstance(document, [...group.prefix, ...declarator, ...(terminator?.value === ';' ? [terminator] : [])], diagnostics);
  }
}

function validateSingleInstance(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  let instanceIndex = 1;
  if (tokens[instanceIndex]?.value === '#') {
    if (tokens[instanceIndex + 1]?.value !== '(') {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, tokens[instanceIndex]),
        `Syntax error: parameterized instance '${tokens[0].value}' is missing a parameter list.`,
        DiagnosticSeverity.Error,
        'syntax-malformed-instance'
      ));
      return;
    }
    const close = findMatchingToken(tokens, instanceIndex + 1, '(', ')');
    if (close < 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, tokens[instanceIndex + 1]),
        `Syntax error: parameterized instance '${tokens[0].value}' is missing a closing parenthesis.`,
        DiagnosticSeverity.Error,
        'syntax-malformed-instance'
      ));
      return;
    }
    validatePortConnections(document, tokens.slice(instanceIndex + 2, close), diagnostics, true);
    instanceIndex = close + 1;
  }
  if (tokens.length <= instanceIndex || !isIdentifierLike(tokens[instanceIndex].kind)) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[0]),
      `Syntax error: module instance '${tokens[0].value}' is missing an instance name.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-instance'
    ));
    return;
  }
  if (!hasTrailingSemicolon(tokens)) {
    reportMissingSemicolon(document, tokens[0], tokens, diagnostics);
  }
  if (tokens[instanceIndex + 1]?.value === '[') {
    const close = findMatchingToken(tokens, instanceIndex + 1, '[', ']');
    const bounds = close >= 0 ? splitTopLevel(tokens.slice(instanceIndex + 2, close), ':') : [];
    if (bounds.length !== 2 || bounds.some((bound) => !bound.length)) {
      diagnostics.push(makeDiagnostic(tokenRange(document, tokens[instanceIndex + 1]),
        'Syntax error: an instance array requires a [left:right] range.', DiagnosticSeverity.Error, 'syntax-malformed-instance'));
      return;
    }
    for (const bound of bounds) validateExpressionSyntax(document, bound, diagnostics, 'syntax-malformed-instance');
  }
  const afterInstanceName = instanceDeclaratorPortIndex(tokens, instanceIndex);
  if (
    afterInstanceName >= 0 &&
    tokens[afterInstanceName].value !== ';' &&
    tokens[afterInstanceName].value !== '(' &&
    tokens[afterInstanceName].value !== ','
  ) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[afterInstanceName]),
      `Syntax error: unexpected token '${tokens[afterInstanceName].value}' after instance name '${tokens[instanceIndex].value}'.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-instance'
    ));
    return;
  }
  const open = tokens.findIndex((token, index) => index > instanceIndex && token.value === '(');
  if (open < 0) {
    return;
  }
  const close = findMatchingToken(tokens, open, '(', ')');
  if (close < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[open]),
      'Syntax error: instance port list is missing a closing parenthesis.',
      DiagnosticSeverity.Error,
      'syntax-malformed-instance'
    ));
    return;
  }
  validatePortConnections(document, tokens.slice(open + 1, close), diagnostics);
}

function validatePortConnections(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[], parameters = false): void {
  const connections = splitTopLevelPreserveEmpty(tokens, ',');
  const named = connections.some((connection) => connection[0]?.value === '.');
  const positional = connections.some((connection) => connection[0]?.value !== '.');
  if (tokens.length && named && positional) {
    const firstNamed = connections[0]?.[0]?.value === '.';
    const mismatched = connections.find((connection) => (connection[0]?.value === '.') !== firstNamed);
    const anchor = mismatched?.[0] ?? tokens.find((token) => token.value === ',') ?? tokens[0];
    diagnostics.push(makeDiagnostic(tokenRange(document, anchor),
      'Syntax error: named and positional connections cannot be mixed in one list.',
      DiagnosticSeverity.Error, 'syntax-malformed-instance'));
  }
  for (const connection of connections) {
    if (connection[0]?.value === '.') {
      validateNamedConnection(document, connection, diagnostics, parameters);
      continue;
    }
    if (connection.length > 0) {
      (parameters ? validateMintypmaxExpressionSyntax : validateExpressionSyntax)(document, connection, diagnostics, 'syntax-malformed-instance');
    }
  }
}

function validateNamedConnection(document: TextDocument, connection: VerilogToken[], diagnostics: Diagnostic[], parameters: boolean): void {
  const name = connection[1];
  if (!name || !isIdentifierLike(name.kind)) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, connection[0]),
      'Syntax error: named port connection is missing a port name.',
      DiagnosticSeverity.Error,
      'syntax-malformed-instance'
    ));
    return;
  }
  if (connection[2]?.value !== '(') {
    if (connection.length > 2) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, name),
        `Syntax error: named port connection '.${name.value}' must use parentheses.`,
        DiagnosticSeverity.Error,
        'syntax-malformed-instance'
      ));
    }
    return;
  }

  const close = findMatchingToken(connection, 2, '(', ')');
  if (close < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, connection[2]),
      `Syntax error: named port connection '.${name.value}' is missing a closing parenthesis.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-instance'
    ));
    return;
  }
  if (close !== connection.length - 1) {
    const extra = connection[close + 1];
    diagnostics.push(makeDiagnostic(
      tokenRange(document, extra),
      `Syntax error: unexpected token '${extra.value}' after named port connection '.${name.value}'. Did you forget a comma?`,
      DiagnosticSeverity.Error,
      'syntax-malformed-instance'
    ));
    return;
  }
  const expression = connection.slice(3, close);
  if (expression.length > 0) {
    (parameters ? validateMintypmaxExpressionSyntax : validateExpressionSyntax)(document, expression, diagnostics, 'syntax-malformed-instance');
  }
}

function validateProceduralBlock(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const first = tokens[0];
  let bodyStart = 1;
  if (first.value === 'always' && tokens[1]?.value === '@') {
    bodyStart = validateEventControl(document, tokens, 1, diagnostics);
  } else if (tokens[1]?.value === '#') {
    bodyStart = validateDelayControl(document, tokens, 1, diagnostics);
  }
  if (bodyStart >= tokens.length) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, first),
      `Syntax error: '${first.value}' block is missing a statement body.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-procedural-block'
    ));
    return;
  }
  validateProceduralStatements(document, tokens.slice(bodyStart), diagnostics);
}

function validateSubroutine(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const first = tokens[0];
  const endKeyword = first.value === 'task' ? 'endtask' : 'endfunction';
  if (!tokens.some((token) => token.value === endKeyword)) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, first),
      `Syntax error: '${first.value}' is missing a matching ${endKeyword}.`,
      DiagnosticSeverity.Error,
      `syntax-unclosed-${first.value}`
    ));
  }
  const headerTerminator = firstTopLevelToken(tokens, ';', 1);
  const header = tokens.slice(1, headerTerminator < 0 ? tokens.length : headerTerminator);
  const argumentsOpen = topLevelIndexes(header, (token) => token.value === '(')[0] ?? -1;
  const nameTokens = argumentsOpen < 0 ? header : header.slice(0, argumentsOpen);
  if (argumentsOpen >= 0) {
    const argumentsClose = findMatchingToken(header, argumentsOpen, '(', ')');
    if (argumentsClose >= 0) validateModulePortList(document, header.slice(argumentsOpen + 1, argumentsClose), diagnostics, true);
  }
  for (let index = 0; index < nameTokens.length; index++) {
    if (nameTokens[index].value !== '[') continue;
    const close = findMatchingToken(nameTokens, index, '[', ']');
    if (close >= 0) {
      validateDeclarationRangeSyntax(document, nameTokens, index, close, diagnostics, 'syntax-malformed-declaration');
      index = close;
    }
  }
  let rangeDepth = 0;
  const hasName = nameTokens.some((token) => {
    if (token.value === '[') rangeDepth++;
    if (token.value === ']') rangeDepth--;
    return rangeDepth === 0 && token.kind === 'identifier';
  });
  if (!hasName) {
    diagnostics.push(makeDiagnostic(tokenRange(document, first),
      `Syntax error: '${first.value}' declaration is missing its name.`, DiagnosticSeverity.Error,
      `syntax-malformed-${first.value}`));
  }
  if (headerTerminator < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, first),
      `Syntax error: '${first.value}' declaration is missing a semicolon after its header.`,
      DiagnosticSeverity.Error,
      'syntax-missing-semicolon'
    ));
  }
  validateProceduralStatements(document, tokens.slice(Math.max(1, headerTerminator + 1)), diagnostics, true);
}

function validateEventControl(
  document: TextDocument,
  tokens: VerilogToken[],
  atIndex: number,
  diagnostics: Diagnostic[]
): number {
  const at = tokens[atIndex];
  const next = tokens[atIndex + 1];
  if (!next) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, at),
      'Syntax error: event control is missing a sensitivity expression.',
      DiagnosticSeverity.Error,
      'syntax-malformed-event-control'
    ));
    return atIndex + 1;
  }
  if (next.value === '*') {
    return atIndex + 2;
  }
  if (next.value !== '(') {
    return atIndex + 2;
  }
  const close = findMatchingToken(tokens, atIndex + 1, '(', ')');
  if (close < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, next),
      'Syntax error: event control is missing a closing parenthesis.',
      DiagnosticSeverity.Error,
      'syntax-malformed-event-control'
    ));
    return atIndex + 2;
  }
  const rawContent = tokens.slice(atIndex + 2, close);
  const content = rawContent.filter((token) => token.value === '*' || isExpressionToken(token));
  if (content.length === 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, next),
      'Syntax error: event control is empty.',
      DiagnosticSeverity.Error,
      'syntax-malformed-event-control'
    ));
  } else {
    const badTokenIndex = tokens.findIndex((token, index) =>
      index > atIndex + 1 &&
      index < close &&
      (token.value === 'begin' || token.value === 'if' || token.value === 'case' || token.value === 'for' || token.value === ';')
    );
    if (badTokenIndex < 0) {
      return close + 1;
    }
    diagnostics.push(makeDiagnostic(
      tokenRange(document, next),
      'Syntax error: event control reaches into the statement body; a closing parenthesis is probably missing.',
      DiagnosticSeverity.Error,
      'syntax-malformed-event-control'
    ));
    return badTokenIndex;
  }
  return close + 1;
}

function validateProceduralStatements(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[], subroutine = false): void {
  let pendingIf = 0;
  let caseDepth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'eof') {
      break;
    }
    if (verilogDeclarationKeywords.has(token.value)) {
      const end = firstTopLevelToken(tokens, ';', index);
      if (end >= 0) {
        validateDeclarationLikeStatement(document, tokens.slice(index, end + 1), diagnostics, subroutine);
        index = end;
        continue;
      }
    }
    if (token.value === '#') {
      validateDelayControl(document, tokens, index, diagnostics);
      continue;
    }
    if (token.value === 'if') {
      pendingIf++;
      validateParenthesizedControl(document, tokens, index, 'if', diagnostics);
      continue;
    }
    if (token.value === 'else') {
      if (pendingIf === 0) {
        diagnostics.push(makeDiagnostic(
          tokenRange(document, token),
          "Syntax error: 'else' has no matching if.",
          DiagnosticSeverity.Error,
          'syntax-orphan-else'
        ));
      } else {
        pendingIf--;
      }
      continue;
    }
    if (token.value === 'case' || token.value === 'casex' || token.value === 'casez') {
      caseDepth++;
      validateParenthesizedControl(document, tokens, index, 'case', diagnostics);
      continue;
    }
    if (token.value === 'endcase') {
      caseDepth = Math.max(0, caseDepth - 1);
      continue;
    }
    if (token.value === 'default' && caseDepth === 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        "Syntax error: 'default' appears outside a case statement.",
        DiagnosticSeverity.Error,
        'syntax-orphan-default'
      ));
      continue;
    }
    if (token.value === 'for') {
      validateForStatement(document, tokens, index, diagnostics);
      continue;
    }
    if (token.value === 'while' || token.value === 'repeat' || token.value === 'wait') {
      validateParenthesizedControl(document, tokens, index, token.value, diagnostics);
      continue;
    }
  }
  validateProceduralAssignments(document, tokens, diagnostics);
}

function validateParenthesizedControl(
  document: TextDocument,
  tokens: VerilogToken[],
  keywordIndex: number,
  kind: 'if' | 'case' | 'while' | 'repeat' | 'wait',
  diagnostics: Diagnostic[]
): void {
  const open = nextSignificantTokenIndex(tokens, keywordIndex + 1);
  if (open < 0 || tokens[open].value !== '(') {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[keywordIndex]),
      `Syntax error: '${kind}' is missing a parenthesized expression.`,
      DiagnosticSeverity.Error,
      `syntax-malformed-${kind}`
    ));
    return;
  }
  const close = findMatchingToken(tokens, open, '(', ')');
  if (close < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[open]),
      `Syntax error: '${kind}' expression is missing a closing parenthesis.`,
      DiagnosticSeverity.Error,
      `syntax-malformed-${kind}`
    ));
    return;
  }
  validateExpressionSyntax(document, tokens.slice(open + 1, close), diagnostics, `syntax-malformed-${kind}`, tokens[close]);
}

function validateForStatement(document: TextDocument, tokens: VerilogToken[], forIndex: number, diagnostics: Diagnostic[]): void {
  const open = nextSignificantTokenIndex(tokens, forIndex + 1);
  if (open < 0 || tokens[open].value !== '(') {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[forIndex]),
      "Syntax error: 'for' is missing a parenthesized control expression.",
      DiagnosticSeverity.Error,
      'syntax-malformed-for'
    ));
    return;
  }
  const close = findMatchingToken(tokens, open, '(', ')');
  if (close < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[open]),
      "Syntax error: 'for' control expression is missing a closing parenthesis.",
      DiagnosticSeverity.Error,
      'syntax-malformed-for'
    ));
    return;
  }
  const control = tokens.slice(open + 1, close);
  const parts = splitTopLevelPreserveEmpty(control, ';');
  if (parts.length !== 3) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[forIndex]),
      "Syntax error: 'for' control expression must contain init, condition, and step sections.",
      DiagnosticSeverity.Error,
      'syntax-malformed-for'
    ));
    return;
  }
  validateForAssignmentSection(document, parts[0], 'init', diagnostics);
  validateForConditionSection(document, parts[1], diagnostics, control[topLevelIndexes(control, (token) => token.value === ';')[1]]);
  validateForAssignmentSection(document, parts[2], 'step', diagnostics);
}

function splitTopLevelPreserveEmpty(tokens: VerilogToken[], separator: string): VerilogToken[][] {
  return splitTopLevel(tokens, separator, true);
}

function validateForAssignmentSection(
  document: TextDocument,
  tokens: VerilogToken[],
  section: 'init' | 'step',
  diagnostics: Diagnostic[]
): void {
  if (tokens.length === 0) {
    return;
  }
  // Verilog-2005 allows a genvar declaration in a generate-for initializer.
  if (section === 'init' && tokens[0]?.value === 'genvar') {
    validateDeclarationList(document, tokens, diagnostics, false);
    return;
  }
  const assignment = parseAssignmentTokens(tokens);
  if (!assignment) {
    validateExpressionSyntax(document, tokens, diagnostics, 'syntax-malformed-for');
    return;
  }
  if (assignment.lhsTokens.filter(isExpressionOperandToken).length === 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[assignment.operatorIndex]),
      `Syntax error: 'for' ${section} assignment is missing a left-hand side.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-for'
    ));
  } else {
    validateAssignmentTarget(document, assignment.lhsTokens, diagnostics, 'syntax-malformed-for');
  }
  if (assignment.rhsTokens.filter(isExpressionOperandToken).length === 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[assignment.operatorIndex]),
      `Syntax error: 'for' ${section} assignment is missing a right-hand side.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-for'
    ));
  } else {
    validateExpressionSyntax(document, assignment.rhsTokens, diagnostics, 'syntax-malformed-for');
  }
}

function validateForConditionSection(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[], anchor: VerilogToken): void {
  validateExpressionSyntax(document, tokens, diagnostics, 'syntax-malformed-for',
    document.languageId === 'verilog' ? anchor : undefined);
}

function validateProceduralAssignments(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value !== '=' && token.value !== '<=') {
      continue;
    }
    if (isInsideDelimitedControl(tokens, index)) {
      continue;
    }
    const start = statementStart(tokens, index);
    const end = statementEnd(tokens, index);
    const statement = tokens.slice(start, end);
    const declaration = stripLeadingGenerateBlockLabelTokens(statement);
    if (declaration[0] && verilogDeclarationKeywords.has(declaration[0].value)) continue;
    const assignment = parseAssignmentTokens(statement);
    if (!assignment || assignment.operatorIndex !== index - start) {
      continue;
    }
    if (assignment.lhsTokens.filter(isExpressionOperandToken).length === 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        'Syntax error: assignment is missing a left-hand side.',
        DiagnosticSeverity.Error,
        'syntax-malformed-assignment'
      ));
    } else {
      validateAssignmentTarget(document, assignment.lhsTokens, diagnostics);
    }
    if (assignment.rhsTokens.filter(isExpressionOperandToken).length === 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        'Syntax error: assignment is missing a right-hand side.',
        DiagnosticSeverity.Error,
        'syntax-malformed-assignment'
      ));
    } else {
      validateExpressionSyntax(document, assignment.rhsTokens, diagnostics, 'syntax-malformed-assignment');
    }
    if (tokens[end]?.value !== ';' && tokens[index - 1]?.value !== '<' && tokens[index - 1]?.value !== '>') {
      reportMissingSemicolon(document, statement[0] ?? token, statement, diagnostics);
    }
  }
}

function collectNumberLiteralDiagnostics(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  for (const token of tokens) {
    if (token.kind !== 'number') {
      continue;
    }
    const error = numberLiteralError(token.value);
    if (!error) {
      continue;
    }
    diagnostics.push(makeDiagnostic(
      tokenRange(document, token),
      `Syntax error: ${error}`,
      DiagnosticSeverity.Error,
      'syntax-malformed-number'
    ));
  }
}

function collectUnsupportedConstructDiagnostics(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const reported = new Set<string>();
  for (const token of tokens) {
    if (!unsupportedConstructs.has(token.value) || reported.has(token.value)) {
      continue;
    }
    reported.add(token.value);
    diagnostics.push(makeDiagnostic(
      tokenRange(document, token),
      `Verilog construct '${token.value}' is outside the supported CO course subset; Icarus may still accept it.`,
      DiagnosticSeverity.Information,
      'syntax-unsupported-construct'
    ));
  }
}

function collectOrphanControlDiagnostics(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  let caseDepth = 0;
  for (const token of tokens) {
    if (token.value === 'case' || token.value === 'casex' || token.value === 'casez') {
      caseDepth++;
    } else if (token.value === 'endcase') {
      caseDepth = Math.max(0, caseDepth - 1);
    } else if (token.value === 'default' && caseDepth === 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        "Syntax error: 'default' appears outside a case statement.",
        DiagnosticSeverity.Error,
        'syntax-orphan-default'
      ));
    }
  }
}

function numberLiteralError(value: string): string | undefined {
  value = value.replace(/\s+/g, '');
  if (parseVerilogNumberLiteral(value)?.kind === 'real') {
    return undefined;
  }
  const apostrophe = value.indexOf("'");
  if (apostrophe < 0) {
    return /^[0-9_]+$/.test(value) && /[0-9]/.test(value) ? undefined : `malformed decimal literal '${value}'.`;
  }
  let index = apostrophe + 1;
  if (value[index] === 's' || value[index] === 'S') {
    index++;
  }
  const base = value[index]?.toLowerCase();
  if (base !== 'b' && base !== 'o' && base !== 'd' && base !== 'h') {
    return `based literal '${value}' is missing a valid base.`;
  }
  const digits = value.slice(index + 1).replace(/_/g, '');
  if (!digits) {
    return `based literal '${value}' is missing digits.`;
  }
  const allowed = base === 'b'
    ? /^[01xXzZ?]+$/
    : base === 'o'
      ? /^[0-7xXzZ?]+$/
      : base === 'd'
        ? /^[0-9xXzZ?]+$/
        : /^[0-9a-fA-FxXzZ?]+$/;
  return allowed.test(digits) ? undefined : `literal '${value}' contains digits invalid for base ${base}.`;
}

function hasTrailingSemicolon(tokens: VerilogToken[]): boolean {
  return tokens[tokens.length - 1]?.value === ';';
}

function reportMissingSemicolon(
  document: TextDocument,
  anchor: VerilogToken,
  statement: VerilogToken[],
  diagnostics: Diagnostic[]
): void {
  diagnostics.push(makeDiagnostic(
    tokenRange(document, anchor),
    `Syntax error: '${anchor.value}' statement is missing a terminating semicolon.`,
    DiagnosticSeverity.Error,
    'syntax-missing-semicolon'
  ));
}

function validateDelayControl(document: TextDocument, tokens: VerilogToken[], hashIndex: number, diagnostics: Diagnostic[]): number {
  if (tokens[hashIndex + 1]?.value === '(') {
    const open = hashIndex + 1;
    const close = findMatchingToken(tokens, open, '(', ')');
    if (close >= 0) {
      validateMintypmaxExpressionSyntax(document, tokens.slice(open + 1, close), diagnostics, 'syntax-malformed-delay', tokens[close]);
      return close + 1;
    }
    return hashIndex + 2;
  }
  return Math.min(tokens.length, hashIndex + 2);
}

function isInsideDelimitedControl(tokens: VerilogToken[], index: number): boolean {
  const stack: Array<string | undefined> = [];
  for (let cursor = 0; cursor < index; cursor++) {
    const token = tokens[cursor];
    if (token.value === '(') {
      stack.push(previousToken(tokens, cursor)?.value);
    } else if (token.value === ')') {
      stack.pop();
    }
  }
  return stack.some((value) =>
    value === 'if' ||
    value === 'case' ||
    value === 'casex' ||
    value === 'casez' ||
    value === 'for' ||
    value === 'while' ||
    value === 'repeat' ||
    value === 'wait'
  );
}

function statementStart(tokens: VerilogToken[], index: number): number {
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let cursor = 0; cursor < index; cursor++) {
    const token = tokens[cursor];
    if (isStatementStartBoundary(token.value) && paren === 0 && bracket === 0 && brace === 0) {
      start = cursor + 1;
    }
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
    }
  }
  return start;
}

function isStatementStartBoundary(value: string): boolean {
  return value === ';' ||
    value === 'begin' ||
    value === 'else' ||
    value === 'end' ||
    value === 'endcase' ||
    value === 'endfunction' ||
    value === 'endtask' ||
    value === 'join' ||
    value === 'join_any' ||
    value === 'join_none';
}

function statementEnd(tokens: VerilogToken[], index: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let cursor = index + 1; cursor < tokens.length; cursor++) {
    const token = tokens[cursor];
    if ((token.value === ';' || token.value === 'end' || token.value === 'else' || token.value === 'endcase') && paren === 0 && bracket === 0 && brace === 0) {
      return cursor;
    }
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
    }
  }
  return tokens.length;
}

function previousToken(tokens: VerilogToken[], index: number): VerilogToken | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (tokens[cursor].kind !== 'eof') {
      return tokens[cursor];
    }
  }
  return undefined;
}

function isExpressionToken(token: VerilogToken): boolean {
  if (token.kind === 'eof') {
    return false;
  }
  if (token.kind === 'systemIdentifier') {
    const name = token.value.startsWith('$') ? token.value.slice(1) : token.value;
    return !systemTasks.has(name);
  }
  return token.kind === 'identifier' || token.kind === 'number' || token.kind === 'string' || token.kind === 'directive';
}

function isExpressionOperandToken(token: VerilogToken): boolean {
  return token.kind === 'systemIdentifier' || isExpressionToken(token);
}

function tokenRange(document: TextDocument, token: VerilogToken): Range {
  return Range.create(document.positionAt(token.start), document.positionAt(token.end));
}

function nodeFromRange(kind: VerilogSyntaxNodeKind, range: Range): VerilogSyntaxNode {
  return {
    kind,
    range,
    children: []
  };
}

function documentRange(document: TextDocument): Range {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const lastLine = Math.max(0, lines.length - 1);
  return Range.create(0, 0, lastLine, lines[lastLine]?.length ?? 0);
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}

function validateAssignmentTarget(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[], code = 'syntax-malformed-assignment'): void {
  validateExpressionSyntax(document, tokens, diagnostics, code);
  const expression = parseVerilogExpressionTokens(tokens);
  if (expression && !verilogExpressionHasError(expression) &&
      !(expression.kind === 'callExpression' && expression.callee.startsWith('`')) &&
      !isVerilogLvalueExpression(expression)) {
    diagnostics.push(makeDiagnostic(Range.create(document.positionAt(expression.start), document.positionAt(expression.end)),
      'Syntax error: assignment target must be a net/variable, select, or concatenation of targets.', DiagnosticSeverity.Error, code));
  }
}

function collectGenerateCases(document: TextDocument, tokens: VerilogToken[], moduleAst: VerilogModuleAst): GenerateBlockRange[] {
  const start = document.offsetAt(moduleAst.bodyRange.start), end = document.offsetAt(moduleAst.bodyRange.end);
  const body = tokens.filter((token) => token.start >= start && token.end <= end);
  const result: GenerateBlockRange[] = [];
  for (let index = 0; index < body.length; index++) {
    if (body[index].value !== 'case' ||
        moduleAst.proceduralBlocks.some((block) => containsRange(block.range, tokenRange(document, body[index]))) ||
        moduleAst.subroutines.some((subroutine) => containsRange(subroutine.range, tokenRange(document, body[index])))) continue;
    const close = findMatchingToken(body, index, 'case', 'endcase');
    result.push({ start: body[index].start, end: close >= 0 ? body[close].end : end, tokens: body.slice(index, close >= 0 ? close + 1 : body.length) });
  }
  return result;
}
