// @index(resolve Verilog symbols from syntax/semantic model)
import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsPosition, rangesEqual } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { VerilogDecl, VerilogInclude, VerilogInstance, VerilogMacro, VerilogMacroUse, VerilogModule, VerilogPortConnection } from './model';
import { moduleAtPosition, splitTopLevelCommaSpans } from './parser';
import { getCachedVerilogParse } from './parseCache';
import { resolveVerilogSemanticAtPosition, VerilogSemanticModel, VerilogSemanticResolution, VerilogSemanticSymbol } from './semanticModel';
export interface ResolvedDecl {
  kind: 'decl';
  decl: VerilogDecl;
  module: VerilogModule;
}

export interface ResolvedModule {
  kind: 'module';
  module: VerilogModule;
}

export interface ResolvedInstance {
  kind: 'instance';
  instance: VerilogInstance;
  module: VerilogModule;
}

export interface ResolvedPortConnection {
  kind: 'portConnection';
  module: VerilogModule;
  instance: VerilogInstance;
  connection: VerilogPortConnection;
  targetModule: VerilogModule;
  targetPort: VerilogDecl;
  targetSymbol?: VerilogSemanticSymbol;
  listKind: VerilogConnectionListKind;
}

export interface ResolvedMacro {
  kind: 'macro';
  macro?: VerilogMacro;
  macroUse?: VerilogMacroUse;
  name: string;
}

export interface ResolvedInclude {
  kind: 'include';
  include: VerilogInclude;
}

export type VerilogConnectionListKind = 'ports' | 'parameters';

export type ResolvedVerilogSymbol = (
  | ResolvedDecl
  | ResolvedModule
  | ResolvedInstance
  | ResolvedPortConnection
  | ResolvedMacro
  | ResolvedInclude
) & { sourceRange?: Range };

export interface InstanceContext {
  module: VerilogModule;
  instance: VerilogInstance;
  targetModule?: VerilogModule;
  listKind: VerilogConnectionListKind;
  listRange: Range;
  connections: VerilogPortConnection[];
}

export interface NamedInstanceConnection {
  connection: VerilogPortConnection;
  listKind: VerilogConnectionListKind;
}

export interface InstanceConnectionTarget {
  targetModule: VerilogModule;
  targetPort: VerilogDecl;
  targetSymbol?: VerilogSemanticSymbol;
  listKind: VerilogConnectionListKind;
}


export function resolveVerilogSymbol(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): ResolvedVerilogSymbol | undefined {
  const parsed = getCachedVerilogParse(document, settings, false);
  const semanticResolved = resolvedVerilogSymbolFromSemantic(parsed, position, index);
  if (semanticResolved) {
    return semanticResolved;
  }
  const include = parsed.includes.find((item) => containsPosition(item.pathRange, position));
  if (include) {
    return { kind: 'include', include };
  }
  const currentModule = moduleAtPosition(parsed.modules, position);
  if (currentModule) {
    if (containsPosition(currentModule.selectionRange, position)) {
      return { kind: 'module', module: currentModule, sourceRange: currentModule.selectionRange };
    }
    for (const instance of currentModule.instances) {
      if (containsPosition(instance.moduleSelectionRange, position)) {
        const target = resolveInstanceTargetModule(index, parsed.modules, instance);
        return target ? { kind: 'module', module: target, sourceRange: instance.moduleSelectionRange } : undefined;
      }
      if (containsPosition(instance.selectionRange, position)) {
        return { kind: 'instance', module: currentModule, instance, sourceRange: instance.selectionRange };
      }
      const namedConnection = findNamedInstanceConnectionAtPosition(instance, position);
      if (namedConnection) {
        const target = resolveInstanceConnectionTarget(index, parsed.modules, instance, namedConnection.connection, namedConnection.listKind);
        if (target) {
          return { kind: 'portConnection', module: currentModule, instance, connection: namedConnection.connection, sourceRange: namedConnection.connection.nameRange, ...target };
        }
      }
    }
    const decl = [...currentModule.declarations.values()].find((item) => containsPosition(item.selectionRange, position));
    if (decl) {
      return { kind: 'decl', decl, module: currentModule, sourceRange: decl.selectionRange };
    }
  }

  const macro = parsed.macros.find((item) => containsPosition(item.selectionRange, position));
  if (macro) {
    return { kind: 'macro', macro, name: macro.name, sourceRange: macro.selectionRange };
  }
  const macroUse = parsed.macroUses.find((item) => containsPosition(item.selectionRange, position));
  if (macroUse) {
    return { kind: 'macro', macro: index.getMacro(macroUse.name), macroUse, name: macroUse.name, sourceRange: macroUse.selectionRange };
  }
  return undefined;
}

