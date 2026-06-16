import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings, isVerilogLintRuleEnabled } from '../common/settings';
import { collectAssignmentsFromTokens } from './assignmentAnalysis';
import { systemTasks, VerilogModule, verilogKeywords } from './model';
import { VerilogCstDocument, VerilogCstStatement } from './cst';
import { VerilogToken } from './lexer';
import {
  safeRegExp,
} from './textUtils';
import type { VerilogSemanticModel } from './semanticModel';
import {
  assignmentRhsContainsIdentifier,
  collectAlwaysBlocksFromCst,
  collectProceduralBlocksFromCst,
  edgeSignalsFromSensitivity,
  hasAnyTokenValue,
  hasTokenValue,
  isOffsetInsideForControl,
  VerilogProceduralBlockAst
} from './blockAst';
import { collectNamingDiagnostics } from './lintNamingRules';
import { collectInstantiationStyleDiagnostics } from './lintInstantiationRules';

export function collectAssignmentDiagnostics(document: TextDocument, settings: CoSettings, text: string, modules: VerilogModule[], cst: VerilogCstDocument, diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    const bodyStart = document.offsetAt(module.headerEnd);
    const bodyEnd = document.offsetAt(module.range.end);
    const assignmentKinds = new Map<string, Set<string>>();
    const isTestbench = isTestbenchModule(module, settings);
    for (const assignment of collectAssignmentsFromTokens(document, cstWithStatements(cst, bodyStart, bodyEnd), 0, -1)) {
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
}

export function collectCourseStyleDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  text: string,
  modules: VerilogModule[],
  cst: VerilogCstDocument,
  diagnostics: Diagnostic[]
): void {
  for (const module of modules) {
    collectNamingDiagnostics(settings, module, diagnostics);
    collectAlwaysStyleDiagnostics(document, settings, cst, module, diagnostics);
    collectInstantiationStyleDiagnostics(settings, module, diagnostics);
    collectExplicitWidthDiagnostics(settings, module, diagnostics);
    collectMagicNumberDiagnostics(document, settings, text, module, cst, diagnostics);
    collectInoutDiagnostics(settings, module, diagnostics);
  }
  collectTestbenchDiagnostics(document, settings, text, modules, cst, diagnostics);
}

export function collectSynthesizableHintDiagnostics(document: TextDocument, settings: CoSettings, text: string, modules: VerilogModule[], cst: VerilogCstDocument, diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    const moduleStart = document.offsetAt(module.range.start);
    const moduleEnd = document.offsetAt(module.range.end);
    const isTestbench = isTestbenchModule(module, settings);
    const isMdu = isMduModule(module);
    for (const token of cst.codeTokens) {
      if (token.start < moduleStart || token.start >= moduleEnd) {
        continue;
      }
      if (token.value === 'initial' && !isTestbench) {
        diagnostics.push(makeDiagnostic(tokenRange(document, token), 'Synthesizable style: avoid initial blocks in design modules; use reset logic instead.', DiagnosticSeverity.Information, 'synth-initial'));
      }
      if (
        !isMdu &&
        (token.value === '*' || token.value === '/' || token.value === '%') &&
        shouldReportSynthesizableOperatorToken(document, cst.codeTokens, token)
      ) {
        diagnostics.push(makeDiagnostic(tokenRange(document, token), 'Synthesizable style: avoid multiply/divide/modulo operators on FPGA datapaths unless the hardware cost is intentional.', DiagnosticSeverity.Information, 'synth-mul-div'));
      }
    }
  }
  for (const statement of cst.statements) {
    const tokens = trimStatementTokens(statement.tokens);
    if (!tokens.length || !['reg', 'logic', 'integer'].includes(tokens[0].value)) {
      continue;
    }
    if (findTopLevelToken(tokens, '=') >= 0) {
      diagnostics.push(makeDiagnostic(tokenRange(document, tokens[0]), 'Synthesizable style: avoid declaration initializers for registers; reset them in clocked logic.', DiagnosticSeverity.Information, 'synth-decl-init'));
    }
  }
}

