// @index lint — VC-001~022课程诊断规则，基于AST
import { Diagnostic, DiagnosticSeverity, Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings, isVerilogLintRuleEnabled } from '../common/settings';
import {
  collectAssignmentUsesFromModuleAst,
  collectAssignmentUsesFromProceduralStatementAst
} from './assignmentAst';
import { systemTasks, VerilogModule, verilogKeywords } from './model';
import {
  safeRegExp,
} from './textUtils';
import type { VerilogSemanticModel } from './semanticModel';
import type { VerilogExpressionAst } from './exprAst';
import { walkVerilogExpression } from './exprAstUtils';
import { VerilogProceduralBlockAst } from './blockAst';
import { collectContinuousProceduralDriverDiagnostics } from './driverDiagnostics';
import { collectCombinationalDataflowDiagnostics } from './dataflowDiagnostics';
import type { VerilogAstDocument, VerilogModuleAst } from './ast';
import type { VerilogAssignmentStatementAst, VerilogLocalDeclarationAst, VerilogProceduralStatementAst } from './proceduralAst';
import { getVerilogLintRule } from './lintRuleCatalog';

export function collectAssignmentDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  ast: VerilogAstDocument,
  diagnostics: Diagnostic[]
): void {
  for (const moduleAst of ast.modules) {
    const module = moduleAst.module;
    const assignmentKinds = new Map<string, Set<string>>();
    const isTestbench = isTestbenchModule(module, settings);
    for (const assignment of collectAssignmentUsesFromModuleAst(document, moduleAst)) {
      if (!assignmentKinds.has(assignment.name)) {
        assignmentKinds.set(assignment.name, new Set());
      }
      assignmentKinds.get(assignment.name)?.add(assignment.operator);
    }
    for (const [name, operators] of assignmentKinds) {
      if (operators.has('=') && operators.has('<=')) {
        if (isTestbench && isClockSignalName(name)) {
          continue;
        }
        const decl = module.declarations.get(name);
        const range = decl?.selectionRange ?? module.selectionRange;
        diagnostics.push(makeDiagnostic(range, `Signal '${name}' is assigned with both blocking and nonblocking assignments.`, DiagnosticSeverity.Warning, 'mixed-assignment'));
      }
    }
  }
  collectContinuousProceduralDriverDiagnostics(document, ast, diagnostics);
}

export function collectCourseStyleDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  text: string,
  ast: VerilogAstDocument,
  diagnostics: Diagnostic[]
): void {
  for (const moduleAst of ast.modules) {
    const module = moduleAst.module;
    collectNamingDiagnostics(settings, module, diagnostics);
    collectAlwaysStyleDiagnostics(document, settings, moduleAst, diagnostics);
    collectInstantiationStyleDiagnostics(settings, module, diagnostics);
    collectExplicitWidthDiagnostics(settings, module, diagnostics);
    collectMagicNumberDiagnostics(document, settings, moduleAst, diagnostics);
    collectInoutDiagnostics(settings, module, diagnostics);
  }
  collectTestbenchDiagnostics(document, settings, text, ast, diagnostics);
}

export function collectSynthesizableHintDiagnostics(document: TextDocument, settings: CoSettings, ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  for (const moduleAst of ast.modules) {
    const module = moduleAst.module;
    const isTestbench = isTestbenchModule(module, settings);
    const isMdu = isMduModule(module);
    if (!isTestbench) {
      collectInitialBlockHintDiagnostics(moduleAst, diagnostics);
    }
    if (!isMdu) {
      collectSynthesizableOperatorDiagnostics(document, moduleAst, diagnostics);
    }
    for (const decl of module.declarations.values()) {
      if (registerInitializerKinds.has(decl.kind) && decl.initializerRange) {
        diagnostics.push(makeDiagnostic(decl.selectionRange, 'Synthesizable style: avoid declaration initializers for registers; reset them in clocked logic.', lintSeverity('synth-decl-init', DiagnosticSeverity.Information), 'synth-decl-init'));
      }
    }
  }
}

const registerInitializerKinds = new Set(['reg', 'logic', 'integer']);
const expensiveSynthesizableOperators = new Set(['*', '/', '%']);

function lintSeverity(ruleId: string, fallback: DiagnosticSeverity): DiagnosticSeverity {
  const severity = getVerilogLintRule(ruleId)?.severity;
  switch (severity) {
    case 'error':
      return DiagnosticSeverity.Error;
    case 'warning':
      return DiagnosticSeverity.Warning;
    case 'information':
      return DiagnosticSeverity.Information;
    case 'hint':
      return DiagnosticSeverity.Hint;
    default:
      return fallback;
  }
}

