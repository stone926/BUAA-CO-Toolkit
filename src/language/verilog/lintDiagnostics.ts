import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings, isVerilogLintRuleEnabled } from '../common/settings';
import {
  collectAssignmentUsesFromModuleAst,
  collectAssignmentUsesFromProceduralStatementAst
} from './assignmentAst';
import { systemTasks, VerilogModule, verilogKeywords } from './model';
import { VerilogCstDocument } from './cst';
import { VerilogToken } from './lexer';
import {
  safeRegExp,
} from './textUtils';
import type { VerilogSemanticModel } from './semanticModel';
import type { VerilogExpressionAst } from './exprAst';
import { walkVerilogExpression } from './exprAstUtils';
import {
  assignmentRhsContainsIdentifier,
  edgeSignalsFromSensitivity,
  hasTokenValue,
  isOffsetInsideForControl,
  VerilogProceduralBlockAst
} from './blockAst';
import { collectContinuousProceduralDriverDiagnostics } from './driverDiagnostics';
import { collectCombinationalDataflowDiagnostics } from './dataflowDiagnostics';
import type { VerilogAstDocument, VerilogModuleAst } from './ast';
import type { VerilogProceduralStatementAst } from './proceduralAst';

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
  modules: VerilogModule[],
  cst: VerilogCstDocument,
  ast: VerilogAstDocument,
  diagnostics: Diagnostic[]
): void {
  for (const moduleAst of ast.modules) {
    const module = moduleAst.module;
    collectNamingDiagnostics(settings, module, diagnostics);
    collectAlwaysStyleDiagnostics(document, settings, moduleAst, diagnostics);
    collectInstantiationStyleDiagnostics(settings, module, diagnostics);
    collectExplicitWidthDiagnostics(settings, module, diagnostics);
    collectMagicNumberDiagnostics(document, settings, text, module, cst, diagnostics);
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
        diagnostics.push(makeDiagnostic(decl.selectionRange, 'Synthesizable style: avoid declaration initializers for registers; reset them in clocked logic.', DiagnosticSeverity.Information, 'synth-decl-init'));
      }
    }
  }
}

const registerInitializerKinds = new Set(['reg', 'logic', 'integer']);
const expensiveSynthesizableOperators = new Set(['*', '/', '%']);

function collectInitialBlockHintDiagnostics(moduleAst: VerilogModuleAst, diagnostics: Diagnostic[]): void {
  for (const block of moduleAst.proceduralBlocks) {
    if (block.kind === 'initial') {
      diagnostics.push(makeDiagnostic(block.headerRange, 'Synthesizable style: avoid initial blocks in design modules; use reset logic instead.', DiagnosticSeverity.Information, 'synth-initial'));
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
      diagnostics.push(makeDiagnostic(range, 'Synthesizable style: avoid multiply/divide/modulo operators on FPGA datapaths unless the hardware cost is intentional.', DiagnosticSeverity.Information, 'synth-mul-div'));
    });
  };

  for (const statement of moduleAst.items) {
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
    collectSynthesizableOperatorDiagnosticsFromProceduralStatement(block.statementTree, visitExpression);
  }
}

