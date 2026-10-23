// @index preprocessor-diagnostics — preprocessor issues bound to document and indexed include snapshots
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { makeDiagnostic } from '../common/lsp';
import { DocumentResultCache } from '../common/documentResultCache';
import { lexVerilog, VerilogToken } from './lexer';
import { preprocessVerilogTokens } from './preprocessorState';
import type { VerilogWorkspaceIndex } from './workspaceIndex';

const tokenCache = new DocumentResultCache<VerilogToken[]>();
const standaloneCache = new DocumentResultCache<Diagnostic[]>();
const indexedCaches = new WeakMap<VerilogWorkspaceIndex, {
  version: number; complete: boolean; documents: DocumentResultCache<Diagnostic[]>;
}>();

export function collectVerilogPreprocessorDiagnostics(document: TextDocument, index?: VerilogWorkspaceIndex): Diagnostic[] {
  if (!index) return standaloneCache.getOrCreate(document, 'preprocessor', () => analyze(document));
  let cached = indexedCaches.get(index);
  if (!cached || cached.version !== index.version || cached.complete !== index.complete) {
    cached = { version: index.version, complete: index.complete, documents: new DocumentResultCache<Diagnostic[]>() };
    indexedCaches.set(index, cached);
  }
  return cached.documents.getOrCreate(document, 'preprocessor', () => analyze(document, index));
}

function analyze(document: TextDocument, index?: VerilogWorkspaceIndex): Diagnostic[] {
  const text = document.getText();
  const externalMacroNames = new Set(index?.indexedFiles(document.uri)
    .filter((file) => file.uri !== document.uri).flatMap((file) => file.macros.map((macro) => macro.name)));
  let includeFiles: Map<string, { uri: string; text: string }> | undefined;
  const tokens = tokenCache.getOrCreate(document, 'preprocessor-tokens', () => lexVerilog(text).tokens);
  const result = preprocessVerilogTokens(text, tokens, {
    uri: document.uri,
    externalMacroNames,
    unknownDependencies: index?.complete === false,
    resolveInclude: (includePath, fromUri) => {
      let includeUri: string;
      try {
        const from = URI.parse(fromUri);
        if (from.scheme === 'file') {
          includeUri = URI.file(path.resolve(path.dirname(from.fsPath), includePath)).toString();
        } else {
          includeUri = from.with({ path: path.posix.resolve(path.posix.dirname(from.path), includePath.replace(/\\/g, '/')) }).toString();
        }
      } catch { return undefined; }
      const direct = index?.getFile(includeUri);
      if (direct) return { uri: direct.uri, text: direct.text };
      // Editor URIs and synthetic/open documents may encode drive letters differently.
      includeFiles ??= new Map(index?.allFiles().map((file) => [sourceKey(file.uri), file]));
      const file = includeFiles.get(sourceKey(includeUri));
      return file ? { uri: file.uri, text: file.text } : undefined;
    }
  });
  return result.issues.filter((issue) => issue.uri === document.uri).map((issue) => makeDiagnostic(
    Range.create(document.positionAt(issue.start), document.positionAt(issue.end)),
    issue.message, issue.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error, issue.code
  ));
}

function sourceKey(uri: string): string {
  const parsed = URI.parse(uri);
  if (parsed.scheme !== 'file') return parsed.toString();
  const filePath = path.normalize(parsed.fsPath);
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}
