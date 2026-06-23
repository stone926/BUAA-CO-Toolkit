import {
  Diagnostic,
  DiagnosticSeverity,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { collectProceduralBlocksFromCst } from './blockAst';
import {
  AssignmentUse,
  collectAssignmentsFromTokens
} from './assignmentAnalysis';
import {
  VerilogCstDocument,
  VerilogCstStatement
} from './cst';
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
  modules: VerilogModule[],
  cst: VerilogCstDocument,
  diagnostics: Diagnostic[]
): void {
  for (const module of modules) {
    const buckets = collectAssignmentDriverBuckets(document, module, cst);
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
  for (const module of parsed.modules) {
    const buckets = collectAssignmentDriverBuckets(document, module, parsed.cst);
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
  module: VerilogModule,
  cst: VerilogCstDocument
): Map<string, DriverBuckets> {
  const buckets = new Map<string, DriverBuckets>();
  for (const assignment of collectContinuousAssignments(document, module, cst)) {
    bucketFor(buckets, assignment.name).continuous.push(assignment);
  }
  for (const assignment of collectProceduralAssignments(document, module, cst)) {
    bucketFor(buckets, assignment.name).procedural.push(assignment);
  }
  return buckets;
}

function collectContinuousAssignments(document: TextDocument, module: VerilogModule, cst: VerilogCstDocument): AssignmentUse[] {
  const statements = moduleStatements(document, module, cst)
    .filter((statement) => firstCodeToken(statement)?.value === 'assign');
  return collectAssignmentsFromTokens(document, cstFromStatements(cst, statements), 0, -1);
}

function collectProceduralAssignments(document: TextDocument, module: VerilogModule, cst: VerilogCstDocument): AssignmentUse[] {
  const result: AssignmentUse[] = [];
  const blocks = collectProceduralBlocksFromCst(document, cst, module);
  for (let index = 0; index < blocks.length; index++) {
    result.push(...collectAssignmentsFromTokens(document, cstFromTokenRange(cst, blocks[index].bodyStart, blocks[index].bodyEnd), 0, index));
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

function moduleStatements(document: TextDocument, module: VerilogModule, cst: VerilogCstDocument): VerilogCstStatement[] {
  const start = document.offsetAt(module.headerEnd);
  const end = document.offsetAt(module.endmoduleRange?.start ?? module.range.end);
  return cst.statements.filter((statement) => statement.end > start && statement.start < end);
}

function firstCodeToken(statement: VerilogCstStatement) {
  return statement.tokens.find((token) => token.kind !== 'eof');
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
