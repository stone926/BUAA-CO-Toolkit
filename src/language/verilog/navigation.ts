// @index(Verilog definition and reference provider)
import * as path from 'path';
import { Location, Position, Range, ReferenceParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { rangesEqual } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { rangeKey } from '../common/util';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { VerilogInclude, VerilogMacro, VerilogModule } from './model';
import { getCachedVerilogParse } from './parseCache';
import {
  findVerilogSemanticSymbol,
  verilogSemanticReferenceRanges,
  verilogSemanticTargetFromSymbol,
  VerilogSemanticModel,
  VerilogSemanticSymbol
} from './semanticModel';
import {
  VerilogConnectionListKind,
  connectionListKindForModuleDecl,
  resolveVerilogSymbol
} from './resolveSymbol';

export function getVerilogDefinition(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): Location | undefined {
  const resolved = resolveVerilogSymbol(document, position, settings, index);
  if (!resolved) {
    return undefined;
  }
  switch (resolved.kind) {
    case 'decl':
      return Location.create(document.uri, resolved.decl.selectionRange);
    case 'instance':
      return Location.create(document.uri, resolved.instance.selectionRange);
    case 'module':
      return Location.create(resolved.module.uri, resolved.module.selectionRange);
    case 'portConnection':
      return Location.create(resolved.targetSymbol?.uri ?? resolved.targetModule.uri, resolved.targetSymbol?.selectionRange ?? resolved.targetPort.selectionRange);
    case 'macro': {
      const macro = resolved.macro ?? index.getMacro(resolved.name);
      if (!macro) {
        return undefined;
      }
      return index.macroDefinitionLocations(macro.name)
        .find((location) => rangesEqual(location.range, macro.selectionRange))
        ?? Location.create(document.uri, macro.selectionRange);
    }
    case 'include':
      return includeLocation(document, resolved.include);
  }
}

export function getVerilogReferences(document: TextDocument, params: ReferenceParams, settings: CoSettings, index: VerilogWorkspaceIndex): Location[] {
  const resolved = resolveVerilogSymbol(document, params.position, settings, index);
  if (!resolved || resolved.kind === 'include') {
    return [];
  }
  const parsed = getCachedVerilogParse(document, settings, false);
  const includeDeclaration = params.context.includeDeclaration;
  switch (resolved.kind) {
    case 'decl': {
      const locations = collectSemanticSymbolReferences(document.uri, parsed.semantic, resolved.module, resolved.decl.name, resolved.decl.selectionRange, includeDeclaration);
      const connectionKind = connectionListKindForModuleDecl(resolved.module, resolved.decl);
      if (connectionKind) {
        locations.push(...collectInterfaceConnectionReferences(index, resolved.module, resolved.decl.name, connectionKind));
      }
      return dedupeLocations(locations);
    }
    case 'instance':
      return collectSemanticSymbolReferences(document.uri, parsed.semantic, resolved.module, resolved.instance.instanceName, resolved.instance.selectionRange, includeDeclaration);
    case 'module':
      return collectModuleReferences(index, resolved.module, includeDeclaration);
    case 'portConnection': {
      const locations = collectSignalReferencesForIndexedModule(
        index,
        resolved.targetModule,
        resolved.targetPort.name,
        resolved.targetPort.selectionRange,
        includeDeclaration,
        resolved.targetSymbol
      );
      locations.push(...collectInterfaceConnectionReferences(index, resolved.targetModule, resolved.targetPort.name, resolved.listKind));
      return dedupeLocations(locations);
    }
    case 'macro':
      return collectMacroReferences(index, resolved.name, resolved.macro, includeDeclaration, document.uri);
  }
}

function collectSignalReferencesForIndexedModule(
  index: VerilogWorkspaceIndex,
  module: VerilogModule,
  name: string,
  declarationRange: Range | undefined,
  includeDeclaration: boolean,
  targetSymbol?: VerilogSemanticSymbol
): Location[] {
  const file = index.getFile(module.uri);
  if (!file) {
    return includeDeclaration && declarationRange ? [Location.create(module.uri, declarationRange)] : [];
  }
  if (targetSymbol) {
    return collectSemanticSymbolReferenceLocations(file.uri, file.semantic, targetSymbol, includeDeclaration);
  }
  return collectSemanticSymbolReferences(file.uri, file.semantic, module, name, declarationRange, includeDeclaration);
}

function collectSemanticSymbolReferences(uri: string, semantic: VerilogSemanticModel, module: VerilogModule, name: string, declarationRange: Range | undefined, includeDeclaration: boolean): Location[] {
  const symbol = findVerilogSemanticSymbol(semantic, (candidate) =>
    candidate.name === name &&
    candidate.module?.name === module.name &&
    (!declarationRange || rangesEqual(candidate.selectionRange, declarationRange))
  );
  if (!symbol) {
    return includeDeclaration && declarationRange ? [Location.create(uri, declarationRange)] : [];
  }
  return collectSemanticSymbolReferenceLocations(uri, semantic, symbol, includeDeclaration);
}

function collectSemanticSymbolReferenceLocations(uri: string, semantic: VerilogSemanticModel, symbol: VerilogSemanticSymbol, includeDeclaration: boolean): Location[] {
  return verilogSemanticReferenceRanges(semantic, verilogSemanticTargetFromSymbol(symbol), includeDeclaration)
    .map((range) => Location.create(uri, range));
}

function collectModuleReferences(index: VerilogWorkspaceIndex, target: VerilogModule, includeDeclaration: boolean): Location[] {
  const locations: Location[] = [];
  if (includeDeclaration) {
    locations.push(Location.create(target.uri, target.selectionRange));
  }
  locations.push(...index.moduleReferenceLocations(target.name));
  return dedupeLocations(locations);
}

function collectInterfaceConnectionReferences(
  index: VerilogWorkspaceIndex,
  targetModule: VerilogModule,
  name: string,
  listKind: VerilogConnectionListKind
): Location[] {
  return [...index.interfaceConnectionLocations(targetModule.name, name, listKind)];
}

function collectMacroReferences(index: VerilogWorkspaceIndex, name: string, macro: VerilogMacro | undefined, includeDeclaration: boolean, fallbackUri: string): Location[] {
  const locations: Location[] = [];
  if (includeDeclaration) {
    const definitions = macro
      ? index.macroDefinitionLocations(name).filter((location) => rangesEqual(location.range, macro.selectionRange))
      : index.macroDefinitionLocations(name);
    if (macro && !definitions.length) {
      locations.push(Location.create(fallbackUri, macro.selectionRange));
    } else {
      locations.push(...definitions);
    }
  }
  locations.push(...index.macroUseLocations(name));
  return dedupeLocations(locations);
}

function includeLocation(document: TextDocument, include: VerilogInclude): Location | undefined {
  if (document.uri.startsWith('untitled:')) {
    return undefined;
  }
  try {
    const currentPath = URI.parse(document.uri).fsPath;
    const uri = URI.file(path.resolve(path.dirname(currentPath), include.path)).toString();
    return Location.create(uri, Range.create(0, 0, 0, 0));
  } catch {
    return undefined;
  }
}

export function dedupeLocations(locations: Location[]): Location[] {
  const seen = new Set<string>();
  const result: Location[] = [];
  for (const location of locations) {
    const key = `${location.uri}:${rangeKey(location.range)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(location);
  }
  return result;
}
