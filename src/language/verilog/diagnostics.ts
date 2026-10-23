// @index diagnostics-orchestrator — 聚合所有Verilog诊断：语法/Lint/数据流/连接/usage
import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { ProjectProfile } from '../../projectProfile';
import { lineAt, makeDiagnostic } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { evalExpressionAstConstant, shouldReportWidthMismatch, widthOfDecl, widthOfExpression, widthOfExpressionAst } from './expressions';
import type { VerilogAstDocument, VerilogModuleAst, VerilogStatementAst } from './ast';
import { parseVerilogExpression } from './exprAst';
import type { VerilogCallExpressionAst, VerilogExpressionAst } from './exprAst';
import { walkVerilogExpression } from './exprAstUtils';
import type { VerilogProceduralStatementAst } from './proceduralAst';
import {
  expectedPorts,
  VerilogDecl,
  VerilogInclude,
  VerilogModule
} from './model';
import { collectSyntaxDiagnostics } from './syntaxDiagnostics';
import { collectInstanceConnectionDiagnostics } from './instanceConnectionDiagnostics';
import {
  collectExplicitPortNetTypeDiagnostics,
  collectImplicitNetDiagnostics,
  collectTestbenchDiagnostics
} from './lintDiagnostics';
import { collectContinuousProceduralDriverDiagnostics } from './driverDiagnostics';
import { normalizeWidth } from './textUtils';
import type { VerilogSemanticModel } from './semanticModel';
import { collectAssignmentTypeDiagnostics } from './assignmentTypeDiagnostics';
import { declarationAtPosition } from './accessPaths';
import { visitProceduralAssignments } from './assignmentAst';
import { uniqueModule } from './moduleResolution';
import { collectSubroutineDiagnostics } from './subroutineDiagnostics';
import { collectConstantContextDiagnostics } from './constantContextDiagnostics';
import { collectConcatenationDiagnostics } from './concatenationDiagnostics';
import { collectDeclarationDiagnostics } from './declarationDiagnostics';

export function collectVerilogDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  text: string,
  modules: VerilogModule[],
  includes: VerilogInclude[],
  ast: VerilogAstDocument,
  semantic: VerilogSemanticModel
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  collectSyntaxDiagnostics(document, ast, modules, diagnostics);
  collectStructuralDiagnostics(document, modules, diagnostics);
  collectDeclarationDiagnostics(document, ast, semantic, diagnostics);
  collectIncludeDiagnostics(document, includes, diagnostics);
  collectInstancePortDiagnostics(document, modules, diagnostics);
  collectWidthDiagnostics(document, modules, ast, diagnostics);
  collectConstantDivisorDiagnostics(document, modules, ast, diagnostics);
  collectSelectBoundsDiagnostics(document, modules, ast, diagnostics);
  collectAssignmentTypeDiagnostics(document, ast, diagnostics);
  collectSubroutineDiagnostics(document, ast, semantic, diagnostics);
  collectConstantContextDiagnostics(document, ast, diagnostics);
  collectConcatenationDiagnostics(document, ast, diagnostics);
  if (settings.verilog.lint.courseRules) {
    collectCourseDiagnostics(document, settings, modules, ast, diagnostics);
    collectTestbenchDiagnostics(settings, ast, diagnostics);
  }
  collectContinuousProceduralDriverDiagnostics(document, ast, diagnostics);
  collectExplicitPortNetTypeDiagnostics(ast, diagnostics);
  collectImplicitNetDiagnostics(settings, diagnostics, semantic);
  return diagnostics;
}

function collectStructuralDiagnostics(document: TextDocument, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  const seenModules = new Map<string, VerilogModule>();
  for (const module of modules) {
    if (!module.hasEndmodule) {
      diagnostics.push(makeDiagnostic(module.selectionRange, `Module '${module.name}' is missing endmodule.`, DiagnosticSeverity.Error, 'missing-endmodule'));
    }
    const previous = seenModules.get(module.name);
    if (previous) {
      diagnostics.push(makeDiagnostic(module.selectionRange, `Duplicate module '${module.name}'. First definition is at line ${previous.selectionRange.start.line + 1}.`, DiagnosticSeverity.Error, 'duplicate-module'));
    } else {
      seenModules.set(module.name, module);
    }
  }
}

