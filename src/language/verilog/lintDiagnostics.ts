import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic, rangeAtOffset, lineAt } from '../common/lsp';
import { CoSettings, isVerilogLintRuleEnabled } from '../common/settings';
import { escapeRegExp } from '../common/util';
import { collectAssignmentsInText } from './assignmentAnalysis';
import { systemTasks, VerilogModule, verilogKeywords } from './model';
import {
  findMatchingParen,
  isInsideForControl,
  safeRegExp,
  skipWhitespace,
  stripCommentsAndStrings
} from './textUtils';

interface AlwaysBlockInfo {
  sensitivity: string;
  range: Range;
  headerRange: Range;
  bodyText: string;
  bodyOffset: number;
  sequential: boolean;
  combinational: boolean;
}

export function collectAssignmentDiagnostics(document: TextDocument, text: string, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    const bodyStart = document.offsetAt(module.headerEnd);
    const body = text.slice(bodyStart, document.offsetAt(module.range.end));
    const assignmentKinds = new Map<string, Set<string>>();
    for (const assignment of collectAssignmentsInText(document, body, bodyStart, -1)) {
      if (!assignmentKinds.has(assignment.name)) {
        assignmentKinds.set(assignment.name, new Set());
      }
      assignmentKinds.get(assignment.name)?.add(assignment.operator);
    }
    for (const [name, operators] of assignmentKinds) {
      if (operators.has('=') && operators.has('<=')) {
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
  diagnostics: Diagnostic[]
): void {
  for (const module of modules) {
    collectNamingDiagnostics(settings, module, diagnostics);
    collectAlwaysStyleDiagnostics(document, settings, text, module, diagnostics);
    collectInstantiationStyleDiagnostics(settings, module, diagnostics);
    collectExplicitWidthDiagnostics(settings, module, diagnostics);
    collectMagicNumberDiagnostics(document, settings, text, module, diagnostics);
    collectInoutDiagnostics(settings, module, diagnostics);
  }
  collectTestbenchDiagnostics(document, settings, text, modules, diagnostics);
}

export function collectSynthesizableHintDiagnostics(document: TextDocument, text: string, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  const stripped = stripCommentsAndStrings(text);
  const initialRegex = /\binitial\b/g;
  let initialMatch: RegExpExecArray | null;
  while ((initialMatch = initialRegex.exec(stripped))) {
    diagnostics.push(makeDiagnostic(rangeAtOffset(document, initialMatch.index, 'initial'.length), 'Synthesizable style: avoid initial blocks in design modules; use reset logic instead.', DiagnosticSeverity.Information, 'synth-initial'));
  }

  const declInitializerRegex = /\b(reg|logic|integer)\b\s*(?:signed\s*)?(?:\[[^\]]+\]\s*)?[A-Za-z_]\w*\s*=/g;
  let initializerMatch: RegExpExecArray | null;
  while ((initializerMatch = declInitializerRegex.exec(stripped))) {
    diagnostics.push(makeDiagnostic(rangeAtOffset(document, initializerMatch.index, initializerMatch[0].length), 'Synthesizable style: avoid declaration initializers for registers; reset them in clocked logic.', DiagnosticSeverity.Information, 'synth-decl-init'));
  }

  const mulDivRegex = /(?<![*/])(?:\*|\/|%)(?![*/])/g;
  let operatorMatch: RegExpExecArray | null;
  while ((operatorMatch = mulDivRegex.exec(stripped))) {
    diagnostics.push(makeDiagnostic(rangeAtOffset(document, operatorMatch.index, operatorMatch[0].length), 'Synthesizable style: avoid multiply/divide/modulo operators on FPGA datapaths unless the hardware cost is intentional.', DiagnosticSeverity.Information, 'synth-mul-div'));
  }
}

export function collectImplicitNetDiagnostics(document: TextDocument, settings: CoSettings, text: string, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
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
    const stripped = stripCommentsAndStrings(text.slice(bodyStart, bodyEnd));
    const tokenRegex = /\b[A-Za-z_]\w*\b/g;
    const reported = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(stripped))) {
      const token = match[0];
      const absolute = bodyStart + match.index;
      const previous = text[absolute - 1] ?? '';
      if (
        declared.has(token) ||
        reported.has(token) ||
        verilogKeywords.has(token) ||
        systemTasks.has(token) ||
        previous === '.' ||
        previous === '`' ||
        previous === '$' ||
        previous === "'"
      ) {
        continue;
      }
      if (ignorePatterns.some((pattern) => pattern.test(token))) {
        continue;
      }
      reported.add(token);
      diagnostics.push(makeDiagnostic(rangeAtOffset(document, absolute, token.length), `Implicit net or undeclared identifier '${token}'.`, severity, `implicit-net:${token}`));
    }
  }
}

