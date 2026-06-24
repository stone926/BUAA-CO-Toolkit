import {
  Diagnostic,
  DiagnosticSeverity
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  VerilogDeclDimension,
  VerilogInstance,
  VerilogModule,
  VerilogParseResult
} from './model';
import { getCachedVerilogParse } from './parseCache';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { collectInstanceConnectionDiagnostics } from './instanceConnectionDiagnostics';
import { collectWorkspaceDriverDiagnostics } from './driverDiagnostics';
import { collectWorkspaceUsageDiagnostics } from './usageDiagnostics';
import { evalExpressionAstConstant } from './expressions';
import { parseVerilogExpression, VerilogExpressionAst } from './exprAst';
import { walkVerilogExpression } from './exprAstUtils';
import type { VerilogAstDocument } from './ast';
import type { VerilogProceduralStatementAst } from './proceduralAst';

interface WorkspaceDiagnosticSummary {
  version: number;
  numericValues: Set<bigint>;
  memoryDepths: Set<number>;
  instanceModuleNamesLower: Set<string>;
}

const workspaceSummaryCache = new WeakMap<VerilogWorkspaceIndex, WorkspaceDiagnosticSummary>();

export function addVerilogWorkspaceDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  index: VerilogWorkspaceIndex,
  baseDiagnostics: Diagnostic[],
  parsed?: VerilogParseResult
): Diagnostic[] {
  const resolved = parsed ?? getCachedVerilogParse(document, settings, false);
  const diagnostics = filterWorkspaceAwareDiagnostics(baseDiagnostics, settings, index, resolved);
  diagnostics.push(...getWorkspaceModuleDiagnostics(settings, index, resolved));
  diagnostics.push(...getWorkspaceInstanceDiagnostics(document, settings, index, resolved));
  if (!index.complete) {
    return diagnostics;
  }
  if (settings.verilog.lint.courseRules) {
    diagnostics.push(...collectWorkspaceDriverDiagnostics(document, resolved, index));
    diagnostics.push(...collectWorkspaceUsageDiagnostics(document, settings, resolved, index));
  }
  diagnostics.push(...getWorkspaceProjectDiagnostics(settings, index, resolved, workspaceDiagnosticSummary(index)));
  return diagnostics;
}

function filterWorkspaceAwareDiagnostics(
  diagnostics: Diagnostic[],
  settings: CoSettings,
  index: VerilogWorkspaceIndex,
  parsed: VerilogParseResult
): Diagnostic[] {
  const topName = settings.project.topModule.trim() || 'mips';
  if (index.complete && !index.getModule(topName) && !parsed.modules.some((module) => module.name === topName)) {
    return diagnostics;
  }
  return diagnostics.filter((diagnostic) => diagnostic.code !== 'missing-top');
}

function getWorkspaceInstanceDiagnostics(document: TextDocument, settings: CoSettings, index: VerilogWorkspaceIndex, parsed: VerilogParseResult): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const module of parsed.modules) {
    for (const instance of module.instances) {
      const target = resolveInstanceTarget(index, parsed.modules, instance);
      if (!target || target.uri === document.uri) {
        continue;
      }
      collectInstanceConnectionDiagnostics(document, module, instance, target, diagnostics);
    }
  }
  return diagnostics;
}

function getWorkspaceModuleDiagnostics(settings: CoSettings, index: VerilogWorkspaceIndex, parsed: VerilogParseResult): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const topName = settings.project.topModule.trim() || 'mips';
  const testbenchName = settings.project.testbench.trim();
  for (const module of parsed.modules) {
    const duplicates = index.getModules(module.name).filter((candidate) => candidate.uri !== module.uri);
    if (duplicates.length) {
      diagnostics.push(makeDiagnostic(
        module.selectionRange,
        `Duplicate module '${module.name}'. Another definition exists in ${formatModuleLocation(duplicates[0])}.`,
        DiagnosticSeverity.Error,
        'duplicate-module'
      ));
    }
    if (
      settings.verilog.lint.courseRules &&
      index.complete &&
      module.name !== topName &&
      module.name !== testbenchName &&
      !hasInstanceOfModule(index, parsed.modules, module.name)
    ) {
      diagnostics.push(makeDiagnostic(
        module.selectionRange,
        `Module '${module.name}' is not instantiated by any indexed module.`,
        DiagnosticSeverity.Information,
        'uninstantiated-module'
      ));
    }
  }

  return diagnostics;
}

function resolveInstanceTarget(index: VerilogWorkspaceIndex, localModules: VerilogModule[], instance: VerilogInstance): VerilogModule | undefined {
  return index.getModule(instance.moduleName) ?? localModules.find((module) => module.name === instance.moduleName);
}