export function resolvedVerilogSymbolFromSemantic(
  parsed: ReturnType<typeof getCachedVerilogParse>,
  position: Position,
  index: VerilogWorkspaceIndex
): ResolvedVerilogSymbol | undefined {
  const resolved = resolveVerilogSemanticAtPosition(parsed.semantic, position);
  if (!resolved) {
    return undefined;
  }
  return mapSemanticResolution(parsed.modules, resolved, index);
}

export function mapSemanticResolution(
  modules: VerilogModule[],
  resolved: VerilogSemanticResolution,
  index: VerilogWorkspaceIndex
): ResolvedVerilogSymbol | undefined {
  const reference = resolved.reference;
  if (
    (reference?.kind === 'portConnection' || reference?.kind === 'parameterConnection') &&
    reference.module &&
    reference.instance &&
    reference.portConnection?.name
  ) {
    const listKind = connectionListKindForInstanceConnection(reference.instance, reference.portConnection);
    const target = resolveInstanceConnectionTarget(index, modules, reference.instance, reference.portConnection, listKind);
    if (target) {
      return {
        kind: 'portConnection',
        module: reference.module,
        instance: reference.instance,
        connection: reference.portConnection,
        sourceRange: reference.range,
        ...target
      };
    }
  }
  if (reference?.kind === 'module') {
    const module = resolved.symbol?.module ?? index.getModule(reference.name) ?? modules.find((item) => item.name === reference.name);
    return module ? { kind: 'module', module, sourceRange: reference.range } : undefined;
  }
  if (reference?.kind === 'macro') {
    return {
      kind: 'macro',
      macro: resolved.symbol?.macro ?? index.getMacro(reference.name),
      macroUse: reference.macroUse,
      name: reference.name,
      sourceRange: reference.range
    };
  }
  if (reference?.kind === 'include' && reference.include) {
    return { kind: 'include', include: reference.include, sourceRange: reference.range };
  }

  const symbol = resolved.symbol;
  if (!symbol) {
    return undefined;
  }
  if (symbol.kind === 'module' && symbol.module) {
    return { kind: 'module', module: symbol.module, sourceRange: symbol.selectionRange };
  }
  if ((symbol.kind === 'signal' || symbol.kind === 'port' || symbol.kind === 'parameter' || symbol.kind === 'task') && symbol.decl && symbol.module) {
    return { kind: 'decl', decl: symbol.decl, module: symbol.module, sourceRange: symbol.selectionRange };
  }
  if (symbol.kind === 'instance' && symbol.instance && symbol.module) {
    return { kind: 'instance', instance: symbol.instance, module: symbol.module, sourceRange: symbol.selectionRange };
  }
  if (symbol.kind === 'macro') {
    return { kind: 'macro', macro: symbol.macro, name: symbol.name, sourceRange: symbol.selectionRange };
  }
  if (symbol.kind === 'include' && symbol.include) {
    return { kind: 'include', include: symbol.include, sourceRange: symbol.selectionRange };
  }
  return undefined;
}

export function resolveInstanceTargetModule(index: VerilogWorkspaceIndex, modules: VerilogModule[], instance: VerilogInstance): VerilogModule | undefined {
  return index.getModule(instance.moduleName) ?? modules.find((item) => item.name === instance.moduleName);
}

export function resolveInstanceConnectionTarget(
  index: VerilogWorkspaceIndex,
  modules: VerilogModule[],
  instance: VerilogInstance,
  connection: VerilogPortConnection,
  preferredListKind?: VerilogConnectionListKind
): InstanceConnectionTarget | undefined {
  if (!connection.name) {
    return undefined;
  }
  const targetModule = resolveInstanceTargetModule(index, modules, instance);
  if (!targetModule) {
    return undefined;
  }
  const listKinds = preferredListKind ? [preferredListKind] : (['ports', 'parameters'] as const);
  for (const listKind of listKinds) {
    const targetSymbol = index.findModuleSymbol(targetModule, connection.name, semanticKindsForConnectionList(listKind));
    const targetPort = targetSymbol?.decl ?? declarationsForConnectionList(targetModule, listKind).find((decl) => decl.name === connection.name);
    if (targetPort) {
      return {
        targetModule,
        targetPort,
        targetSymbol,
        listKind
      };
    }
  }
  return undefined;
}