function collectInitialBlockHintDiagnostics(moduleAst: VerilogModuleAst, diagnostics: Diagnostic[]): void {
  for (const block of moduleAst.proceduralBlocks) {
    if (block.kind === 'initial') {
      diagnostics.push(makeDiagnostic(block.headerRange, 'Synthesizable style: avoid initial blocks in design modules; use reset logic instead.', lintSeverity('synth-initial', DiagnosticSeverity.Information), 'synth-initial'));
    }
  }
}

function collectSynthesizableOperatorDiagnostics(document: TextDocument, moduleAst: VerilogModuleAst, diagnostics: Diagnostic[]): void {
  const reported = new Set<string>();
  const visitExpression = (expression: VerilogExpressionAst | undefined): void => {
    if (!expression) {
      return;
    }
    walkVerilogExpression(expression, (candidate) => {
      if (candidate.kind !== 'binaryExpression' || !expensiveSynthesizableOperators.has(candidate.operator)) {
        return;
      }
      const range = Range.create(document.positionAt(candidate.operatorStart), document.positionAt(candidate.operatorEnd));
      const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
      if (reported.has(key)) {
        return;
      }
      reported.add(key);
      diagnostics.push(makeDiagnostic(range, 'Synthesizable style: avoid multiply/divide/modulo operators on FPGA datapaths unless the hardware cost is intentional.', lintSeverity('synth-mul-div', DiagnosticSeverity.Information), 'synth-mul-div'));
    });
  };

  for (const statement of moduleAst.items) {
    if (statement.kind === 'proceduralBlock') {
      continue;
    }
    for (const expression of statement.expressions) {
      visitExpression(expression);
    }
  }
  for (const decl of moduleAst.module.declarations.values()) {
    for (const expression of decl.widthAst ?? []) {
      visitExpression(expression);
    }
    visitExpression(decl.initializerAst);
  }
  for (const instance of moduleAst.module.instances) {
    for (const connection of [...instance.parameterConnections, ...instance.portConnections]) {
      visitExpression(connection.expressionAst);
    }
  }
  for (const block of moduleAst.proceduralBlocks) {
    visitProceduralStatementExpressions(block.statementTree, visitExpression);
  }
}

function visitProceduralStatementExpressions(
  statement: VerilogProceduralStatementAst,
  visitExpression: (expression: VerilogExpressionAst | undefined) => void,
  options: ProceduralExpressionVisitOptions = {}
): void {
  switch (statement.kind) {
    case 'block':
      for (const child of statement.statements) {
        visitProceduralStatementExpressions(child, visitExpression, options);
      }
      return;
    case 'assignment':
      visitExpression(statement.lhs);
      visitExpression(statement.rhs);
      return;
    case 'if':
      visitExpression(statement.condition);
      visitProceduralStatementExpressions(statement.consequent, visitExpression, options);
      if (statement.alternate) {
        visitProceduralStatementExpressions(statement.alternate, visitExpression, options);
      }
      return;
    case 'case':
      visitExpression(statement.expression);
      for (const item of statement.items) {
        for (const label of item.labels) {
          visitExpression(label);
        }
        visitProceduralStatementExpressions(item.body, visitExpression, options);
      }
      return;
    case 'loop':
      for (const declaration of statement.initDeclarations) {
        visitLocalDeclarationExpressions(declaration, visitExpression, options);
      }
      for (const expression of statement.controlExpressions) {
        visitExpression(expression);
      }
      visitProceduralStatementExpressions(statement.body, visitExpression, options);
      return;
    case 'other':
      visitExpression(statement.expression);
      return;
    case 'declaration':
      for (const declaration of statement.declarations) {
        visitLocalDeclarationExpressions(declaration, visitExpression, options);
      }
      return;
  }
}

interface ProceduralExpressionVisitOptions {
  visitDeclarationWidthExpressions?: boolean;
  visitParameterDeclarationInitializers?: boolean;
}

function visitLocalDeclarationExpressions(
  declaration: VerilogLocalDeclarationAst,
  visitExpression: (expression: VerilogExpressionAst | undefined) => void,
  options: ProceduralExpressionVisitOptions
): void {
  if (options.visitDeclarationWidthExpressions !== false) {
    for (const widthExpression of declaration.widthExpressions) {
      visitExpression(widthExpression);
    }
  }
  if (
    options.visitParameterDeclarationInitializers === false &&
    (declaration.declaration.kind === 'parameter' || declaration.declaration.kind === 'localparam')
  ) {
    return;
  }
  visitExpression(declaration.initializer);
}