function collectIncludeDiagnostics(document: TextDocument, includes: VerilogInclude[], diagnostics: Diagnostic[]): void {
  if (!includes.length || document.uri.startsWith('untitled:')) {
    return;
  }
  let baseDir: string | undefined;
  try {
    baseDir = path.dirname(URI.parse(document.uri).fsPath);
  } catch {
    return;
  }
  for (const include of includes) {
    const includePath = path.isAbsolute(include.path) ? include.path : path.resolve(baseDir, include.path);
    if (!fs.existsSync(includePath)) {
      diagnostics.push(makeDiagnostic(include.pathRange, `Included file '${include.path}' was not found relative to this file.`, DiagnosticSeverity.Warning, 'missing-include'));
    }
  }
}

function collectInstancePortDiagnostics(document: TextDocument, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    for (const instance of module.instances) {
      const target = uniqueModule(modules.filter((candidate) => candidate.name === instance.moduleName));
      if (!target) {
        continue;
      }
      collectInstanceConnectionDiagnostics(document, module, instance, target, diagnostics);
    }
  }
}

function collectConstantDivisorDiagnostics(document: TextDocument, modules: VerilogModule[], ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    const moduleAst = ast.modules.find((item) => item.module === module);
    if (moduleAst) {
      for (const statement of moduleAst.items) {
        for (const expression of statement.expressions) {
          collectConstantDivisorDiagnosticsForExpression(document, module, expression, 0, diagnostics);
        }
      }
    }

    for (const decl of module.declarations.values()) {
      if (!decl.initializer || !decl.initializerRange) {
        continue;
      }
      const expression = decl.initializerAst ?? parseVerilogExpression(decl.initializer);
      if (!expression) {
        continue;
      }
      collectConstantDivisorDiagnosticsForExpression(
        document,
        module,
        expression,
        decl.initializerAst ? 0 : expressionBaseOffset(document, decl.initializerRange, decl.initializer),
        diagnostics
      );
    }

    for (const instance of module.instances) {
      for (const connection of [...instance.parameterConnections, ...instance.portConnections]) {
        if (!connection.expression.trim()) {
          continue;
        }
        const expression = connection.expressionAst ?? parseVerilogExpression(connection.expression);
        if (!expression) {
          continue;
        }
        collectConstantDivisorDiagnosticsForExpression(
          document,
          module,
          expression,
          connection.expressionAst ? 0 : expressionBaseOffset(document, connection.expressionRange, connection.expression),
          diagnostics
        );
      }
    }
  }
}

function collectConstantDivisorDiagnosticsForExpression(
  document: TextDocument,
  module: VerilogModule,
  expression: VerilogExpressionAst,
  baseOffset: number,
  diagnostics: Diagnostic[]
): void {
  walkVerilogExpression(expression, (candidate) => {
    if (candidate.kind !== 'binaryExpression' || (candidate.operator !== '/' && candidate.operator !== '%')) {
      return;
    }
    const divisor = evalExpressionAstConstant(candidate.right, module);
    if (divisor !== 0n) {
      return;
    }
    diagnostics.push(makeDiagnostic(
      expressionRangeAtBase(document, candidate.right, baseOffset),
      `Constant ${candidate.operator === '/' ? 'division' : 'modulo'} by zero.`,
      DiagnosticSeverity.Warning,
      'constant-division-by-zero'
    ));
  });
}

function collectSelectBoundsDiagnostics(document: TextDocument, modules: VerilogModule[], ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    const moduleAst = ast.modules.find((item) => item.module === module);
    if (moduleAst) {
      for (const statement of moduleAst.items) {
        for (const expression of statement.expressions) {
          collectSelectBoundsDiagnosticsForExpression(document, module, expression, 0, diagnostics);
        }
      }
      for (const block of moduleAst.proceduralBlocks) {
        collectSystemCallsFromProceduralStatement(block.statementTree, (expression) => {
          if (expression) { collectSelectBoundsDiagnosticsForExpression(document, module, expression, 0, diagnostics); }
        });
      }
    }

    for (const decl of module.declarations.values()) {
      if (!decl.initializer || !decl.initializerRange) {
        continue;
      }
      const expression = decl.initializerAst ?? parseVerilogExpression(decl.initializer);
      if (!expression) {
        continue;
      }
      collectSelectBoundsDiagnosticsForExpression(
        document,
        module,
        expression,
        decl.initializerAst ? 0 : expressionBaseOffset(document, decl.initializerRange, decl.initializer),
        diagnostics
      );
    }

    for (const instance of module.instances) {
      for (const connection of [...instance.parameterConnections, ...instance.portConnections]) {
        if (!connection.expression.trim()) {
          continue;
        }
        const expression = connection.expressionAst ?? parseVerilogExpression(connection.expression);
        if (!expression) {
          continue;
        }
        collectSelectBoundsDiagnosticsForExpression(
          document,
          module,
          expression,
          connection.expressionAst ? 0 : expressionBaseOffset(document, connection.expressionRange, connection.expression),
          diagnostics
        );
      }
    }
  }
}