export function findNamedInstanceConnectionAtPosition(instance: VerilogInstance, position: Position): NamedInstanceConnection | undefined {
  for (const connection of instance.parameterConnections) {
    if (connection.nameRange && containsPosition(connection.nameRange, position)) {
      return { connection, listKind: 'parameters' };
    }
  }
  for (const connection of instance.portConnections) {
    if (connection.nameRange && containsPosition(connection.nameRange, position)) {
      return { connection, listKind: 'ports' };
    }
  }
  return undefined;
}

export function connectionListKindForInstanceConnection(instance: VerilogInstance, connection: VerilogPortConnection): VerilogConnectionListKind | undefined {
  if (instance.parameterConnections.includes(connection)) {
    return 'parameters';
  }
  if (instance.portConnections.includes(connection)) {
    return 'ports';
  }
  return undefined;
}

export function connectionListKindForModuleDecl(module: VerilogModule, decl: VerilogDecl): VerilogConnectionListKind | undefined {
  if (module.ports.some((port) => sameDeclarationIdentity(port, decl))) {
    return 'ports';
  }
  if (module.parameters.some((param) => sameDeclarationIdentity(param, decl))) {
    return 'parameters';
  }
  return undefined;
}

export function declarationsForConnectionList(module: VerilogModule, listKind: VerilogConnectionListKind): VerilogDecl[] {
  return listKind === 'parameters' ? module.parameters : module.ports;
}

export function semanticKindsForConnectionList(listKind: VerilogConnectionListKind): readonly ('parameter' | 'port')[] {
  return listKind === 'parameters' ? ['parameter'] : ['port'];
}

export function sameDeclarationIdentity(left: VerilogDecl, right: VerilogDecl): boolean {
  return left === right || (left.name === right.name && rangesEqual(left.selectionRange, right.selectionRange));
}


export function findInstanceContext(modules: VerilogModule[], position: Position, index: VerilogWorkspaceIndex): InstanceContext | undefined {
  const module = moduleAtPosition(modules, position);
  if (!module) {
    return undefined;
  }
  for (const instance of module.instances) {
    if (instance.parameterListRange && containsPosition(instance.parameterListRange, position)) {
      return {
        module,
        instance,
        targetModule: resolveInstanceTargetModule(index, modules, instance),
        listKind: 'parameters',
        listRange: instance.parameterListRange,
        connections: instance.parameterConnections
      };
    }
    if (instance.portListRange && containsPosition(instance.portListRange, position)) {
      return {
        module,
        instance,
        targetModule: resolveInstanceTargetModule(index, modules, instance),
        listKind: 'ports',
        listRange: instance.portListRange,
        connections: instance.portConnections
      };
    }
  }
  return undefined;
}

export function activeConnectionIndex(document: TextDocument, position: Position, context: InstanceContext, entries: VerilogDecl[]): number {
  for (const connection of context.connections) {
    if (containsPosition(connection.range, position)) {
      if (connection.name) {
        const namedIndex = entries.findIndex((entry) => entry.name === connection.name);
        return namedIndex >= 0 ? namedIndex : connection.positionalIndex;
      }
      return Math.min(connection.positionalIndex, entries.length - 1);
    }
  }
  const start = document.offsetAt(context.listRange.start);
  const end = document.offsetAt(position);
  const prefix = document.getText().slice(start, end);
  let active = 0;
  for (const span of splitTopLevelCommaSpans(prefix)) {
    if (span.end < prefix.length) {
      active++;
    }
  }
  return Math.min(active, Math.max(0, entries.length - 1));
}


export function resolvedRange(resolved: ResolvedVerilogSymbol): Range | undefined {
  switch (resolved.kind) {
    case 'decl':
      return resolved.decl.selectionRange;
    case 'instance':
      return resolved.instance.selectionRange;
    case 'module':
      return resolved.module.selectionRange;
    case 'portConnection':
      return resolved.connection.nameRange;
    case 'macro':
      return resolved.macro?.selectionRange ?? resolved.macroUse?.selectionRange;
    case 'include':
      return resolved.include.pathRange;
  }
}

export function sourceRangeAtPosition(semantic: VerilogSemanticModel, position: Position): Range | undefined {
  const resolved = resolveVerilogSemanticAtPosition(semantic, position);
  return resolved?.reference?.range ?? resolved?.symbol?.selectionRange;
}


