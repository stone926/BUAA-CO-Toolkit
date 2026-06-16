import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings, isVerilogLintRuleEnabled } from '../common/settings';
import { collectAssignmentsFromTokens } from './assignmentAnalysis';
import {
  assignmentRhsContainsIdentifier,
  collectAlwaysBlocksFromCst,
  edgeSignalsFromSensitivity,
  hasAnyTokenValue,
  hasTokenValue,
  isOffsetInsideForControl
} from './blockAst';
import { VerilogCstDocument, VerilogCstStatement } from './cst';
import { VerilogToken } from './lexer';
import { VerilogModule } from './model';
import {
  isClockOrResetSignal,
  isClockSignalName
} from './lintSignalNames';

export function collectAlwaysStyleDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  cst: VerilogCstDocument,
  module: VerilogModule,
  diagnostics: Diagnostic[]
): void {
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

function cstFromTokenRange(cst: VerilogCstDocument, start: number, end: number): VerilogCstDocument {
  return {
    ...cst,
    statements: cst.statements
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
  };
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
