// @index driver-diagnostics — Scope-bound, region-aware continuous/procedural/instance drivers
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { assignmentTargetsFromExpressionAst, collectContinuousAssignmentUsesFromAst, collectProceduralAssignmentUsesFromAst } from './assignmentAst';
import type { VerilogAstDocument, VerilogModuleAst } from './ast';
import { parseVerilogExpression, parseVerilogExpressionTokens, VerilogExpressionAst } from './exprAst';
import { exclusiveGenerateBranches } from './generateScopes';
import { VerilogInstance, VerilogModule, VerilogParseResult } from './model';
import { resolveInstanceTargetModule, uniqueModule } from './moduleResolution';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { accessPathsOverlap, declarationIsVariable, expressionAccessPaths, permitsResolvedDrivers, VerilogAccessPath } from './accessPaths';
import { findMatchingTokenForward, splitTopLevelTokens, trimTrailingSemicolonTokens } from './tokenUtils';

interface Driver {
  path: VerilogAccessPath;
  range: Range;
  kind: 'continuous' | 'procedural' | 'instance';
  source: object;
  initialization?: boolean;
}

export function collectContinuousProceduralDriverDiagnostics(document: TextDocument, ast: VerilogAstDocument, diagnostics: Diagnostic[]): void {
  for (const moduleAst of ast.modules) {
    const drivers = collectAssignmentDrivers(document, moduleAst);
    addInstanceOutputDrivers(document, moduleAst.module, (instance) => uniqueModule(ast.modules.filter((item) => item.name === instance.moduleName).map((item) => item.module)), drivers);
    reportDriverConflicts(moduleAst.module, drivers, diagnostics, false);
  }
}

export function collectWorkspaceDriverDiagnostics(document: TextDocument, parsed: VerilogParseResult, index: VerilogWorkspaceIndex): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const moduleAst of parsed.ast.modules) {
    const drivers = collectAssignmentDrivers(document, moduleAst);
    addInstanceOutputDrivers(document, moduleAst.module, (instance) => resolveInstanceTargetModule(index, parsed.modules, instance), drivers);
    reportDriverConflicts(moduleAst.module, drivers, diagnostics, true);
  }
  return diagnostics;
}

function collectAssignmentDrivers(document: TextDocument, moduleAst: VerilogModuleAst): Driver[] {
  const module = moduleAst.module;
  const result: Driver[] = [];
  for (const use of collectContinuousAssignmentUsesFromAst(document, moduleAst)) {
    addDriver(document, module, result, use.expression, use.range, 'continuous', use.source);
  }
  for (const use of collectProceduralAssignmentUsesFromAst(document, moduleAst)) {
    const block = moduleAst.proceduralBlocks[use.blockIndex];
    addDriver(document, module, result, use.expression, use.range, 'procedural', block, block?.kind === 'initial');
  }
  const declarations = [...new Set([...module.declarations.values(), ...module.generateBlocks.flatMap((block) => block.declarations)])];
  for (const decl of declarations) {
    if (!decl.initializer || declarationIsVariable(decl) || ['parameter', 'localparam', 'function', 'task'].includes(decl.kind)) { continue; }
    const expression: VerilogExpressionAst = { kind: 'identifier', name: decl.name, start: document.offsetAt(decl.selectionRange.start), end: document.offsetAt(decl.selectionRange.end) };
    addDriver(document, module, result, expression, decl.selectionRange, 'continuous', decl);
  }
  for (const statement of moduleAst.items) {
    if (statement.kind !== 'gatePrimitive') { continue; }
    const tokens = trimTrailingSemicolonTokens(statement.tokens);
    const primitive = tokens[0]?.value;
    // A bidirectional switch is a legal resolved connection, not a conflicting source.
    if (['tran', 'rtran', 'tranif0', 'tranif1', 'rtranif0', 'rtranif1'].includes(primitive)) { continue; }
    for (const group of splitTopLevelTokens(tokens.slice(1), ',')) {
      const open = group.findIndex((token, offset) => token.value === '(' && findMatchingTokenForward(group, offset, '(', ')') === group.length - 1);
      if (open < 0) { continue; }
      const ports = splitTopLevelTokens(group.slice(open + 1, -1), ',');
      const outputs = primitive === 'buf' || primitive === 'not' ? ports.slice(0, -1) : ports.slice(0, 1);
      for (const port of outputs) {
        const expression = parseVerilogExpressionTokens(port);
        if (expression) { addExpressionDrivers(document, module, result, expression, 'continuous', group); }
      }
    }
  }
  return result;
}

function addInstanceOutputDrivers(document: TextDocument, module: VerilogModule, resolve: (instance: VerilogInstance) => VerilogModule | undefined, drivers: Driver[]): void {
  for (const instance of module.instances) {
    const target = resolve(instance);
    if (!target) { continue; }
    for (const connection of instance.portConnections) {
      const port = connection.name ? target.ports.find((item) => item.name === connection.name) : target.ports[connection.positionalIndex];
      if (port?.direction !== 'output') { continue; }
      const expression = connection.expressionAst ?? parseVerilogExpression(connection.expression);
      if (expression) { addExpressionDrivers(document, module, drivers, expression, 'instance', connection); }
    }
  }
}

function addExpressionDrivers(document: TextDocument, module: VerilogModule, drivers: Driver[], expression: VerilogExpressionAst, kind: Driver['kind'], source: object): void {
  for (const target of assignmentTargetsFromExpressionAst(document, expression)) {
    addDriver(document, module, drivers, target.expression, target.range, kind, source);
  }
}

function addDriver(document: TextDocument, module: VerilogModule, drivers: Driver[], expression: VerilogExpressionAst, range: Range, kind: Driver['kind'], source: object, initialization?: boolean): void {
  for (const path of expressionAccessPaths(document, module, expression)) {
    drivers.push({ path, range, kind, source, initialization });
  }
}

function reportDriverConflicts(module: VerilogModule, drivers: Driver[], diagnostics: Diagnostic[], instanceOnly: boolean): void {
  const buckets = new Map<string, Driver[]>();
  for (const driver of drivers) {
    const bucket = buckets.get(driver.path.identity) ?? [];
    bucket.push(driver);
    buckets.set(driver.path.identity, bucket);
  }
  for (const bucket of buckets.values()) {
    let reported = false;
    for (let index = 1; index < bucket.length && !reported; index++) {
      const current = bucket[index];
      if (permitsResolvedDrivers(current.path.declaration)) { continue; }
      for (const previous of bucket.slice(0, index)) {
        if (instanceOnly && current.kind !== 'instance' && previous.kind !== 'instance') { continue; }
        if (previous.source === current.source || !accessPathsOverlap(previous.path, current.path)
          || exclusiveGenerateBranches(module, previous.range.start, current.range.start)) { continue; }
        // Initial blocks initialize variables; legacy diagnostics intentionally report competing always blocks.
        if (previous.kind === 'procedural' && current.kind === 'procedural' && (previous.initialization || current.initialization)) { continue; }
        const name = current.path.name;
        const description = previous.kind === 'instance' || current.kind === 'instance'
          ? previous.kind === current.kind ? 'multiple instance outputs' : 'an instance output and by an assignment'
          : previous.kind === current.kind ? current.kind === 'procedural' ? 'multiple always blocks' : 'multiple continuous assignments' : 'both continuous and procedural assignments';
        diagnostics.push(makeDiagnostic(current.path.declaration?.selectionRange ?? current.range, `Signal '${name}' is driven by ${description}.`, DiagnosticSeverity.Warning, 'multi-driver'));
        reported = true;
        break;
      }
    }
  }
}