export function collectImplicitNetDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  text: string,
  modules: VerilogModule[],
  cst: VerilogCstDocument,
  diagnostics: Diagnostic[],
  semantic?: VerilogSemanticModel
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
  if (semantic) {
    const reported = new Set<string>();
    for (const reference of semantic.unresolvedReferences) {
      if (ignorePatterns.some((pattern) => pattern.test(reference.name))) {
        continue;
      }
      const key = `${reference.name}:${reference.range.start.line}:${reference.range.start.character}`;
      if (reported.has(key)) {
        continue;
      }
      reported.add(key);
      diagnostics.push(makeDiagnostic(reference.range, `Implicit net or undeclared identifier '${reference.name}'.`, severity, `implicit-net:${reference.name}`));
    }
    return;
  }

  for (const module of modules) {
    const declared = new Set<string>([module.name]);
    for (const decl of module.declarations.values()) {
      declared.add(decl.name);
    }
    for (const instance of module.instances) {
      declared.add(instance.instanceName);
      declared.add(instance.moduleName);
    }
    const bodyStart = document.offsetAt(module.headerEnd);
    const bodyEnd = document.offsetAt(module.range.end);
    const reported = new Set<string>();
    const bodyTokens = cst.codeTokens.filter((token) => token.start >= bodyStart && token.start < bodyEnd);
    for (let index = 0; index < bodyTokens.length; index++) {
      const token = bodyTokens[index];
      if (token.kind !== 'identifier') {
        continue;
      }
      const name = token.value;
      const previous = previousToken(bodyTokens, index);
      if (
        declared.has(name) ||
        reported.has(name) ||
        verilogKeywords.has(name) ||
        systemTasks.has(name) ||
        previous?.value === '.' ||
        previous?.kind === 'directive' ||
        previous?.kind === 'systemIdentifier'
      ) {
        continue;
      }
      if (ignorePatterns.some((pattern) => pattern.test(name))) {
        continue;
      }
      reported.add(name);
      diagnostics.push(makeDiagnostic(tokenRange(document, token), `Implicit net or undeclared identifier '${name}'.`, severity, `implicit-net:${name}`));
    }
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

function collectAlwaysStyleDiagnostics(document: TextDocument, settings: CoSettings, cst: VerilogCstDocument, module: VerilogModule, diagnostics: Diagnostic[]): void {
  const blocks = collectAlwaysBlocksFromCst(document, cst, module);
  const assignedBlocks = new Map<string, Set<number>>();
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const blockCst = cstFromTokenRange(cst, block.bodyStart, block.bodyEnd);
    if (block.combinational) {
      if (isVerilogLintRuleEnabled(settings, 'vc-006') && !hasTokenValue(block.sensitivityTokens, '*')) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-006: combinational logic should use always @(*) or assign.', DiagnosticSeverity.Warning, 'vc-006-comb-sensitivity'));
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-007') && hasTokenValue(block.bodyTokens, '<=')) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-007: combinational always blocks should use blocking assignments (=), not nonblocking assignments (<=).', DiagnosticSeverity.Warning, 'vc-007-comb-nonblocking'));
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-008') && hasTokenValue(block.bodyTokens, 'if') && !hasTokenValue(block.bodyTokens, 'else')) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-008: combinational if statements should cover every branch to avoid inferred latches.', DiagnosticSeverity.Information, 'vc-008-comb-branch'));
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-008') && hasAnyTokenValue(block.bodyTokens, new Set(['case', 'casex', 'casez'])) && !hasTokenValue(block.bodyTokens, 'default')) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-008: combinational case statements should include default assignments to avoid inferred latches.', DiagnosticSeverity.Information, 'vc-008-case-default'));
      }
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
      const assignments = collectAssignmentsFromTokens(document, blockCst, 0, index);
      for (const assignment of assignments) {
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

    for (const assignment of collectAssignmentsFromTokens(document, blockCst, 0, index)) {
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

function collectTestbenchDiagnostics(document: TextDocument, settings: CoSettings, text: string, modules: VerilogModule[], cst: VerilogCstDocument, diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    if (!isTestbenchModule(module, settings)) {
      continue;
    }
    const bodyStart = document.offsetAt(module.headerEnd);
    const bodyEnd = document.offsetAt(module.range.end);
    const body = text.slice(bodyStart, bodyEnd);
    const proceduralBlocks = collectProceduralBlocksFromCst(document, cst, module);
    if (!/`timescale\s+1ns\s*\/\s*1ps/.test(text)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: standard course testbenches should use `timescale 1ns / 1ps.', DiagnosticSeverity.Information, 'tb-timescale'));
    }
    if (!hasTestbenchClockGeneration(module, proceduralBlocks)) {
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

function previousToken(tokens: VerilogToken[], index: number): VerilogToken | undefined {
  for (let current = index - 1; current >= 0; current--) {
    if (tokens[current].kind !== 'eof') {
      return tokens[current];
    }
  }
  return undefined;
}

function isTestbenchModule(module: VerilogModule, settings: CoSettings): boolean {
  const configured = settings.project.testbench.trim().toLowerCase();
  const name = module.name.toLowerCase();
  return name.includes('tb') || (configured !== '' && name === configured);
}

function isMduModule(module: VerilogModule): boolean {
  return module.name.toLowerCase() === 'mdu';
}

function shouldReportSynthesizableOperatorToken(document: TextDocument, tokens: VerilogToken[], token: VerilogToken): boolean {
  if (hasDirectiveBeforeOnLine(document, tokens, token)) {
    return false;
  }
  if (token.value !== '*') {
    return true;
  }
  const index = tokens.indexOf(token);
  const previous = previousToken(tokens, index);
  const next = nextToken(tokens, index);
  if (previous?.value === '@') {
    return false;
  }
  if (previous?.value === '(' || next?.value === ')') {
    return false;
  }
  if (previous?.value !== '(' || next?.value !== ')') {
    return true;
  }
  const beforeOpen = previousToken(tokens, tokens.indexOf(previous));
  return beforeOpen?.value !== '@';
}

function hasDirectiveBeforeOnLine(document: TextDocument, tokens: VerilogToken[], token: VerilogToken): boolean {
  const line = document.positionAt(token.start).line;
  const tokenIndex = tokens.indexOf(token);
  for (let index = tokenIndex - 1; index >= 0; index--) {
    const current = tokens[index];
    const currentLine = document.positionAt(current.start).line;
    if (currentLine !== line) {
      return false;
    }
    if (current.kind === 'directive') {
      return true;
    }
  }
  return false;
}

function nextToken(tokens: VerilogToken[], index: number): VerilogToken | undefined {
  for (let current = index + 1; current < tokens.length; current++) {
    if (tokens[current].kind !== 'eof') {
      return tokens[current];
    }
  }
  return undefined;
}

function findTopLevelToken(tokens: VerilogToken[], value: string): number {
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
    } else if (token.value === value && paren === 0 && bracket === 0 && brace === 0) {
      return index;
    }
  }
  return -1;
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

function cstWithStatements(cst: VerilogCstDocument, start: number, end: number): VerilogCstDocument {
  return cstFromStatements(cst, cst.statements.filter((statement) => statement.end > start && statement.start < end));
}

function cstFromStatements(cst: VerilogCstDocument, statements: VerilogCstStatement[]): VerilogCstDocument {
  return {
    ...cst,
    statements
  };
}

function cstFromTokenRange(cst: VerilogCstDocument, start: number, end: number): VerilogCstDocument {
  return cstFromStatements(
    cst,
    cst.statements
      .map((statement) => {
        const tokens = statement.tokens.filter((token) => token.start >= start && token.end <= end);
        if (!tokens.length) {
          return undefined;
        }
        return {
          ...statement,
          tokens,
          start: tokens[0].start,
          end: tokens[tokens.length - 1].end
        };
      })
      .filter((statement): statement is VerilogCstStatement => Boolean(statement))
  );
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

function isClockOrResetSignal(name: string): boolean {
  return /(?:^|_)(?:clk|clock|rst|reset|clr|clear)(?:_n)?(?:_|$)/i.test(name);
}

function isClockSignalName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('clk') || lower.includes('clock');
}

function isTrivialLiteral(value: string): boolean {
  const normalized = value.replace(/\s+/g, '').toLowerCase();
  return normalized === '0' || normalized === '1' || /^\d+'[bodh]0+$/.test(normalized) || /^\d+'[bodh]1$/.test(normalized);
}

function isInsideBracketRange(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEndRaw = text.indexOf('\n', index);
  const lineEnd = lineEndRaw >= 0 ? lineEndRaw : text.length;
  const before = text.slice(lineStart, index);
  const after = text.slice(index, lineEnd);
  return before.lastIndexOf('[') > before.lastIndexOf(']') && after.includes(']');
}

function stripPreprocessorDirectives(text: string): string {
  return text.replace(/^[ \t]*`(?:timescale|default_nettype|include|define|undef|ifdef|ifndef|elsif|else|endif)\b.*$/gm, (match) => ' '.repeat(match.length));
}

function stripVerilogAttributes(text: string): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '(' || text[index + 1] !== '*' || previousNonWhitespace(text, index - 1)?.char === '@') {
      result += text[index] ?? '';
      index++;
      continue;
    }
    const end = text.indexOf('*)', index + 2);
    if (end < 0) {
      result += text.slice(index);
      break;
    }
    result += ' '.repeat(end + 2 - index);
    index = end + 2;
  }
  return result;
}

function shouldReportSynthesizableOperator(text: string, index: number): boolean {
  if (text[index] !== '*') {
    return true;
  }
  const previous = previousNonWhitespace(text, index - 1);
  const next = nextNonWhitespace(text, index + 1);
  if (previous?.char === '@') {
    return false;
  }
  if (previous?.char !== '(' || next?.char !== ')') {
    return true;
  }
  const beforeOpen = previousNonWhitespace(text, previous.index - 1);
  return beforeOpen?.char !== '@';
}

function previousNonWhitespace(text: string, start: number): { char: string; index: number } | undefined {
  for (let index = start; index >= 0; index--) {
    if (!/\s/.test(text[index])) {
      return { char: text[index], index };
    }
  }
  return undefined;
}

function nextNonWhitespace(text: string, start: number): { char: string; index: number } | undefined {
  for (let index = start; index < text.length; index++) {
    if (!/\s/.test(text[index])) {
      return { char: text[index], index };
    }
  }
  return undefined;
}