export function collectImplicitNetDiagnostics(
  settings: CoSettings,
  diagnostics: Diagnostic[],
  semantic: VerilogSemanticModel
): void {
  const severityMode = settings.verilog.implicitNet.diagnostic;
  if (severityMode === 'off') {
    return;
  }
  const severity = severityMode === 'error'
    ? DiagnosticSeverity.Error
    : severityMode === 'hint'
      ? DiagnosticSeverity.Hint
      : DiagnosticSeverity.Warning;
  const ignorePatterns = settings.verilog.implicitNet.ignorePatterns.map((pattern) => safeRegExp(pattern)).filter((item): item is RegExp => Boolean(item));
  const reported = new Set<string>();
  for (const reference of semantic.unresolvedReferences) {
    if (
      verilogKeywords.has(reference.name) ||
      systemTasks.has(reference.name) ||
      isMacroReferenceName(reference.name) ||
      isSystemTaskReferenceName(reference.name) ||
      ignorePatterns.some((pattern) => pattern.test(reference.name))
    ) {
      continue;
    }
    const key = `${reference.name}:${reference.range.start.line}:${reference.range.start.character}`;
    if (reported.has(key)) {
      continue;
    }
    reported.add(key);
    diagnostics.push(makeDiagnostic(reference.range, `Implicit net or undeclared identifier '${reference.name}'.`, severity, `implicit-net:${reference.name}`));
  }
}

function isMacroReferenceName(name: string): boolean {
  return name.startsWith('`') && name.length > 1;
}

function isSystemTaskReferenceName(name: string): boolean {
  return name.startsWith('$') && systemTasks.has(name.slice(1));
}

export function collectExplicitPortNetTypeDiagnostics(
  ast: VerilogAstDocument,
  diagnostics: Diagnostic[]
): void {
  if (!hasDefaultNettypeNone(ast)) {
    return;
  }

  for (const moduleAst of ast.modules) {
    const reported = new Set<string>();
    for (const port of moduleAst.module.ports) {
      if (!port.direction || port.explicitPortNetType !== false || !port.directionRange) {
        continue;
      }
      if (isHeaderPortDeclaration(port, moduleAst.module.headerEnd)) {
        continue;
      }
      const key = `${port.directionRange.start.line}:${port.directionRange.start.character}:${port.directionRange.end.line}:${port.directionRange.end.character}`;
      if (reported.has(key)) {
        continue;
      }
      reported.add(key);
      diagnostics.push(makeExplicitPortNetDiagnostic(port.directionRange));
    }
  }
}

function isHeaderPortDeclaration(port: VerilogModule['ports'][number], headerEnd: Position): boolean {
  return port.range.end.line < headerEnd.line ||
    (port.range.end.line === headerEnd.line && port.range.end.character <= headerEnd.character);
}

function makeExplicitPortNetDiagnostic(range: Range): Diagnostic {
  return makeDiagnostic(
    range,
    'Port declaration relies on an implicit wire net type while `default_nettype none is active.',
    DiagnosticSeverity.Error,
    'explicit-port-wire'
  );
}

function hasDefaultNettypeNone(ast: VerilogAstDocument): boolean {
  return ast.preprocessor.some((item) =>
    item.kind === 'directive' &&
    item.name === 'default_nettype' &&
    item.argument === 'none'
  );
}

