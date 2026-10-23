// @index(Verilog rename provider)
import { Position, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { getCachedVerilogParse } from './parseCache';
import { resolveVerilogSymbol, resolvedRange, sourceRangeAtPosition } from './resolveSymbol';
import { dedupeLocations, getVerilogReferences } from './navigation';
import { lexVerilog } from './lexer';
import { rangesEqual } from '../common/lsp';
import { resolveVerilogSemanticAtPosition, VerilogSemanticModel, VerilogSemanticScope, VerilogSemanticSymbol } from './semanticModel';

export function getVerilogRenameEdits(document: TextDocument, position: Position, newName: string, settings: CoSettings, index: VerilogWorkspaceIndex): WorkspaceEdit | undefined {
  if (!isIdentifier(newName)) {
    return undefined;
  }
  const resolved = resolveVerilogSymbol(document, position, settings, index);
  if (!resolved || resolved.kind === 'include') return undefined;
  const parsed = getCachedVerilogParse(document, settings, false);
  let semantic = parsed.semantic;
  let symbol = resolveVerilogSemanticAtPosition(semantic, position)?.symbol;
  if (resolved.kind === 'portConnection') {
    semantic = index.getSemantic(resolved.targetModule.uri) ?? semantic;
    symbol = resolved.targetSymbol ?? semantic.symbols.find((candidate) =>
      candidate.decl === resolved.targetPort);
  } else if (resolved.kind === 'module') {
    semantic = index.getSemantic(resolved.module.uri) ?? semantic;
    symbol = semantic.symbols.find((candidate) => candidate.kind === 'module' &&
      candidate.uri === resolved.module.uri && rangesEqual(candidate.selectionRange, resolved.module.selectionRange));
  } else if (resolved.kind === 'macro' && resolved.macro) {
    const owner = index.indexedFiles(document.uri).find((file) => file.macros.includes(resolved.macro!));
    semantic = owner?.semantic ?? semantic;
    symbol = semantic.symbols.find((candidate) => candidate.macro === resolved.macro);
  }
  if (!symbol || hasRenameConflict(semantic, symbol, newName)) return undefined;
  if (symbol.kind === 'macro') {
    const models = new Set([semantic, ...index.indexedFiles(symbol.uri).map((file) => file.semantic)]);
    const definitions = [...models].flatMap((model) => model.symbols.filter((candidate) => candidate.kind === 'macro' && candidate.name === symbol!.name));
    const changesLifetime = [...models].some((model) => model.ast.preprocessor.some((node) =>
      node.kind === 'directive' && node.name === 'undef' && node.argument?.trim() === symbol!.name));
    // Definition/use/undef lifetimes need a single binding before edits are safe.
    // Never return a partial rename that changes only a redefined macro's header.
    if (definitions.length > 1 || changesLifetime) return undefined;
  }
  if (symbol.kind === 'module' && index.getModules(symbol.name, symbol.uri).length > 1) return undefined;
  if (symbol.kind === 'module' && index.getModules(newName, symbol.uri).some((candidate) => candidate !== symbol.module)) return undefined;
  const references = getVerilogReferences(document, {
    textDocument: { uri: document.uri },
    position,
    context: { includeDeclaration: true }
  }, settings, index);
  if (!references.length) {
    return undefined;
  }
  const changes: Record<string, TextEdit[]> = {};
  for (const location of dedupeLocations(references)) {
    const edits = changes[location.uri] ?? [];
    edits.push(TextEdit.replace(location.range, newName));
    changes[location.uri] = edits;
  }
  return { changes };
}

export function getVerilogRenamePrepare(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): Range | undefined {
  const resolved = resolveVerilogSymbol(document, position, settings, index);
  if (!resolved || resolved.kind === 'include') {
    return undefined;
  }
  const parsed = getCachedVerilogParse(document, settings, false);
  const range = sourceRangeAtPosition(parsed.semantic, position) ?? resolved.sourceRange ?? resolvedRange(resolved);
  if (!range) {
    return undefined;
  }
  const text = document.getText(range);
  return isIdentifier(text) ? range : undefined;
}

function isIdentifier(value: string): boolean {
  // Reuse the language lexer: keywords, system identifiers and token sequences
  // are not names. Escaped names need whitespace-aware edits, so leave those
  // to a separate refactoring rather than emitting malformed identifiers.
  if (!value || value.startsWith('\\')) return false;
  const lexed = lexVerilog(value);
  const tokens = lexed.tokens.filter((token) => token.kind !== 'eof');
  return lexed.diagnostics.length === 0 && tokens.length === 1 &&
    tokens[0].kind === 'identifier' && tokens[0].start === 0 && tokens[0].end === value.length;
}

function hasRenameConflict(model: VerilogSemanticModel, target: VerilogSemanticSymbol, name: string): boolean {
  if (name === target.name) return false;
  if (target.scope.symbols.get(name)?.some((symbol) => symbol !== target)) return true;
  for (const reference of model.references) {
    if (reference.symbol === target) {
      // A renamed reference must not bind to a declaration in an inner scope.
      for (let scope: VerilogSemanticScope | undefined = reference.scope; scope && scope !== target.scope; scope = scope.parent) {
        if (scope.symbols.get(name)?.length) return true;
      }
    } else if (reference.name === name) {
      // Introducing the new declaration must not capture existing references
      // to an outer name. Unrelated sibling scopes remain renameable.
      for (let scope: VerilogSemanticScope | undefined = reference.scope; scope; scope = scope.parent) {
        if (scope === target.scope) return true;
        if (scope.symbols.get(name)?.length) break;
      }
    }
  }
  return false;
}