function collectSelectBoundsDiagnosticsForExpression(
  document: TextDocument,
  module: VerilogModule,
  expression: VerilogExpressionAst,
  baseOffset: number,
  diagnostics: Diagnostic[]
): void {
  walkVerilogExpression(expression, (candidate) => {
    if (candidate.kind !== 'selectExpression') {
      return;
    }
    const selection = selectedDeclaration(candidate.target);
    const targetName = selection?.name;
    if (!targetName) {
      return;
    }
    const decl = declarationAtPosition(module, targetName, document.positionAt(candidate.start + baseOffset));
    const bounds = decl ? declarationIndexBounds(document, decl, module, selection?.depth ?? 0) : undefined;
    if (!bounds) {
      return;
    }
    switch (candidate.select.kind) {
      case 'bitSelect': {
        const index = evalExpressionAstConstant(candidate.select.index, module);
        if (index !== undefined && !indexInsideBounds(index, bounds)) {
          diagnostics.push(makeDiagnostic(
            expressionRangeAtBase(document, candidate.select.index, baseOffset),
            `Select index ${index} is outside '${targetName}' index range ${formatBounds(bounds)}.`,
            DiagnosticSeverity.Warning,
            'select-out-of-range'
          ));
        }
        break;
      }
      case 'rangeSelect': {
        const left = evalExpressionAstConstant(candidate.select.left, module);
        const right = evalExpressionAstConstant(candidate.select.right, module);
        if (left === undefined || right === undefined) {
          break;
        }
        const selected = orderedBounds(left, right);
        if (bounds.left !== undefined && bounds.right !== undefined && left !== right && (left > right) !== (bounds.left > bounds.right)) {
          diagnostics.push(makeDiagnostic(offsetRangeAtBase(document, candidate.select.start, candidate.select.end, baseOffset),
            `Part-select direction is reversed relative to '${targetName}' declaration.`, DiagnosticSeverity.Error, 'select-direction-mismatch'));
        }
        if (!rangeInsideBounds(selected, bounds)) {
          diagnostics.push(makeDiagnostic(
            offsetRangeAtBase(document, candidate.select.start, candidate.select.end, baseOffset),
            `Select range ${formatBounds(selected)} is outside '${targetName}' index range ${formatBounds(bounds)}.`,
            DiagnosticSeverity.Warning,
            'select-out-of-range'
          ));
        }
        break;
      }
      case 'indexedPartSelect': {
        const base = evalExpressionAstConstant(candidate.select.base, module);
        const width = evalExpressionAstConstant(candidate.select.width, module);
        if (width !== undefined && width <= 0n) {
          diagnostics.push(makeDiagnostic(expressionRangeAtBase(document, candidate.select.width, baseOffset),
            'Indexed part-select width must be greater than zero.', DiagnosticSeverity.Error, 'invalid-select-width'));
          break;
        }
        if (base === undefined || width === undefined) {
          break;
        }
        const selected = candidate.select.direction === '+:'
          ? orderedBounds(base, base + width - 1n)
          : orderedBounds(base - width + 1n, base);
        if (!rangeInsideBounds(selected, bounds)) {
          diagnostics.push(makeDiagnostic(
            offsetRangeAtBase(document, candidate.select.start, candidate.select.end, baseOffset),
            `Indexed part-select range ${formatBounds(selected)} is outside '${targetName}' index range ${formatBounds(bounds)}.`,
            DiagnosticSeverity.Warning,
            'select-out-of-range'
          ));
        }
        break;
      }
    }
  });
}

interface IndexBounds {
  low: bigint;
  high: bigint;
  left?: bigint;
  right?: bigint;
}

function selectedDeclaration(expression: VerilogExpressionAst): { name: string; depth: number } | undefined {
  if (expression.kind === 'identifier') { return { name: expression.name, depth: 0 }; }
  if (expression.kind === 'parenthesizedExpression') { return selectedDeclaration(expression.expression); }
  if (expression.kind === 'selectExpression') {
    const target = selectedDeclaration(expression.target);
    return target ? { ...target, depth: target.depth + 1 } : undefined;
  }
  return undefined;
}