function collectAlwaysStyleDiagnostics(document: TextDocument, settings: CoSettings, text: string, module: VerilogModule, diagnostics: Diagnostic[]): void {
  const blocks = collectAlwaysBlocks(document, text, module);
  const assignedBlocks = new Map<string, Set<number>>();
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.combinational) {
      if (isVerilogLintRuleEnabled(settings, 'vc-006') && !/\*/.test(block.sensitivity)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-006: combinational logic should use always @(*) or assign.', DiagnosticSeverity.Warning, 'vc-006-comb-sensitivity'));
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-007') && /<=(?!=)/.test(block.bodyText)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-007: combinational always blocks should use blocking assignments (=), not nonblocking assignments (<=).', DiagnosticSeverity.Warning, 'vc-007-comb-nonblocking'));
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-008') && /\bif\b/.test(block.bodyText) && !/\belse\b/.test(block.bodyText)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-008: combinational if statements should cover every branch to avoid inferred latches.', DiagnosticSeverity.Information, 'vc-008-comb-branch'));
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-008') && /\bcase[xyz]?\b/.test(block.bodyText) && !/\bdefault\b/.test(block.bodyText)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-008: combinational case statements should include default assignments to avoid inferred latches.', DiagnosticSeverity.Information, 'vc-008-case-default'));
      }
    }

    if (block.sequential) {
      if (isVerilogLintRuleEnabled(settings, 'vc-009') && !/\bposedge\s+[A-Za-z_]\w*/.test(block.sensitivity)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-009: sequential logic should be implemented in always @(posedge clock) blocks.', DiagnosticSeverity.Warning, 'vc-009-seq-posedge'));
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-011') && /\bnegedge\b/.test(block.sensitivity)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-011: avoid negedge-triggered logic unless a protocol explicitly requires it.', DiagnosticSeverity.Warning, 'vc-011-negedge'));
      }
      const edgeSignals = [...block.sensitivity.matchAll(/\b(?:posedge|negedge)\s+([A-Za-z_]\w*)/g)].map((match) => match[1]);
      for (const signal of edgeSignals) {
        if (isVerilogLintRuleEnabled(settings, 'vc-012') && !isClockOrResetSignal(signal)) {
          diagnostics.push(makeDiagnostic(block.headerRange, `VC-012: edge trigger on '${signal}' is not a clock/reset signal.`, DiagnosticSeverity.Warning, 'vc-012-edge-signal'));
        }
      }
      if (isVerilogLintRuleEnabled(settings, 'vc-014') && edgeSignals.length > 1) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-014: prefer synchronous reset; async reset appears in the sensitivity list.', DiagnosticSeverity.Information, 'vc-014-sync-reset'));
      }
      const assignments = collectAssignmentsInText(document, block.bodyText, block.bodyOffset, index);
      for (const assignment of assignments) {
        if (isVerilogLintRuleEnabled(settings, 'vc-010') && assignment.operator === '=' && !isInsideForControl(block.bodyText, document.offsetAt(assignment.range.start) - block.bodyOffset)) {
          diagnostics.push(makeDiagnostic(assignment.range, 'VC-010: sequential always blocks should use nonblocking assignments (<=).', DiagnosticSeverity.Warning, 'vc-010-seq-blocking'));
        }
      }
      const clockSignals = edgeSignals.filter((signal) => /clk|clock/i.test(signal));
      for (const clock of clockSignals) {
        const clockAsData = new RegExp(`(?:<=|=)\\s*[^;]*\\b${escapeRegExp(clock)}\\b`).exec(block.bodyText);
        if (isVerilogLintRuleEnabled(settings, 'vc-013') && clockAsData) {
          diagnostics.push(makeDiagnostic(block.headerRange, `VC-013: clock signal '${clock}' should not be used as data inside sequential logic.`, DiagnosticSeverity.Information, 'vc-013-clock-data'));
        }
      }
    }

    for (const assignment of collectAssignmentsInText(document, block.bodyText, block.bodyOffset, index)) {
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

function collectMagicNumberDiagnostics(document: TextDocument, settings: CoSettings, text: string, module: VerilogModule, diagnostics: Diagnostic[]): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-004')) {
    return;
  }
  const bodyStart = document.offsetAt(module.headerEnd);
  const bodyEnd = document.offsetAt(module.range.end);
  const body = stripCommentsAndStrings(text.slice(bodyStart, bodyEnd));
  const numberRegex = /\b(?:\d+'\s*[sS]?[bBoOdDhH]\s*[0-9a-fA-F_xXzZ?]+|\d+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = numberRegex.exec(body))) {
    const absolute = bodyStart + match.index;
    const line = document.positionAt(absolute).line;
    const lineText = lineAt(document, line).text;
    if (/\b(?:parameter|localparam)\b|`define/.test(lineText) || isTrivialLiteral(match[0]) || isInsideBracketRange(body, match.index)) {
      continue;
    }
    diagnostics.push(makeDiagnostic(rangeAtOffset(document, absolute, match[0].length), 'VC-004: replace magic numbers with a descriptive localparam, parameter, or macro.', DiagnosticSeverity.Information, 'vc-004-magic-number'));
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

function collectTestbenchDiagnostics(document: TextDocument, settings: CoSettings, text: string, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    const isTestbench = module.name.toLowerCase().includes('tb') || module.name === settings.project.testbench;
    if (!isTestbench) {
      continue;
    }
    const bodyStart = document.offsetAt(module.headerEnd);
    const bodyEnd = document.offsetAt(module.range.end);
    const body = text.slice(bodyStart, bodyEnd);
    if (!/`timescale\s+1ns\s*\/\s*1ps/.test(text)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: standard course testbenches should use `timescale 1ns / 1ps.', DiagnosticSeverity.Information, 'tb-timescale'));
    }
    if (!/\bclk\b[\s\S]*(?:forever\s*#|#\s*\d+)[\s\S]*\bclk\s*=\s*~\s*clk/.test(body)) {
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

function collectAlwaysBlocks(document: TextDocument, text: string, module: VerilogModule): AlwaysBlockInfo[] {
  const blocks: AlwaysBlockInfo[] = [];
  const moduleStart = document.offsetAt(module.headerEnd);
  const moduleEnd = document.offsetAt(module.range.end);
  const moduleText = text.slice(moduleStart, moduleEnd);
  const stripped = stripCommentsAndStrings(moduleText);
  const alwaysRegex = /\balways\s*@\s*\(([\s\S]*?)\)\s*/g;
  let match: RegExpExecArray | null;
  while ((match = alwaysRegex.exec(stripped))) {
    const headerStart = moduleStart + match.index;
    const bodyOffset = moduleStart + match.index + match[0].length;
    const bodyInfo = findAlwaysBody(stripped, match.index + match[0].length);
    const endOffset = moduleStart + bodyInfo.end;
    const sensitivity = match[1];
    const sequential = /\b(?:posedge|negedge)\b/.test(sensitivity);
    blocks.push({
      sensitivity,
      range: Range.create(document.positionAt(headerStart), document.positionAt(endOffset)),
      headerRange: Range.create(document.positionAt(headerStart), document.positionAt(bodyOffset)),
      bodyText: text.slice(bodyOffset, endOffset),
      bodyOffset,
      sequential,
      combinational: !sequential
    });
  }
  return blocks;
}

function findAlwaysBody(text: string, from: number): { end: number } {
  const start = skipWhitespace(text, from);
  if (/\bbegin\b/.test(text.slice(start, start + 12))) {
    const tokenRegex = /\b(begin|end)\b/g;
    tokenRegex.lastIndex = start;
    let depth = 0;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(text))) {
      if (match[1] === 'begin') {
        depth++;
      } else {
        depth--;
        if (depth === 0) {
          return { end: tokenRegex.lastIndex };
        }
      }
    }
    return { end: text.length };
  }
  const semicolon = text.indexOf(';', start);
  return { end: semicolon >= 0 ? semicolon + 1 : text.length };
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