function collectAlwaysStyleDiagnostics(document: TextDocument, settings: CoSettings, moduleAst: VerilogModuleAst, diagnostics: Diagnostic[]): void {
  const module = moduleAst.module;
  const blocks = moduleAst.alwaysBlocks;
  const assignedBlocks = new Map<string, Set<number>>();
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const blockAssignments = collectAssignmentUsesFromProceduralStatementAst(document, block.statementTree, index);
    if (block.combinational) {
      if (isVerilogLintRuleEnabled(settings, 'vc-006') && !block.sensitivity.wildcard) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-006: combinational logic should use always @(*) or assign.', lintSeverity('vc-006', DiagnosticSeverity.Warning), 'vc-006-comb-sensitivity'));
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-007') && blockAssignments.some((assignment) => assignment.operator === '<=')) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-007: combinational always blocks should use blocking assignments (=), not nonblocking assignments (<=).', lintSeverity('vc-007', DiagnosticSeverity.Warning), 'vc-007-comb-nonblocking'));
      }
      collectCombinationalDataflowDiagnostics(document, settings, module, block, diagnostics);
    }

    if (block.sequential) {
      const edgeSignals = block.sensitivity.events
        .filter((event) => event.edge === 'posedge' || event.edge === 'negedge')
        .flatMap((event) => event.signal ? [event.signal] : []);
      if (isVerilogLintRuleEnabled(settings, 'vc-009') && !block.sensitivity.hasPosedgeSignal) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-009: sequential logic should be implemented in always @(posedge clock) blocks.', lintSeverity('vc-009', DiagnosticSeverity.Warning), 'vc-009-seq-posedge'));
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-011') && block.sensitivity.hasNegedge) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-011: avoid negedge-triggered logic unless a protocol explicitly requires it.', lintSeverity('vc-011', DiagnosticSeverity.Warning), 'vc-011-negedge'));
      }
      for (const signal of edgeSignals) {
        if (isVerilogLintRuleEnabled(settings, 'vc-012') && !isClockOrResetSignal(signal)) {
          diagnostics.push(makeDiagnostic(block.headerRange, `VC-012: edge trigger on '${signal}' is not a clock/reset signal.`, lintSeverity('vc-012', DiagnosticSeverity.Warning), 'vc-012-edge-signal'));
        }
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-014') && edgeSignals.length > 1) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-014: prefer synchronous reset; async reset appears in the sensitivity list.', lintSeverity('vc-014', DiagnosticSeverity.Information), 'vc-014-sync-reset'));
      }
      for (const assignment of blockAssignments) {
        if (isVerilogLintRuleEnabled(settings, 'vc-010') && assignment.operator === '=') {
          diagnostics.push(makeDiagnostic(assignment.range, 'VC-010: sequential always blocks should use nonblocking assignments (<=).', lintSeverity('vc-010', DiagnosticSeverity.Warning), 'vc-010-seq-blocking'));
        }
      }
      const clockSignals = edgeSignals.filter(isClockSignalName);
      for (const clock of clockSignals) {
        if (isVerilogLintRuleEnabled(settings, 'vc-013') && proceduralAssignmentRhsContainsIdentifier(block.statementTree, clock)) {
          diagnostics.push(makeDiagnostic(block.headerRange, `VC-013: clock signal '${clock}' should not be used as data inside sequential logic.`, lintSeverity('vc-013', DiagnosticSeverity.Information), 'vc-013-clock-data'));
        }
      }
    }

    for (const assignment of blockAssignments) {
      const set = assignedBlocks.get(assignment.name) ?? new Set<number>();
      set.add(index);
      assignedBlocks.set(assignment.name, set);
    }
  }
  for (const [name, blockIndexes] of assignedBlocks) {
    if (isVerilogLintRuleEnabled(settings, 'vc-005') && blockIndexes.size > 1) {
      const decl = module.declarations.get(name);
      diagnostics.push(makeDiagnostic(decl?.selectionRange ?? module.selectionRange, `VC-005: signal '${name}' is assigned in multiple always blocks.`, lintSeverity('vc-005', DiagnosticSeverity.Warning), 'vc-005-multiple-always'));
    }
  }
}