function collectSynthesizableOperatorDiagnosticsFromProceduralStatement(
  statement: VerilogProceduralStatementAst,
  visitExpression: (expression: VerilogExpressionAst | undefined) => void
): void {
  switch (statement.kind) {
    case 'block':
      for (const child of statement.statements) {
        collectSynthesizableOperatorDiagnosticsFromProceduralStatement(child, visitExpression);
      }
      return;
    case 'assignment':
      visitExpression(statement.lhs);
      visitExpression(statement.rhs);
      return;
    case 'if':
      visitExpression(statement.condition);
      collectSynthesizableOperatorDiagnosticsFromProceduralStatement(statement.consequent, visitExpression);
      if (statement.alternate) {
        collectSynthesizableOperatorDiagnosticsFromProceduralStatement(statement.alternate, visitExpression);
      }
      return;
    case 'case':
      visitExpression(statement.expression);
      for (const item of statement.items) {
        for (const label of item.labels) {
          visitExpression(label);
        }
        collectSynthesizableOperatorDiagnosticsFromProceduralStatement(item.body, visitExpression);
      }
      return;
    case 'loop':
      visitExpression(statement.condition);
      collectSynthesizableOperatorDiagnosticsFromProceduralStatement(statement.body, visitExpression);
      return;
    case 'other':
      visitExpression(statement.expression);
      return;
    case 'declaration':
      return;
  }
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

const portDirections = new Set(['input', 'output', 'inout']);
const explicitPortNetTypes = new Set([
  'wire',
  'tri',
  'tri0',
  'tri1',
  'triand',
  'trior',
  'trireg',
  'wand',
  'wor',
  'supply0',
  'supply1',
  'reg',
  'logic',
  'integer',
  'time',
  'real',
  'realtime'
]);
const portDeclarationModifiers = new Set(['automatic', 'signed', 'unsigned', 'scalared', 'vectored']);

export function collectExplicitPortNetTypeDiagnostics(
  document: TextDocument,
  modules: VerilogModule[],
  cst: VerilogCstDocument,
  diagnostics: Diagnostic[]
): void {
  if (!hasDefaultNettypeNone(document, cst)) {
    return;
  }

  for (const module of modules) {
    const moduleStart = document.offsetAt(module.range.start);
    const headerEnd = document.offsetAt(module.headerEnd);
    const moduleEnd = document.offsetAt(module.endmoduleRange?.start ?? module.range.end);
    const headerTokens = cst.codeTokens.filter((token) => token.start >= moduleStart && token.end <= headerEnd);
    collectImplicitPortNetTypeDiagnosticsFromTokens(document, headerTokens, diagnostics);

    for (const statement of cst.statements) {
      if (statement.start < headerEnd || statement.start >= moduleEnd) {
        continue;
      }
      const tokens = trimStatementTokens(statement.tokens);
      if (!tokens.length || !portDirections.has(tokens[0].value)) {
        continue;
      }
      if (!hasExplicitPortNetType(tokens, 0)) {
        diagnostics.push(makeExplicitPortNetDiagnostic(document, tokens[0]));
      }
    }
  }
}

function collectImplicitPortNetTypeDiagnosticsFromTokens(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!portDirections.has(token.value)) {
      continue;
    }
    if (!hasExplicitPortNetType(tokens, index)) {
      diagnostics.push(makeExplicitPortNetDiagnostic(document, token));
    }
  }
}

function hasExplicitPortNetType(tokens: VerilogToken[], directionIndex: number): boolean {
  let index = directionIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.value === ',' || token.value === ';' || token.value === ')') {
      return false;
    }
    if (explicitPortNetTypes.has(token.value)) {
      return true;
    }
    if (portDeclarationModifiers.has(token.value)) {
      index++;
      continue;
    }
    if (token.value === '[') {
      const close = findMatchingToken(tokens, index, '[', ']');
      if (close < 0) {
        return false;
      }
      index = close + 1;
      continue;
    }
    if (token.kind === 'identifier') {
      return false;
    }
    index++;
  }
  return false;
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

function makeExplicitPortNetDiagnostic(document: TextDocument, token: VerilogToken): Diagnostic {
  return makeDiagnostic(
    tokenRange(document, token),
    'Port declaration relies on an implicit wire net type while `default_nettype none is active.',
    DiagnosticSeverity.Error,
    'explicit-port-wire'
  );
}

function hasDefaultNettypeNone(document: TextDocument, cst: VerilogCstDocument): boolean {
  for (let index = 0; index < cst.codeTokens.length; index++) {
    const token = cst.codeTokens[index];
    if (token.kind !== 'directive' || token.value !== '`default_nettype') {
      continue;
    }
    const next = cst.codeTokens[index + 1];
    if (next && document.positionAt(next.start).line === document.positionAt(token.start).line && next.value === 'none') {
      return true;
    }
  }
  return false;
}