function hasInstanceOfModule(index: VerilogWorkspaceIndex, localModules: VerilogModule[], moduleName: string): boolean {
  return index.moduleReferenceLocations(moduleName).length > 0 || localModules.some((module) =>
    module.instances.some((instance) => instance.moduleName === moduleName)
  );
}

function formatModuleLocation(module: VerilogModule): string {
  return `${formatUri(module.uri)}:${module.selectionRange.start.line + 1}`;
}

function formatUri(uri: string): string {
  try {
    return URI.parse(uri).fsPath || uri;
  } catch {
    return uri;
  }
}

function getWorkspaceProjectDiagnostics(
  settings: CoSettings,
  index: VerilogWorkspaceIndex,
  parsed: VerilogParseResult,
  summary: WorkspaceDiagnosticSummary
): Diagnostic[] {
  if (!settings.verilog.lint.courseRules) {
    return [];
  }
  const profile = settings.project.profile;
  if (profile !== 'P4' && profile !== 'P5' && profile !== 'P6' && profile !== 'P7') {
    return [];
  }

  const topName = settings.project.topModule.trim() || 'mips';
  const top = parsed.modules.find((module) => module.name === topName);
  if (!top) {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const topRange = top.selectionRange;

  if (profile === 'P4' || profile === 'P5') {
    if (!hasWorkspaceNumericValue(summary, 0x3000)) {
      diagnostics.push(makeDiagnostic(topRange, `${profile}: PC should reset to 0x00003000; no obvious 0x3000 reset constant was found in the workspace.`, DiagnosticSeverity.Information, 'project-pc-reset'));
    }
    if (!hasMemoryDepth(summary, 4096)) {
      diagnostics.push(makeDiagnostic(topRange, `${profile}: IM is expected to be 16 KiB (4096 32-bit words).`, DiagnosticSeverity.Information, 'project-im-size'));
    }
    if (!hasMemoryDepth(summary, 3072)) {
      diagnostics.push(makeDiagnostic(topRange, `${profile}: DM is expected to be 12 KiB (3072 32-bit words).`, DiagnosticSeverity.Information, 'project-dm-size'));
    }
  }

  if (profile === 'P7') {
    for (const required of ['CPU', 'Bridge', 'TC']) {
      if (!hasModuleCaseInsensitive(index, required)) {
        diagnostics.push(makeDiagnostic(topRange, `P7: workspace should contain module '${required}'.`, DiagnosticSeverity.Warning, `p7-module-${required.toLowerCase()}`));
      } else if (!hasInstanceOfModuleCaseInsensitive(summary, parsed.modules, required) && required.toLowerCase() !== top.name.toLowerCase()) {
        diagnostics.push(makeDiagnostic(topRange, `P7: module '${required}' exists but is not obviously instantiated in the design hierarchy.`, DiagnosticSeverity.Information, `p7-instance-${required.toLowerCase()}`));
      }
    }
    const cp0 = findModuleCaseInsensitive(index, 'CP0');
    if (!cp0) {
      diagnostics.push(makeDiagnostic(topRange, 'P7: workspace should contain a CP0 module.', DiagnosticSeverity.Warning, 'p7-module-cp0'));
    } else {
      for (const registerName of ['SR', 'CAUSE', 'EPC']) {
        if (!hasDeclarationCaseInsensitive(cp0, registerName)) {
          diagnostics.push(makeDiagnostic(topRange, `P7: CP0 should implement register '${registerName}'.`, DiagnosticSeverity.Warning, `p7-cp0-${registerName.toLowerCase()}`));
        }
      }
    }
  }

  return diagnostics;
}

function workspaceDiagnosticSummary(index: VerilogWorkspaceIndex): WorkspaceDiagnosticSummary {
  const cached = workspaceSummaryCache.get(index);
  if (cached?.version === index.version) {
    return cached;
  }
  const summary: WorkspaceDiagnosticSummary = {
    version: index.version,
    numericValues: new Set(),
    memoryDepths: new Set(),
    instanceModuleNamesLower: new Set()
  };
  for (const module of index.indexedModules()) {
    for (const instance of module.instances) {
      summary.instanceModuleNamesLower.add(instance.moduleName.toLowerCase());
    }
  }
  for (const file of index.indexedFiles()) {
    collectWorkspaceSummaryFromAst(file.semantic.ast, summary);
  }
  workspaceSummaryCache.set(index, summary);
  return summary;
}

function hasWorkspaceNumericValue(summary: WorkspaceDiagnosticSummary, expected: number): boolean {
  return summary.numericValues.has(BigInt(expected));
}

function hasMemoryDepth(summary: WorkspaceDiagnosticSummary, depth: number): boolean {
  return summary.memoryDepths.has(depth);
}

function collectWorkspaceSummaryFromAst(ast: VerilogAstDocument, summary: WorkspaceDiagnosticSummary): void {
  const addExpression = (expression: VerilogExpressionAst | undefined): void => {
    if (!expression) {
      return;
    }
    walkVerilogExpression(expression, (candidate) => {
      if (candidate.kind === 'numberLiteral' && candidate.parsed?.value !== undefined) {
        summary.numericValues.add(candidate.parsed.value);
      }
    });
  };

  for (const item of ast.preprocessor) {
    if (item.kind === 'macroDefinition' && item.macro.body) {
      addExpression(parseVerilogExpression(item.macro.body));
    }
  }

  for (const moduleAst of ast.modules) {
    for (const statement of moduleAst.items) {
      for (const expression of statement.expressions) {
        addExpression(expression);
      }
    }
    for (const decl of moduleAst.module.declarations.values()) {
      for (const expression of decl.widthAst ?? []) {
        addExpression(expression);
      }
      addExpression(decl.initializerAst);
      for (const dimension of decl.unpackedDimensions ?? []) {
        for (const expression of dimension.expressions) {
          addExpression(expression);
        }
        const depth = memoryDepthFromDimension(dimension, moduleAst.module);
        if (depth !== undefined) {
          summary.memoryDepths.add(depth);
        }
      }
    }
    for (const instance of moduleAst.module.instances) {
      for (const connection of [...instance.parameterConnections, ...instance.portConnections]) {
        addExpression(connection.expressionAst);
      }
    }
    for (const block of moduleAst.proceduralBlocks) {
      visitProceduralStatementExpressions(block.statementTree, addExpression);
    }
  }
}

function visitProceduralStatementExpressions(
  statement: VerilogProceduralStatementAst,
  visitExpression: (expression: VerilogExpressionAst | undefined) => void
): void {
  switch (statement.kind) {
    case 'block':
      for (const child of statement.statements) {
        visitProceduralStatementExpressions(child, visitExpression);
      }
      return;
    case 'assignment':
      visitExpression(statement.lhs);
      visitExpression(statement.rhs);
      return;
    case 'if':
      visitExpression(statement.condition);
      visitProceduralStatementExpressions(statement.consequent, visitExpression);
      if (statement.alternate) {
        visitProceduralStatementExpressions(statement.alternate, visitExpression);
      }
      return;
    case 'case':
      visitExpression(statement.expression);
      for (const item of statement.items) {
        for (const label of item.labels) {
          visitExpression(label);
        }
        visitProceduralStatementExpressions(item.body, visitExpression);
      }
      return;
    case 'loop':
      visitExpression(statement.condition);
      visitProceduralStatementExpressions(statement.body, visitExpression);
      return;
    case 'other':
      visitExpression(statement.expression);
      return;
    case 'declaration':
      return;
  }
}

function memoryDepthFromDimension(dimension: VerilogDeclDimension, module: VerilogModule): number | undefined {
  if (dimension.expressions.length !== 2) {
    return undefined;
  }
  const leftValue = evalExpressionAstConstant(dimension.expressions[0], module);
  const rightValue = evalExpressionAstConstant(dimension.expressions[1], module);
  if (leftValue === 0n) {
    return safeDepthFromLastIndex(rightValue);
  }
  if (rightValue === 0n) {
    return safeDepthFromLastIndex(leftValue);
  }
  return undefined;
}

function safeDepthFromLastIndex(value: bigint | undefined): number | undefined {
  if (value === undefined || value < 0n || value >= BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(value + 1n);
}

function hasModuleCaseInsensitive(index: VerilogWorkspaceIndex, name: string): boolean {
  return Boolean(index.findModuleCaseInsensitive(name));
}

function findModuleCaseInsensitive(index: VerilogWorkspaceIndex, name: string): VerilogModule | undefined {
  return index.findModuleCaseInsensitive(name);
}

function hasInstanceOfModuleCaseInsensitive(summary: WorkspaceDiagnosticSummary, localModules: VerilogModule[], moduleName: string): boolean {
  const lower = moduleName.toLowerCase();
  return summary.instanceModuleNamesLower.has(lower) || localModules.some((module) =>
    module.instances.some((instance) => instance.moduleName.toLowerCase() === lower)
  );
}

function hasDeclarationCaseInsensitive(module: VerilogModule, name: string): boolean {
  const lower = name.toLowerCase();
  for (const declaration of module.declarations.values()) {
    if (declaration.name.toLowerCase() === lower) {
      return true;
    }
  }
  return false;
}