function collectNamingDiagnostics(settings: CoSettings, module: VerilogModule, diagnostics: Diagnostic[]): void {
  const styleCounts = new Map<string, number>();
  for (const decl of module.declarations.values()) {
    const style = identifierStyle(decl.name);
    if (!style) {
      if (isVerilogLintRuleEnabled(settings, 'vc-001')) {
        diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-001: signal '${decl.name}' should use snake_case, camelCase, or PascalCase.`, lintSeverity('vc-001', DiagnosticSeverity.Information), 'vc-001-name-style'));
      }
    } else {
      styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
    }
    if (isVerilogLintRuleEnabled(settings, 'vc-002') && looksLowActiveWithoutSuffix(decl.name)) {
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-002: low-active signal '${decl.name}' should use the _n suffix.`, lintSeverity('vc-002', DiagnosticSeverity.Information), 'vc-002-low-active-suffix'));
    }
    if (isVerilogLintRuleEnabled(settings, 'vc-003') && /mux/i.test(decl.name) && !/\d/.test(decl.name)) {
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-003: multiplexer signal '${decl.name}' should reflect its width or input count.`, lintSeverity('vc-003', DiagnosticSeverity.Information), 'vc-003-mux-name'));
    }
  }
  if (isVerilogLintRuleEnabled(settings, 'vc-001') && styleCounts.size > 1) {
    diagnostics.push(makeDiagnostic(module.selectionRange, 'VC-001: this module mixes signal naming styles; keep one of snake_case, camelCase, or PascalCase consistently.', lintSeverity('vc-001', DiagnosticSeverity.Information), 'vc-001-mixed-name-style'));
  }
}

function collectInstantiationStyleDiagnostics(settings: CoSettings, module: VerilogModule, diagnostics: Diagnostic[]): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-017')) {
    return;
  }
  for (const instance of module.instances) {
    if (instance.portConnections.some((connection) => !connection.name)) {
      diagnostics.push(makeDiagnostic(instance.selectionRange, `Testbench/VC-017: instance '${instance.instanceName}' should use named port mapping.`, lintSeverity('vc-017', DiagnosticSeverity.Information), 'vc-017-named-ports'));
    }
    if (instance.portConnections.length > 1 && instance.range.start.line === instance.range.end.line) {
      diagnostics.push(makeDiagnostic(instance.selectionRange, `VC-017: instance '${instance.instanceName}' should use multi-line formatting with one port connection per line.`, lintSeverity('vc-017', DiagnosticSeverity.Information), 'vc-017-multiline-instance'));
    }
    const lines = new Set(instance.portConnections.map((connection) => connection.range.start.line));
    if (lines.size < instance.portConnections.length) {
      diagnostics.push(makeDiagnostic(instance.selectionRange, `VC-017: instance '${instance.instanceName}' should place each port connection on a separate line.`, lintSeverity('vc-017', DiagnosticSeverity.Information), 'vc-017-one-port-per-line'));
    }
  }
}

function collectExplicitWidthDiagnostics(settings: CoSettings, module: VerilogModule, diagnostics: Diagnostic[]): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-021')) {
    return;
  }
  for (const decl of module.declarations.values()) {
    if (decl.kind === 'parameter' || decl.kind === 'localparam' || decl.kind === 'integer' || decl.kind === 'genvar') {
      continue;
    }
    if (!decl.width && !['clk', 'clock', 'reset', 'rst'].includes(decl.name.toLowerCase())) {
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-021: signal '${decl.name}' should declare an explicit width, even if it is 1 bit.`, lintSeverity('vc-021', DiagnosticSeverity.Information), 'vc-021-explicit-width'));
    }
  }
}

function collectMagicNumberDiagnostics(document: TextDocument, settings: CoSettings, moduleAst: VerilogModuleAst, diagnostics: Diagnostic[]): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-004')) {
    return;
  }
  const reported = new Set<string>();
  const visitExpression = (expression: VerilogExpressionAst | undefined): void => {
    if (expression) {
      collectMagicNumberDiagnosticsFromExpression(document, expression, false, reported, diagnostics);
    }
  };

  for (const statement of moduleAst.items) {
    if (statement.kind === 'proceduralBlock') {
      continue;
    }
    for (const expression of statement.expressions) {
      visitExpression(expression);
    }
  }
  for (const decl of moduleAst.module.declarations.values()) {
    if (decl.kind === 'parameter' || decl.kind === 'localparam') {
      continue;
    }
    visitExpression(decl.initializerAst);
  }
  for (const instance of moduleAst.module.instances) {
    for (const connection of [...instance.parameterConnections, ...instance.portConnections]) {
      visitExpression(connection.expressionAst);
    }
  }
  for (const block of moduleAst.proceduralBlocks) {
    visitProceduralStatementExpressions(block.statementTree, visitExpression, {
      visitDeclarationWidthExpressions: false,
      visitParameterDeclarationInitializers: false
    });
  }
}

