import {
  Diagnostic,
  DiagnosticSeverity,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic, rangesEqual } from '../common/lsp';
import { rangeKey } from '../common/util';
import { collectAssignmentUsesFromModuleAst } from './assignmentAst';
import { parseVerilogExpression } from './exprAst';
import {
  VerilogDecl,
  VerilogInstance,
  VerilogModule,
  VerilogParseResult,
  VerilogPortConnection
} from './model';
import {
  VerilogSemanticModel,
  VerilogSemanticReference
} from './semanticModel';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { CoSettings } from '../common/settings';

interface UsageBuckets {
  reads: Range[];
  writes: Range[];
}

export function collectWorkspaceUsageDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  parsed: VerilogParseResult,
  index: VerilogWorkspaceIndex
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const module of parsed.modules) {
    if (isTestbenchModule(module, settings)) {
      continue;
    }
    const usage = collectModuleUsage(document, parsed, index, module);
    for (const decl of module.declarations.values()) {
      if (shouldCheckParameterUsage(decl)) {
        const parameterReads = parameterReadRanges(parsed.semantic, module, decl);
        if (!parameterReads.length) {
          diagnostics.push(makeDiagnostic(decl.selectionRange, `Parameter '${decl.name}' is declared but never used.`, DiagnosticSeverity.Information, 'unused-parameter'));
        }
        continue;
      }
      if (!shouldCheckSignalUsage(decl)) {
        continue;
      }
      const entry = usage.get(decl.name) ?? { reads: [], writes: [] };
      if (!entry.reads.length && !entry.writes.length) {
        diagnostics.push(makeDiagnostic(decl.selectionRange, `Signal '${decl.name}' is declared but never used.`, DiagnosticSeverity.Information, 'unused-signal'));
      }
    }
  }
  return diagnostics;
}

function collectModuleUsage(
  document: TextDocument,
  parsed: VerilogParseResult,
  index: VerilogWorkspaceIndex,
  module: VerilogModule
): Map<string, UsageBuckets> {
  const usage = new Map<string, UsageBuckets>();
  const writeRangeKeys = new Set<string>();
  const moduleAst = parsed.ast.modules.find((candidate) => candidate.module === module);
  if (moduleAst) {
    for (const assignment of collectAssignmentUsesFromModuleAst(document, moduleAst)) {
      addWrite(usage, writeRangeKeys, assignment.name, assignment.range);
    }
  }
  for (const decl of module.declarations.values()) {
    if (decl.initializerRange && shouldCheckSignalUsage(decl)) {
      addWrite(usage, writeRangeKeys, decl.name, decl.selectionRange);
    }
  }
  for (const driver of instanceOutputDrivers(module, parsed.modules, index)) {
    addWrite(usage, writeRangeKeys, driver.name, driver.range);
  }
  for (const reference of parsed.semantic.references) {
    if (!referenceBelongsToModule(reference, module) || reference.kind === 'portConnection') {
      continue;
    }
    if (writeRangeKeys.has(rangeKey(reference.range))) {
      continue;
    }
    const decl = module.declarations.get(reference.name);
    if (!decl || (!shouldCheckSignalUsage(decl) && !shouldCheckParameterUsage(decl))) {
      continue;
    }
    addRead(usage, reference.name, reference.range);
  }
  return usage;
}

function parameterReadRanges(semantic: VerilogSemanticModel, module: VerilogModule, decl: VerilogDecl): Range[] {
  const ranges: Range[] = [];
  const seen = new Set<string>();
  const add = (range: Range): void => {
    if (rangesEqual(range, decl.selectionRange)) {
      return;
    }
    const key = rangeKey(range);
    if (!seen.has(key)) {
      ranges.push(range);
      seen.add(key);
    }
  };
  for (const reference of semantic.references) {
    if (referenceBelongsToModule(reference, module) && reference.name === decl.name && reference.kind !== 'portConnection') {
      add(reference.range);
    }
  }
  return ranges;
}

function instanceOutputDrivers(
  module: VerilogModule,
  localModules: VerilogModule[],
  index: VerilogWorkspaceIndex
): Array<{ name: string; range: Range }> {
  const drivers: Array<{ name: string; range: Range }> = [];
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
      const name = simpleConnectionTargetName(connection.expression);
      if (name) {
        drivers.push({ name, range: connection.expressionRange });
      }
    }
  }
  return drivers;
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

function shouldCheckParameterUsage(decl: VerilogDecl): boolean {
  return decl.kind === 'parameter' || decl.kind === 'localparam';
}

function shouldCheckSignalUsage(decl: VerilogDecl): boolean {
  if (decl.direction) {
    return false;
  }
  return decl.kind === 'wire' ||
    decl.kind === 'reg' ||
    decl.kind === 'logic' ||
    decl.kind === 'time';
}

function addRead(usage: Map<string, UsageBuckets>, name: string, range: Range): void {
  bucketFor(usage, name).reads.push(range);
}

function addWrite(usage: Map<string, UsageBuckets>, writeRangeKeys: Set<string>, name: string, range: Range): void {
  bucketFor(usage, name).writes.push(range);
  writeRangeKeys.add(rangeKey(range));
}

function bucketFor(usage: Map<string, UsageBuckets>, name: string): UsageBuckets {
  const existing = usage.get(name);
  if (existing) {
    return existing;
  }
  const created: UsageBuckets = {
    reads: [],
    writes: []
  };
  usage.set(name, created);
  return created;
}

function referenceBelongsToModule(reference: VerilogSemanticReference, module: VerilogModule): boolean {
  return reference.module === module ||
    Boolean(reference.module &&
      reference.module.name === module.name &&
      reference.module.uri === module.uri &&
      rangesEqual(reference.module.selectionRange, module.selectionRange));
}

function isTestbenchModule(module: VerilogModule, settings: CoSettings): boolean {
  const configured = settings.project.testbench.trim().toLowerCase();
  const name = module.name.toLowerCase();
  return name.includes('tb') || (configured !== '' && name === configured);
}
