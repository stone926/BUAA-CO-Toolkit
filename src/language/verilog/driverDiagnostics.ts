import {
  Diagnostic,
  DiagnosticSeverity,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import {
  AssignmentUse,
  collectContinuousAssignmentUsesFromAst,
  collectProceduralAssignmentUsesFromAst
} from './assignmentAst';
import type { VerilogAstDocument, VerilogModuleAst } from './ast';
import { parseVerilogExpression } from './exprAst';
import { exclusiveGenerateBranches, firstConflictingIndex, generateSignalKey } from './generateScopes';
import {
  VerilogDecl,
  VerilogInstance,
  VerilogModule,
  VerilogParseResult,
  VerilogPortConnection
} from './model';
import { VerilogWorkspaceIndex } from './workspaceIndex';

/** Drivers of one signal; generate-local signals are bucketed apart from same-named others. */
interface DriverBuckets {
  name: string;
  /** Declared in a generate block rather than at module level. */
  generateLocal: boolean;
  continuous: AssignmentUse[];
  procedural: AssignmentUse[];
  instanceOutputs: Range[];
}

export function collectContinuousProceduralDriverDiagnostics(
  document: TextDocument,
  ast: VerilogAstDocument,
  diagnostics: Diagnostic[]
): void {
  for (const moduleAst of ast.modules) {
    const module = moduleAst.module;
    const buckets = collectAssignmentDriverBuckets(document, module, moduleAst);
    for (const drivers of buckets.values()) {
      const { name } = drivers;
      // Drivers on different branches of one conditional generate never coexist.
      const conflicting = firstConflictingIndex(module, drivers.continuous.map((use) => use.range.start));
      if (conflicting >= 0) {
        diagnostics.push(makeDiagnostic(
          driverDiagnosticRange(module, drivers, drivers.continuous[conflicting].range),
          `Signal '${name}' is driven by multiple continuous assignments.`,
          DiagnosticSeverity.Warning,
          'multi-driver'
        ));
      }
      const mixed = drivers.procedural.find((procedural) =>
        drivers.continuous.some((continuous) => !exclusiveGenerateBranches(module, continuous.range.start, procedural.range.start)));
      if (mixed) {
        diagnostics.push(makeDiagnostic(
          driverDiagnosticRange(module, drivers, mixed.range),
          `Signal '${name}' is driven by both continuous and procedural assignments.`,
          DiagnosticSeverity.Warning,
          'multi-driver'
        ));
      }
    }
  }
}

export function collectWorkspaceDriverDiagnostics(
  document: TextDocument,
  parsed: VerilogParseResult,
  index: VerilogWorkspaceIndex
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const moduleAst of parsed.ast.modules) {
    const module = moduleAst.module;
    const buckets = collectAssignmentDriverBuckets(document, module, moduleAst);
    addInstanceOutputDrivers(module, parsed.modules, index, buckets);
    for (const drivers of buckets.values()) {
      const { name } = drivers;
      if (!drivers.instanceOutputs.length) {
        continue;
      }
      const conflicting = firstConflictingIndex(module, drivers.instanceOutputs.map((range) => range.start));
      const assignments = [...drivers.continuous, ...drivers.procedural];
      const assigned = drivers.instanceOutputs.find((output) =>
        assignments.some((assignment) => !exclusiveGenerateBranches(module, assignment.range.start, output.start)));
      if (conflicting >= 0) {
        diagnostics.push(makeDiagnostic(
          driverDiagnosticRange(module, drivers, drivers.instanceOutputs[conflicting]),
          `Signal '${name}' is driven by multiple instance outputs.`,
          DiagnosticSeverity.Warning,
          'multi-driver'
        ));
      } else if (assigned) {
        diagnostics.push(makeDiagnostic(
          driverDiagnosticRange(module, drivers, assigned),
          `Signal '${name}' is driven by an instance output and by an assignment.`,
          DiagnosticSeverity.Warning,
          'multi-driver'
        ));
      }
    }
  }
  return diagnostics;
}

function collectAssignmentDriverBuckets(
  document: TextDocument,
  module: VerilogModule,
  moduleAst: VerilogModuleAst
): Map<string, DriverBuckets> {
  const buckets = new Map<string, DriverBuckets>();
  for (const assignment of collectContinuousAssignments(document, moduleAst)) {
    bucketFor(buckets, module, assignment.name, assignment.range).continuous.push(assignment);
  }
  for (const assignment of collectProceduralAssignments(document, moduleAst)) {
    bucketFor(buckets, module, assignment.name, assignment.range).procedural.push(assignment);
  }
  return buckets;
}

function collectContinuousAssignments(document: TextDocument, moduleAst: VerilogModuleAst): AssignmentUse[] {
  return collectContinuousAssignmentUsesFromAst(document, moduleAst);
}

function collectProceduralAssignments(document: TextDocument, moduleAst: VerilogModuleAst): AssignmentUse[] {
  return collectProceduralAssignmentUsesFromAst(document, moduleAst);
}

function addInstanceOutputDrivers(
  module: VerilogModule,
  localModules: VerilogModule[],
  index: VerilogWorkspaceIndex,
  buckets: Map<string, DriverBuckets>
): void {
  for (const instance of module.instances) {
    const targetModule = resolveInstanceTarget(index, localModules, instance);
    if (!targetModule) {
      continue;
    }
    for (const connection of instance.portConnections) {
      const targetPort = targetPortForConnection(targetModule, connection);
      if (!targetPort || (targetPort.direction !== 'output' && targetPort.direction !== 'inout')) {
        continue;
      }
      const targetName = simpleConnectionTargetName(connection.expression);
      if (!targetName) {
        continue;
      }
      bucketFor(buckets, module, targetName, connection.expressionRange).instanceOutputs.push(connection.expressionRange);
    }
  }
}

function targetPortForConnection(targetModule: VerilogModule, connection: VerilogPortConnection): VerilogDecl | undefined {
  return connection.name
    ? targetModule.ports.find((port) => port.name === connection.name)
    : targetModule.ports[connection.positionalIndex];
}

function simpleConnectionTargetName(expression: string): string | undefined {
  const ast = parseVerilogExpression(expression);
  return ast?.kind === 'identifier' ? ast.name : undefined;
}

function resolveInstanceTarget(index: VerilogWorkspaceIndex, localModules: VerilogModule[], instance: VerilogInstance): VerilogModule | undefined {
  return index.getModule(instance.moduleName) ?? localModules.find((module) => module.name === instance.moduleName);
}

function bucketFor(buckets: Map<string, DriverBuckets>, module: VerilogModule, name: string, at: Range): DriverBuckets {
  const key = generateSignalKey(module, name, at.start);
  const existing = buckets.get(key);
  if (existing) {
    return existing;
  }
  const created: DriverBuckets = {
    name,
    generateLocal: key !== name,
    continuous: [],
    procedural: [],
    instanceOutputs: []
  };
  buckets.set(key, created);
  return created;
}

function driverDiagnosticRange(module: VerilogModule, drivers: DriverBuckets, fallback: Range): Range {
  return (drivers.generateLocal ? undefined : module.declarations.get(drivers.name)?.selectionRange) ?? fallback;
}