function collectAlwaysStyleDiagnostics(document: TextDocument, settings: CoSettings, moduleAst: VerilogModuleAst, diagnostics: Diagnostic[]): void {
  const module = moduleAst.module;
  const blocks = moduleAst.alwaysBlocks;
  const assignedBlocks = new Map<string, Set<number>>();
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const blockAssignments = collectAssignmentUsesFromProceduralStatementAst(document, block.statementTree, index);
    if (block.combinational) {
      if (isVerilogLintRuleEnabled(settings, 'vc-006') && !hasTokenValue(block.sensitivityTokens, '*')) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-006: combinational logic should use always @(*) or assign.', DiagnosticSeverity.Warning, 'vc-006-comb-sensitivity'));
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-007') && hasTokenValue(block.bodyTokens, '<=')) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-007: combinational always blocks should use blocking assignments (=), not nonblocking assignments (<=).', DiagnosticSeverity.Warning, 'vc-007-comb-nonblocking'));
      }
      collectCombinationalDataflowDiagnostics(document, settings, module, block, diagnostics);
    }

    if (block.sequential) {
      const edgeSignals = edgeSignalsFromSensitivity(block.sensitivityTokens);
      if (isVerilogLintRuleEnabled(settings, 'vc-009') && !hasPosedgeSignal(block.sensitivityTokens)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-009: sequential logic should be implemented in always @(posedge clock) blocks.', DiagnosticSeverity.Warning, 'vc-009-seq-posedge'));
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-011') && hasTokenValue(block.sensitivityTokens, 'negedge')) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-011: avoid negedge-triggered logic unless a protocol explicitly requires it.', DiagnosticSeverity.Warning, 'vc-011-negedge'));
      }
      for (const signal of edgeSignals) {
        if (isVerilogLintRuleEnabled(settings, 'vc-012') && !isClockOrResetSignal(signal)) {
          diagnostics.push(makeDiagnostic(block.headerRange, `VC-012: edge trigger on '${signal}' is not a clock/reset signal.`, DiagnosticSeverity.Warning, 'vc-012-edge-signal'));
        }
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-014') && edgeSignals.length > 1) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-014: prefer synchronous reset; async reset appears in the sensitivity list.', DiagnosticSeverity.Information, 'vc-014-sync-reset'));
      }
      for (const assignment of blockAssignments) {
        if (isVerilogLintRuleEnabled(settings, 'vc-010') && assignment.operator === '=' && !isOffsetInsideForControl(block.bodyTokens, document.offsetAt(assignment.range.start))) {
          diagnostics.push(makeDiagnostic(assignment.range, 'VC-010: sequential always blocks should use nonblocking assignments (<=).', DiagnosticSeverity.Warning, 'vc-010-seq-blocking'));
        }
      }
      const clockSignals = edgeSignals.filter(isClockSignalName);
      for (const clock of clockSignals) {
        if (isVerilogLintRuleEnabled(settings, 'vc-013') && assignmentRhsContainsIdentifier(block.bodyTokens, clock)) {
          diagnostics.push(makeDiagnostic(block.headerRange, `VC-013: clock signal '${clock}' should not be used as data inside sequential logic.`, DiagnosticSeverity.Information, 'vc-013-clock-data'));
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
      diagnostics.push(makeDiagnostic(decl?.selectionRange ?? module.selectionRange, `VC-005: signal '${name}' is assigned in multiple always blocks.`, DiagnosticSeverity.Warning, 'vc-005-multiple-always'));
    }
  }
}