function declarationIndexBounds(document: TextDocument, decl: VerilogDecl, module: VerilogModule, depth: number): IndexBounds | undefined {
  const dimensions = decl.unpackedDimensions ?? [];
  if (depth < dimensions.length) {
    const expressions = dimensions[depth].expressions;
    const left = evalExpressionAstConstant(expressions[0], module);
    const right = evalExpressionAstConstant(expressions[1], module);
    return left === undefined || right === undefined ? undefined : { ...orderedBounds(left, right), left, right };
  }
  if (depth > dimensions.length) { return undefined; }
  const explicit = explicitDeclarationIndexBounds(decl, module);
  if (explicit) {
    return explicit;
  }
  const width = widthOfDecl(decl, module).width;
  return width === undefined || width < 1 ? undefined : { low: 0n, high: BigInt(width - 1), left: BigInt(width - 1), right: 0n };
}

function explicitDeclarationIndexBounds(decl: VerilogDecl, module: VerilogModule): IndexBounds | undefined {
  const inner = bracketContents(decl.width);
  if (inner === undefined) {
    return undefined;
  }
  const separator = topLevelRangeColon(inner);
  if (separator < 0) {
    return undefined;
  }
  const left = evalExpressionAstConstant(parseVerilogExpression(inner.slice(0, separator)), module);
  const right = evalExpressionAstConstant(parseVerilogExpression(inner.slice(separator + 1)), module);
  return left === undefined || right === undefined ? undefined : { ...orderedBounds(left, right), left, right };
}

function bracketContents(width: string | undefined): string | undefined {
  const trimmed = width?.trim();
  return trimmed?.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : undefined;
}

function topLevelRangeColon(text: string): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let nestedTernary = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') {
      paren++;
    } else if (char === ')') {
      paren = Math.max(0, paren - 1);
    } else if (char === '[') {
      bracket++;
    } else if (char === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (char === '{') {
      brace++;
    } else if (char === '}') {
      brace = Math.max(0, brace - 1);
    }
    if (paren !== 0 || bracket !== 0 || brace !== 0) {
      continue;
    }
    if (char === '?') {
      nestedTernary++;
    } else if (char === ':') {
      if (nestedTernary > 0) {
        nestedTernary--;
      } else {
        return index;
      }
    }
  }
  return -1;
}

function orderedBounds(left: bigint, right: bigint): IndexBounds {
  return left <= right ? { low: left, high: right } : { low: right, high: left };
}

function indexInsideBounds(index: bigint, bounds: IndexBounds): boolean {
  return index >= bounds.low && index <= bounds.high;
}

function rangeInsideBounds(selected: IndexBounds, bounds: IndexBounds): boolean {
  return selected.low >= bounds.low && selected.high <= bounds.high;
}

function formatBounds(bounds: IndexBounds): string {
  return `${bounds.low}..${bounds.high}`;
}

function expressionBaseOffset(document: TextDocument, range: Range, expressionText: string): number {
  const rangeStart = document.offsetAt(range.start);
  const rangeText = document.getText(range);
  const index = rangeText.indexOf(expressionText);
  return rangeStart + Math.max(0, index);
}

function expressionRangeAtBase(document: TextDocument, expression: VerilogExpressionAst, baseOffset: number): Range {
  return offsetRangeAtBase(document, expression.start, expression.end, baseOffset);
}

function offsetRangeAtBase(document: TextDocument, start: number, end: number, baseOffset: number): Range {
  return Range.create(document.positionAt(baseOffset + start), document.positionAt(baseOffset + end));
}

function collectWidthDiagnostics(document: TextDocument, modules: VerilogModule[], ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    const moduleAst = ast.modules.find((item) => item.module === module);
    collectDeclarationInitializerWidthDiagnostics(module, diagnostics);
    if (moduleAst) {
      collectAssignmentWidthDiagnostics(document, moduleAst, diagnostics);
    }

  }
}

function collectAssignmentWidthDiagnostics(document: TextDocument, moduleAst: VerilogModuleAst, diagnostics: Diagnostic[]): void {
  for (const statement of moduleAst.items) {
    if (statement.kind !== 'continuousAssign') {
      continue;
    }
    collectStatementAssignmentWidthDiagnostic(document, moduleAst.module, statement, diagnostics);
  }
  for (const block of [...moduleAst.proceduralBlocks, ...moduleAst.subroutines]) {
    visitProceduralAssignments(block.statementTree, (assignment) => {
      if (assignment.lhs && assignment.rhs) {
        collectStatementAssignmentWidthDiagnostic(document, moduleAst.module, { assignments: [{ lhs: assignment.lhs, rhs: assignment.rhs, operator: assignment.operator }] }, diagnostics);
      }
    });
  }
}

