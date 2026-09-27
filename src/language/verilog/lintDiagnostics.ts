// @index lint — 未声明标识符、端口网线类型与 testbench 时钟诊断
import { Diagnostic, DiagnosticSeverity, Position, Range } from 'vscode-languageserver/node';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { systemTasks, VerilogModule, verilogKeywords } from './model';
import { safeRegExp } from './textUtils';
import type { VerilogSemanticModel } from './semanticModel';
import type { VerilogExpressionAst } from './exprAst';
import { VerilogProceduralBlockAst } from './blockAst';
import type { VerilogAstDocument } from './ast';
import type { VerilogAssignmentStatementAst, VerilogProceduralStatementAst } from './proceduralAst';

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

export function collectTestbenchDiagnostics(settings: CoSettings, ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  for (const moduleAst of ast.modules) {
    const module = moduleAst.module;
    if (!isTestbenchModule(module, settings)) {
      continue;
    }
    if (declaredClockNames(module).size && !hasTestbenchClockGeneration(module, moduleAst.proceduralBlocks)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: include clk generation logic.', DiagnosticSeverity.Information, 'tb-clock'));
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

function isClockSignalName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('clk') || lower.includes('clock');
}