function collectMagicNumberDiagnosticsFromExpression(
  document: TextDocument,
  expression: VerilogExpressionAst,
  insideSelectIndex: boolean,
  reported: Set<string>,
  diagnostics: Diagnostic[]
): void {
  switch (expression.kind) {
    case 'numberLiteral': {
      if (insideSelectIndex || isTrivialLiteralToken(expression.raw)) {
        return;
      }
      const range = Range.create(document.positionAt(expression.start), document.positionAt(expression.end));
      const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
      if (reported.has(key)) {
        return;
      }
      reported.add(key);
      diagnostics.push(makeDiagnostic(range, 'VC-004: replace magic numbers with a descriptive localparam, parameter, or macro.', lintSeverity('vc-004', DiagnosticSeverity.Information), 'vc-004-magic-number'));
      return;
    }
    case 'parenthesizedExpression':
      collectMagicNumberDiagnosticsFromExpression(document, expression.expression, insideSelectIndex, reported, diagnostics);
      return;
    case 'unaryExpression':
      collectMagicNumberDiagnosticsFromExpression(document, expression.argument, insideSelectIndex, reported, diagnostics);
      return;
    case 'binaryExpression':
      collectMagicNumberDiagnosticsFromExpression(document, expression.left, insideSelectIndex, reported, diagnostics);
      collectMagicNumberDiagnosticsFromExpression(document, expression.right, insideSelectIndex, reported, diagnostics);
      return;
    case 'conditionalExpression':
      collectMagicNumberDiagnosticsFromExpression(document, expression.condition, insideSelectIndex, reported, diagnostics);
      collectMagicNumberDiagnosticsFromExpression(document, expression.whenTrue, insideSelectIndex, reported, diagnostics);
      collectMagicNumberDiagnosticsFromExpression(document, expression.whenFalse, insideSelectIndex, reported, diagnostics);
      return;
    case 'concatenation':
      for (const element of expression.elements) {
        collectMagicNumberDiagnosticsFromExpression(document, element, insideSelectIndex, reported, diagnostics);
      }
      return;
    case 'multipleConcatenation':
      collectMagicNumberDiagnosticsFromExpression(document, expression.repeat, insideSelectIndex, reported, diagnostics);
      for (const element of expression.elements) {
        collectMagicNumberDiagnosticsFromExpression(document, element, insideSelectIndex, reported, diagnostics);
      }
      return;
    case 'selectExpression': {
      collectMagicNumberDiagnosticsFromExpression(document, expression.target, insideSelectIndex, reported, diagnostics);
      const select = expression.select;
      if (select.kind === 'bitSelect') {
        collectMagicNumberDiagnosticsFromExpression(document, select.index, true, reported, diagnostics);
      } else if (select.kind === 'rangeSelect') {
        collectMagicNumberDiagnosticsFromExpression(document, select.left, true, reported, diagnostics);
        collectMagicNumberDiagnosticsFromExpression(document, select.right, true, reported, diagnostics);
      } else {
        collectMagicNumberDiagnosticsFromExpression(document, select.base, true, reported, diagnostics);
        collectMagicNumberDiagnosticsFromExpression(document, select.width, true, reported, diagnostics);
      }
      return;
    }
    case 'callExpression':
      for (const arg of expression.args) {
        collectMagicNumberDiagnosticsFromExpression(document, arg, insideSelectIndex, reported, diagnostics);
      }
      return;
    case 'memberExpression':
      collectMagicNumberDiagnosticsFromExpression(document, expression.target, insideSelectIndex, reported, diagnostics);
      return;
    case 'errorExpression':
      for (const child of expression.children) {
        collectMagicNumberDiagnosticsFromExpression(document, child, insideSelectIndex, reported, diagnostics);
      }
      return;
    case 'identifier':
    case 'stringLiteral':
      return;
  }
}

function collectInoutDiagnostics(settings: CoSettings, module: VerilogModule, diagnostics: Diagnostic[]): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-015')) {
    return;
  }
  const topName = settings.project.topModule.trim() || 'mips';
  if (module.name === topName) {
    return;
  }
  for (const port of module.ports) {
    if (port.direction === 'inout') {
      diagnostics.push(makeDiagnostic(port.selectionRange, `VC-015: internal module '${module.name}' should not use inout port '${port.name}'.`, lintSeverity('vc-015', DiagnosticSeverity.Warning), 'vc-015-inout'));
    }
  }
}