function collectStatementAssignmentWidthDiagnostic(
  document: TextDocument,
  module: VerilogModule,
  statement: Pick<VerilogStatementAst, 'assignments'>,
  diagnostics: Diagnostic[]
): void {
  for (const assignment of statement.assignments) {
    const lhs = widthOfExpressionAst(assignment.lhs, module, undefined, document.positionAt(assignment.lhs.start));
    const rhs = widthOfExpressionAst(assignment.rhs, module, undefined, document.positionAt(assignment.rhs.start));
    if (!shouldReportWidthMismatch(lhs, rhs)) {
      continue;
    }
    const lhsRange = Range.create(document.positionAt(assignment.lhs.start), document.positionAt(assignment.lhs.end));
    const rhsRange = Range.create(document.positionAt(assignment.rhs.start), document.positionAt(assignment.rhs.end));
    diagnostics.push(makeDiagnostic(
      rhsRange,
      `Width mismatch: '${document.getText(lhsRange).trim()}' is ${lhs.width} bit(s), but this expression is ${rhs.width} bit(s).`,
      DiagnosticSeverity.Warning,
      'width-mismatch'
    ));
  }
}

// parameter/localparam widths are inferred FROM their initializer, so checking them is circular;
// genvar is a loop index, not a sized net.
const initializerWidthCheckedKinds = new Set(['wire', 'reg', 'logic', 'integer', 'time', 'input', 'output', 'inout']);

// `wire [31:0] x = {20'h0, imm16};` is a declaration with an initializer — the assignment-statement
// loop skips declarations, so initializer width is checked here. Each declarator `name = expr` is
// compared against the declared width; only truncation is reported (see shouldReportWidthMismatch).
function collectDeclarationInitializerWidthDiagnostics(
  module: VerilogModule,
  diagnostics: Diagnostic[]
): void {
  for (const decl of module.declarations.values()) {
    if (!decl.initializer || !decl.initializerRange || !initializerWidthCheckedKinds.has(decl.kind)) {
      continue;
    }
    const expected = widthOfDecl(decl, module);
    const actual = decl.initializerAst
      ? widthOfExpressionAst(decl.initializerAst, module)
      : widthOfExpression(decl.initializer, module);
    if (shouldReportWidthMismatch(expected, actual)) {
      diagnostics.push(makeDiagnostic(
        decl.initializerRange,
        `Width mismatch: '${decl.name}' is ${expected.width} bit(s), but its initializer is ${actual.width} bit(s).`,
        DiagnosticSeverity.Warning,
        'width-mismatch'
      ));
    }
  }
}

function collectCourseDiagnostics(document: TextDocument, settings: CoSettings, modules: VerilogModule[], ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  const profile = settings.project.profile;
  const topName = settings.project.topModule.trim() || 'mips';
  const top = modules.find((module) => module.name === topName);

  if ((profile === 'P4' || profile === 'P5' || profile === 'P6' || profile === 'P7') && !top) {
    const firstLine = lineAt(document, 0).text;
    diagnostics.push(makeDiagnostic(Range.create(0, 0, 0, Math.max(1, firstLine.length)), `Top module '${topName}' was not found.`, DiagnosticSeverity.Warning, 'missing-top'));
  }

  if (top && (profile === 'P4' || profile === 'P5' || profile === 'P6' || profile === 'P7')) {
    checkExpectedPorts(top, profile, diagnostics);
  }

  if (top && (profile === 'P6' || profile === 'P7')) {
    for (const call of collectSystemCalls(ast, '$display').filter((hit) => hit.module === top)) {
      diagnostics.push(makeDiagnostic(callCalleeRange(document, call.expression), `${profile} top-level design should not contain $display; the testbench should monitor external outputs.`, DiagnosticSeverity.Error, `${profile.toLowerCase()}-display`));
    }
  }

  if (profile === 'P4' || profile === 'P5') {
    validateDisplayFormats(document, ast, profile, diagnostics);
  }

}

