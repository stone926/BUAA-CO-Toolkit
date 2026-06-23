import {
  Diagnostic,
  DiagnosticSeverity,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import {
  AssignmentUse,
  collectAssignmentsFromStatements
} from './assignmentAnalysis';
import type { VerilogAstDocument, VerilogModuleAst } from './ast';
import { VerilogCstStatement } from './cst';
import { parseVerilogExpression } from './exprAst';
import {
  VerilogDecl,
  VerilogInstance,
  VerilogModule,
  VerilogParseResult,
  VerilogPortConnection
} from './model';
import { VerilogWorkspaceIndex } from './workspaceIndex';

interface DriverBuckets {
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
    const buckets = collectAssignmentDriverBuckets(document, moduleAst);
    for (const [name, drivers] of buckets) {
      if (drivers.continuous.length > 1) {
        diagnostics.push(makeDiagnostic(
          driverDiagnosticRange(module, name, drivers.continuous[1].range),
          `Signal '${name}' is driven by multiple continuous assignments.`,
          DiagnosticSeverity.Warning,
          'multi-driver'
        ));
      }
      if (drivers.continuous.length && drivers.procedural.length) {
        diagnostics.push(makeDiagnostic(
          driverDiagnosticRange(module, name, drivers.procedural[0].range),
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
    const buckets = collectAssignmentDriverBuckets(document, moduleAst);
    addInstanceOutputDrivers(module, parsed.modules, index, buckets);
    for (const [name, drivers] of buckets) {
      if (!drivers.instanceOutputs.length) {
        continue;
      }
      const assignmentCount = drivers.continuous.length + drivers.procedural.length;
      if (drivers.instanceOutputs.length > 1) {
        diagnostics.push(makeDiagnostic(
          driverDiagnosticRange(module, name, drivers.instanceOutputs[1]),
          `Signal '${name}' is driven by multiple instance outputs.`,
          DiagnosticSeverity.Warning,
          'multi-driver'
        ));
      } else if (assignmentCount > 0) {
        diagnostics.push(makeDiagnostic(
          driverDiagnosticRange(module, name, drivers.instanceOutputs[0]),
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
  moduleAst: VerilogModuleAst
): Map<string, DriverBuckets> {
  const buckets = new Map<string, DriverBuckets>();
  for (const assignment of collectContinuousAssignments(document, moduleAst)) {
    bucketFor(buckets, assignment.name).continuous.push(assignment);
  }
  for (const assignment of collectProceduralAssignments(document, moduleAst)) {
    bucketFor(buckets, assignment.name).procedural.push(assignment);
  }
  return buckets;
}

function collectContinuousAssignments(document: TextDocument, moduleAst: VerilogModuleAst): AssignmentUse[] {
  const statements = moduleAst.items
    .filter((statement) => statement.kind === 'continuousAssign')
    .map((statement) => statement.statement);
  return collectAssignmentsFromStatements(document, statements, 0, -1);
}

function collectProceduralAssignments(document: TextDocument, moduleAst: VerilogModuleAst): AssignmentUse[] {
  const result: AssignmentUse[] = [];
  for (let index = 0; index < moduleAst.proceduralBlocks.length; index++) {
    const block = moduleAst.proceduralBlocks[index];
    result.push(...collectAssignmentsFromStatements(document, statementsInTokenRange(moduleAst, block.bodyStart, block.bodyEnd), 0, index));
  }
  return result;
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
      bucketFor(buckets, targetName).instanceOutputs.push(connection.expressionRange);
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

function bucketFor(buckets: Map<string, DriverBuckets>, name: string): DriverBuckets {
  const existing = buckets.get(name);
  if (existing) {
    return existing;
  }
  const created: DriverBuckets = {
    continuous: [],
    procedural: [],
    instanceOutputs: []
  };
  buckets.set(name, created);
  return created;
}

function driverDiagnosticRange(module: VerilogModule, name: string, fallback: Range): Range {
  return module.declarations.get(name)?.selectionRange ?? fallback;
}

function statementsInTokenRange(moduleAst: VerilogModuleAst, start: number, end: number): VerilogCstStatement[] {
  return moduleAst.items
    .map((statement) => {
      const tokens = statement.tokens.filter((token) => token.start >= start && token.end <= end);
      if (!tokens.length) {
        return undefined;
      }
      return {
        ...statement.statement,
        tokens,
        start: tokens[0].start,
        end: tokens[tokens.length - 1].end
      };
    })
    .filter((statement): statement is VerilogCstStatement => Boolean(statement));
}