function collectNamingDiagnostics(settings: CoSettings, module: VerilogModule, diagnostics: Diagnostic[]): void {
  const styleCounts = new Map<string, number>();
  for (const decl of module.declarations.values()) {
    const style = identifierStyle(decl.name);
    if (!style) {
      if (isVerilogLintRuleEnabled(settings, 'vc-001')) {
        diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-001: signal '${decl.name}' should use snake_case, camelCase, or PascalCase.`, DiagnosticSeverity.Information, 'vc-001-name-style'));
      }
    } else {
      styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
    }
    if (isVerilogLintRuleEnabled(settings, 'vc-002') && looksLowActiveWithoutSuffix(decl.name)) {
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-002: low-active signal '${decl.name}' should use the _n suffix.`, DiagnosticSeverity.Information, 'vc-002-low-active-suffix'));
    }
    if (isVerilogLintRuleEnabled(settings, 'vc-003') && /mux/i.test(decl.name) && !/\d/.test(decl.name)) {
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-003: multiplexer signal '${decl.name}' should reflect its width or input count.`, DiagnosticSeverity.Information, 'vc-003-mux-name'));
    }
  }
  if (isVerilogLintRuleEnabled(settings, 'vc-001') && styleCounts.size > 1) {
    diagnostics.push(makeDiagnostic(module.selectionRange, 'VC-001: this module mixes signal naming styles; keep one of snake_case, camelCase, or PascalCase consistently.', DiagnosticSeverity.Information, 'vc-001-mixed-name-style'));
  }
}

function collectInstantiationStyleDiagnostics(settings: CoSettings, module: VerilogModule, diagnostics: Diagnostic[]): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-017')) {
    return;
  }
  for (const instance of module.instances) {
    if (instance.portConnections.some((connection) => !connection.name)) {
      diagnostics.push(makeDiagnostic(instance.selectionRange, `Testbench/VC-017: instance '${instance.instanceName}' should use named port mapping.`, DiagnosticSeverity.Information, 'vc-017-named-ports'));
    }
    if (instance.portConnections.length > 1 && instance.range.start.line === instance.range.end.line) {
      diagnostics.push(makeDiagnostic(instance.selectionRange, `VC-017: instance '${instance.instanceName}' should use multi-line formatting with one port connection per line.`, DiagnosticSeverity.Information, 'vc-017-multiline-instance'));
    }
    const lines = new Set(instance.portConnections.map((connection) => connection.range.start.line));
    if (lines.size < instance.portConnections.length) {
      diagnostics.push(makeDiagnostic(instance.selectionRange, `VC-017: instance '${instance.instanceName}' should place each port connection on a separate line.`, DiagnosticSeverity.Information, 'vc-017-one-port-per-line'));
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
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-021: signal '${decl.name}' should declare an explicit width, even if it is 1 bit.`, DiagnosticSeverity.Information, 'vc-021-explicit-width'));
    }
  }
}

function collectMagicNumberDiagnostics(document: TextDocument, settings: CoSettings, text: string, module: VerilogModule, cst: VerilogCstDocument, diagnostics: Diagnostic[]): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-004')) {
    return;
  }
  const bodyStart = document.offsetAt(module.headerEnd);
  const bodyEnd = document.offsetAt(module.range.end);
  for (const token of cst.codeTokens) {
    if (token.kind !== 'number' || token.start < bodyStart || token.start >= bodyEnd) {
      continue;
    }
    const statement = cst.statements.find((item) => token.start >= item.start && token.start < item.end);
    const statementTokens = statement ? trimStatementTokens(statement.tokens) : [];
    if (
      statementTokens.some((item) => item.value === 'parameter' || item.value === 'localparam' || item.value === '`define') ||
      isTrivialLiteralToken(token.value) ||
      isInsideBracketRangeTokens(statementTokens, token)
    ) {
      continue;
    }
    diagnostics.push(makeDiagnostic(tokenRange(document, token), 'VC-004: replace magic numbers with a descriptive localparam, parameter, or macro.', DiagnosticSeverity.Information, 'vc-004-magic-number'));
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
      diagnostics.push(makeDiagnostic(port.selectionRange, `VC-015: internal module '${module.name}' should not use inout port '${port.name}'.`, DiagnosticSeverity.Warning, 'vc-015-inout'));
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
      if (block.controlKind === 'delay' && findClockToggleAssignment(block.bodyTokens, clockNames) >= 0) {
        return true;
      }
      if (block.controlKind === 'none' && hasDelayBeforeClockToggle(block.bodyTokens, clockNames)) {
        return true;
      }
      continue;
    }
    if (block.kind === 'initial' && hasForeverDelayClockToggle(block.bodyTokens, clockNames)) {
      return true;
    }
  }
  return false;
}