function checkExpectedPorts(module: VerilogModule, profile: ProjectProfile, diagnostics: Diagnostic[]): void {
  const expected = expectedPorts[profile];
  if (!expected) {
    return;
  }
  const portsByName = new Map(module.ports.map((port) => [port.name, port]));
  for (const [name, width] of Object.entries(expected)) {
    const port = portsByName.get(name);
    if (!port) {
      diagnostics.push(makeDiagnostic(module.selectionRange, `${profile} top module is missing port '${name}'.`, DiagnosticSeverity.Error, `${profile.toLowerCase()}-port`));
      continue;
    }
    if (width && port.width && normalizeWidth(port.width) !== width) {
      diagnostics.push(makeDiagnostic(port.selectionRange, `${profile} port '${name}' is expected to be ${width}, got ${port.width}.`, DiagnosticSeverity.Warning, `${profile.toLowerCase()}-port-width`));
    }
  }
}

function validateDisplayFormats(document: TextDocument, ast: VerilogAstDocument, profile: ProjectProfile, diagnostics: Diagnostic[]): void {
  for (const call of collectSystemCalls(ast, '$display')) {
    const format = firstDisplayFormatString(call.expression);
    if (format !== undefined && !traceFormatLooksOk(format, profile)) {
      diagnostics.push(makeDiagnostic(callCalleeRange(document, call.expression), `${profile} $display format does not match the expected CPU trace format.`, DiagnosticSeverity.Warning, 'display-format'));
    }
  }
}

function collectSystemCalls(ast: VerilogAstDocument, callee: string): Array<{ module: VerilogModule; expression: VerilogCallExpressionAst }> {
  const result: Array<{ module: VerilogModule; expression: VerilogCallExpressionAst }> = [];
  for (const moduleAst of ast.modules) {
    const addExpression = (expression: VerilogExpressionAst | undefined): void => {
      if (!expression) {
        return;
      }
      walkVerilogExpression(expression, (candidate) => {
        if (candidate.kind === 'callExpression' && candidate.system && candidate.callee === callee) {
          result.push({ module: moduleAst.module, expression: candidate });
        }
      });
    };
    for (const statement of moduleAst.items) {
      for (const expression of statement.expressions) {
        addExpression(expression);
      }
    }
    for (const block of moduleAst.proceduralBlocks) {
      collectSystemCallsFromProceduralStatement(block.statementTree, addExpression);
    }
  }
  return result;
}

function collectSystemCallsFromProceduralStatement(
  statement: VerilogProceduralStatementAst,
  addExpression: (expression: VerilogExpressionAst | undefined) => void
): void {
  switch (statement.kind) {
    case 'block':
      for (const child of statement.statements) {
        collectSystemCallsFromProceduralStatement(child, addExpression);
      }
      return;
    case 'assignment':
      addExpression(statement.lhs);
      addExpression(statement.rhs);
      return;
    case 'if':
      addExpression(statement.condition);
      collectSystemCallsFromProceduralStatement(statement.consequent, addExpression);
      if (statement.alternate) {
        collectSystemCallsFromProceduralStatement(statement.alternate, addExpression);
      }
      return;
    case 'case':
      addExpression(statement.expression);
      for (const item of statement.items) {
        for (const label of item.labels) {
          addExpression(label);
        }
        collectSystemCallsFromProceduralStatement(item.body, addExpression);
      }
      return;
    case 'loop':
    case 'wait':
      addExpression(statement.condition);
      collectSystemCallsFromProceduralStatement(statement.body, addExpression);
      return;
    case 'other':
      addExpression(statement.expression);
      return;
    case 'declaration':
      return;
  }
}

function firstDisplayFormatString(call: VerilogCallExpressionAst): string | undefined {
  const first = call.args[0];
  return first?.kind === 'stringLiteral' ? unquoteVerilogString(first.raw) : undefined;
}

function unquoteVerilogString(raw: string): string {
  return raw.length >= 2 ? raw.slice(1, -1) : '';
}

function callCalleeRange(document: TextDocument, call: VerilogCallExpressionAst): Range {
  return Range.create(document.positionAt(call.start), document.positionAt(call.start + call.callee.length));
}

function traceFormatLooksOk(format: string, profile: ProjectProfile): boolean {
  const normalized = removeAsciiWhitespace(format);
  const expected = profile === 'P5'
    ? ['%d@%h:$%d<=%h', '%d@%h:*%h<=%h']
    : ['@%h:$%d<=%h', '@%h:*%h<=%h'];
  return expected.some((pattern) => normalized.includes(pattern));
}

function removeAsciiWhitespace(text: string): string {
  let result = '';
  for (const char of text) {
    if (char !== ' ' && char !== '\t' && char !== '\r' && char !== '\n' && char !== '\f' && char !== '\v') {
      result += char;
    }
  }
  return result;
}
