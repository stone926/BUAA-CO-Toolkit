import {
  DocumentSymbol,
  SymbolKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import {
  declDetail,
  parseVerilog
} from './parser';

export function getVerilogDocumentSymbols(document: TextDocument, settings: CoSettings): DocumentSymbol[] {
  const parsed = parseVerilog(document, settings, false);
  const symbols: DocumentSymbol[] = parsed.macros.map((macro) => DocumentSymbol.create(macro.name, 'macro', SymbolKind.Constant, macro.range, macro.selectionRange));
  for (const module of parsed.modules) {
    const symbol = DocumentSymbol.create(module.name, 'module', SymbolKind.Module, module.range, module.selectionRange, []);
    for (const param of module.parameters) {
      symbol.children?.push(DocumentSymbol.create(param.name, declDetail(param), SymbolKind.Constant, param.range, param.selectionRange));
    }
    for (const port of module.ports) {
      symbol.children?.push(DocumentSymbol.create(port.name, declDetail(port), SymbolKind.Field, port.range, port.selectionRange));
    }
    for (const decl of module.declarations.values()) {
      if (module.ports.some((port) => port.name === decl.name) || module.parameters.some((param) => param.name === decl.name)) {
        continue;
      }
      symbol.children?.push(DocumentSymbol.create(decl.name, declDetail(decl), SymbolKind.Variable, decl.range, decl.selectionRange));
    }
    for (const instance of module.instances) {
      symbol.children?.push(DocumentSymbol.create(instance.instanceName, instance.moduleName, SymbolKind.Object, instance.range, instance.selectionRange));
    }
    symbols.push(symbol);
  }
  return symbols.sort((a, b) => a.range.start.line - b.range.start.line);
}