function declaredClockNames(module: VerilogModule): Set<string> {
  return new Set([...module.declarations.keys()].filter(isClockSignalName));
}

function hasForeverDelayClockToggle(tokens: VerilogToken[], clockNames: Set<string>): boolean {
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== 'forever') {
      continue;
    }
    const end = proceduralStatementWindowEnd(tokens, index + 1);
    if (end <= index) {
      continue;
    }
    if (hasDelayBeforeClockToggle(tokens.slice(index, end + 1), clockNames)) {
      return true;
    }
  }
  return false;
}

function hasDelayBeforeClockToggle(tokens: VerilogToken[], clockNames: Set<string>): boolean {
  const assignmentIndex = findClockToggleAssignment(tokens, clockNames);
  if (assignmentIndex < 0) {
    return false;
  }
  const prefix = tokens.slice(0, assignmentIndex);
  return prefix.some((token) => token.value === '#') && !prefix.some((token) => token.value === '@' || token.value === 'wait');
}

function findClockToggleAssignment(tokens: VerilogToken[], clockNames: Set<string>): number {
  for (let index = 0; index <= tokens.length - 4; index++) {
    const target = tokens[index];
    if (target.kind !== 'identifier' || !clockNames.has(target.value)) {
      continue;
    }
    const operator = tokens[index + 1];
    const inverter = tokens[index + 2];
    const source = tokens[index + 3];
    if (
      (operator.value === '=' || operator.value === '<=') &&
      (inverter.value === '~' || inverter.value === '!') &&
      source.kind === 'identifier' &&
      source.value === target.value
    ) {
      return index;
    }
  }
  return -1;
}

function proceduralStatementWindowEnd(tokens: VerilogToken[], start: number): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].value === 'begin') {
      const end = findMatchingBeginEndToken(tokens, index);
      return end >= 0 ? end : index;
    }
    if (tokens[index].value === ';') {
      return index;
    }
  }
  return tokens.length - 1;
}

function findMatchingBeginEndToken(tokens: VerilogToken[], beginIndex: number): number {
  let depth = 0;
  for (let index = beginIndex; index < tokens.length; index++) {
    if (tokens[index].value === 'begin') {
      depth++;
    } else if (tokens[index].value === 'end') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function tokenRange(document: TextDocument, token: VerilogToken): Range {
  return Range.create(document.positionAt(token.start), document.positionAt(token.end));
}

function trimStatementTokens(tokens: VerilogToken[]): VerilogToken[] {
  const result = tokens.filter((token) => token.kind !== 'eof');
  return result[result.length - 1]?.value === ';' ? result.slice(0, -1) : result;
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

function isInsideBracketRangeTokens(tokens: VerilogToken[], target: VerilogToken): boolean {
  const index = tokens.indexOf(target);
  if (index < 0) {
    return false;
  }
  let left = index - 1;
  while (left >= 0 && tokens[left].value !== '[' && tokens[left].value !== ';') {
    if (tokens[left].value === ']') {
      return false;
    }
    left--;
  }
  if (tokens[left]?.value !== '[') {
    return false;
  }
  let right = index + 1;
  while (right < tokens.length && tokens[right].value !== ']' && tokens[right].value !== ';') {
    right++;
  }
  return tokens[right]?.value === ']';
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

function hasPosedgeSignal(tokens: VerilogToken[]): boolean {
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== 'posedge') {
      continue;
    }
    if (tokens.slice(index + 1).some((token) => token.kind === 'identifier')) {
      return true;
    }
  }
  return false;
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