function collectTestbenchDiagnostics(document: TextDocument, settings: CoSettings, text: string, ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  for (const moduleAst of ast.modules) {
    const module = moduleAst.module;
    if (!isTestbenchModule(module, settings)) {
      continue;
    }
    const bodyStart = document.offsetAt(module.headerEnd);
    const bodyEnd = document.offsetAt(module.range.end);
    const body = text.slice(bodyStart, bodyEnd);
    if (!/`timescale\s+1ns\s*\/\s*1ps/.test(text)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: standard course testbenches should use `timescale 1ns / 1ps.', DiagnosticSeverity.Information, 'tb-timescale'));
    }
    if (!hasTestbenchClockGeneration(module, moduleAst.proceduralBlocks)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: include clk generation logic.', DiagnosticSeverity.Information, 'tb-clock'));
    }
    if (!/\breset\b/.test(body)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: include reset generation logic.', DiagnosticSeverity.Information, 'tb-reset'));
    }
    if (!/\$readmemh\s*\(\s*"code\.txt"/.test(body)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: use $readmemh("code.txt", im) to load machine code when simulating CPU projects.', DiagnosticSeverity.Information, 'tb-readmemh'));
    }
  }
}

function hasTestbenchClockGeneration(module: VerilogModule, blocks: VerilogProceduralBlockAst[]): boolean {
  const clockNames = declaredClockNames(module);
  if (!clockNames.size) {
    return false;
  }
  for (const block of blocks) {
    if (block.kind === 'always') {
      if (block.controlKind === 'event') {
        continue;
      }
      if (block.controlKind === 'delay' && proceduralTreeHasClockToggle(block.statementTree, clockNames)) {
        return true;
      }
      if (block.controlKind === 'none' && proceduralTreeHasDelayedClockToggle(block.statementTree, clockNames)) {
        return true;
      }
      continue;
    }
    if (block.kind === 'initial' && proceduralTreeHasForeverDelayedClockToggle(block.statementTree, clockNames)) {
      return true;
    }
  }
  return false;
}

function declaredClockNames(module: VerilogModule): Set<string> {
  return new Set([...module.declarations.keys()].filter(isClockSignalName));
}

function proceduralAssignmentRhsContainsIdentifier(statement: VerilogProceduralStatementAst, identifier: string): boolean {
  switch (statement.kind) {
    case 'assignment':
      return expressionContainsIdentifier(statement.rhs, identifier);
    case 'block':
      return statement.statements.some((child) => proceduralAssignmentRhsContainsIdentifier(child, identifier));
    case 'loop':
      return proceduralAssignmentRhsContainsIdentifier(statement.body, identifier);
    case 'if':
      return proceduralAssignmentRhsContainsIdentifier(statement.consequent, identifier) ||
        Boolean(statement.alternate && proceduralAssignmentRhsContainsIdentifier(statement.alternate, identifier));
    case 'case':
      return statement.items.some((item) => proceduralAssignmentRhsContainsIdentifier(item.body, identifier));
    case 'declaration':
    case 'other':
      return false;
  }
}

function proceduralTreeHasClockToggle(statement: VerilogProceduralStatementAst, clockNames: Set<string>): boolean {
  return visitProceduralClockStatements(statement, clockNames, { requireDelay: false, requireForever: false });
}

function proceduralTreeHasDelayedClockToggle(statement: VerilogProceduralStatementAst, clockNames: Set<string>): boolean {
  return visitProceduralClockStatements(statement, clockNames, { requireDelay: true, requireForever: false });
}

function proceduralTreeHasForeverDelayedClockToggle(statement: VerilogProceduralStatementAst, clockNames: Set<string>): boolean {
  return visitProceduralClockStatements(statement, clockNames, { requireDelay: true, requireForever: true });
}

function visitProceduralClockStatements(
  statement: VerilogProceduralStatementAst,
  clockNames: Set<string>,
  options: { requireDelay: boolean; requireForever: boolean },
  state: { blockedByEventOrWait: boolean; delaySeen: boolean } = { blockedByEventOrWait: false, delaySeen: false }
): boolean {
  switch (statement.kind) {
    case 'block': {
      let blockedByEventOrWait = state.blockedByEventOrWait;
      let delaySeen = state.delaySeen;
      for (const child of statement.statements) {
        if (visitProceduralClockStatements(child, clockNames, options, { blockedByEventOrWait, delaySeen })) {
          return true;
        }
        blockedByEventOrWait ||= statementContainsEventOrWait(child);
        delaySeen ||= statementContainsDelayControl(child);
      }
      return false;
    }
    case 'loop':
      if (statement.loopKind === 'forever') {
        return visitProceduralClockStatements(statement.body, clockNames, { ...options, requireForever: false }, state);
      }
      return visitProceduralClockStatements(statement.body, clockNames, options, state);
    case 'if':
      return visitProceduralClockStatements(statement.consequent, clockNames, options, state)
        || Boolean(statement.alternate && visitProceduralClockStatements(statement.alternate, clockNames, options, state));
    case 'case':
      return statement.items.some((item) => visitProceduralClockStatements(item.body, clockNames, options, state));
    case 'assignment':
      return !state.blockedByEventOrWait
        && !statement.hasEventControl
        && !statement.hasWaitControl
        && !options.requireForever
        && (!options.requireDelay || state.delaySeen || statement.hasDelayControl)
        && isClockToggleAssignment(statement, clockNames);
    case 'declaration':
    case 'other':
      return false;
  }
}

function statementContainsEventOrWait(statement: VerilogProceduralStatementAst): boolean {
  switch (statement.kind) {
    case 'assignment':
    case 'other':
      return statement.hasEventControl || statement.hasWaitControl;
    case 'block':
      return statement.statements.some(statementContainsEventOrWait);
    case 'loop':
      return statementContainsEventOrWait(statement.body);
    case 'if':
      return statementContainsEventOrWait(statement.consequent) ||
        Boolean(statement.alternate && statementContainsEventOrWait(statement.alternate));
    case 'case':
      return statement.items.some((item) => statementContainsEventOrWait(item.body));
    case 'declaration':
      return false;
  }
}

function statementContainsDelayControl(statement: VerilogProceduralStatementAst): boolean {
  switch (statement.kind) {
    case 'assignment':
    case 'other':
      return statement.hasDelayControl;
    case 'block':
      return statement.statements.some(statementContainsDelayControl);
    case 'loop':
      return statementContainsDelayControl(statement.body);
    case 'if':
      return statementContainsDelayControl(statement.consequent) ||
        Boolean(statement.alternate && statementContainsDelayControl(statement.alternate));
    case 'case':
      return statement.items.some((item) => statementContainsDelayControl(item.body));
    case 'declaration':
      return false;
  }
}

function isClockToggleAssignment(statement: VerilogAssignmentStatementAst, clockNames: Set<string>): boolean {
  return statement.targets.some((target) =>
    clockNames.has(target) &&
    expressionIsInvertedIdentifier(statement.rhs, target)
  );
}

function expressionContainsIdentifier(expression: VerilogExpressionAst | undefined, identifier: string): boolean {
  if (!expression) {
    return false;
  }
  let found = false;
  walkVerilogExpression(expression, (node) => {
    if (node.kind === 'identifier' && node.name === identifier) {
      found = true;
    }
  });
  return found;
}

function expressionIsInvertedIdentifier(expression: VerilogExpressionAst | undefined, name: string): boolean {
  if (!expression) {
    return false;
  }
  if (expression.kind === 'parenthesizedExpression') {
    return expressionIsInvertedIdentifier(expression.expression, name);
  }
  return expression.kind === 'unaryExpression' &&
    (expression.operator === '~' || expression.operator === '!') &&
    expression.argument.kind === 'identifier' &&
    expression.argument.name === name;
}

function isTestbenchModule(module: VerilogModule, settings: CoSettings): boolean {
  const configured = settings.project.testbench.trim().toLowerCase();
  const name = module.name.toLowerCase();
  return name.includes('tb') || (configured !== '' && name === configured);
}

function isMduModule(module: VerilogModule): boolean {
  return module.name.toLowerCase() === 'mdu';
}

function isTrivialLiteralToken(value: string): boolean {
  const parsed = parseVerilogLiteral(value);
  return parsed !== undefined && (parsed === 0n || parsed === 1n);
}

function parseVerilogLiteral(value: string): bigint | undefined {
  const apostrophe = value.indexOf("'");
  if (apostrophe < 0) {
    return parseDecimalBigInt(value);
  }
  const sizeAndBase = value.slice(apostrophe + 1).split('_').join('');
  const baseChar = [...sizeAndBase].find((char) => {
    const lower = char.toLowerCase();
    return lower === 'b' || lower === 'o' || lower === 'd' || lower === 'h';
  });
  if (!baseChar) {
    return undefined;
  }
  const digits = sizeAndBase.slice(sizeAndBase.indexOf(baseChar) + 1);
  if (!digits || [...digits].some((char) => char === 'x' || char === 'X' || char === 'z' || char === 'Z' || char === '?')) {
    return undefined;
  }
  const radix = baseChar.toLowerCase() === 'b' ? 2 : baseChar.toLowerCase() === 'o' ? 8 : baseChar.toLowerCase() === 'd' ? 10 : 16;
  let result = 0n;
  for (const char of digits) {
    const digit = parseInt(char, radix);
    if (!Number.isInteger(digit) || digit < 0 || digit >= radix) {
      return undefined;
    }
    result = result * BigInt(radix) + BigInt(digit);
  }
  return result;
}

function parseDecimalBigInt(value: string): bigint | undefined {
  if (![...value].every((char) => char === '_' || (char >= '0' && char <= '9'))) {
    return undefined;
  }
  return BigInt(value.split('_').join(''));
}

function identifierStyle(name: string): 'snake' | 'camel' | 'pascal' | undefined {
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name)) {
    return 'snake';
  }
  if (/^[a-z][A-Za-z0-9]*$/.test(name)) {
    return 'camel';
  }
  if (/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    return 'pascal';
  }
  return undefined;
}

function looksLowActiveWithoutSuffix(name: string): boolean {
  const lower = name.toLowerCase();
  return !lower.endsWith('_n') && /(?:^|_)(?:nreset|nrst|rstn|resetn|wen|webar|enbar)(?:_|$)/.test(lower);
}

function isClockOrResetSignal(name: string): boolean {
  return /(?:^|_)(?:clk|clock|rst|reset|clr|clear)(?:_n)?(?:_|$)/i.test(name);
}

function isClockSignalName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('clk') || lower.includes('clock');
}
