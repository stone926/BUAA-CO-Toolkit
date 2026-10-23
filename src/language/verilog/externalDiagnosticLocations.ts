// @index verilog-external-diagnostic-locations — source-aware compiler ranges and lossless local diagnostic merging
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt, rangesEqual } from '../common/lsp';
import { rangeKey } from '../common/util';
import { lexVerilog, VerilogToken } from './lexer';

export interface IverilogLocationData {
  iverilogLocation: 'line' | 'column';
}

/** Icarus normally has a line but no column. Never erase a more precise local error. */
export function mergeVerilogExternalDiagnostics(document: TextDocument, local: readonly Diagnostic[], external: readonly Diagnostic[], sourceTokens?: readonly VerilogToken[]): Diagnostic[] {
  if (!external.length) return [...local];
  const tokens = sourceTokens ?? lexVerilog(document.getText()).tokens;
  const lines = new Map<number, { text: string; tokens: VerilogToken[] }>();
  const sourceLine = (line: number) => {
    let result = lines.get(line);
    if (!result) {
      const text = lineAt(document, line).text;
      const start = document.offsetAt({ line, character: 0 });
      result = { text, tokens: tokensOnLine(tokens, start, start + text.length) };
      lines.set(line, result);
    }
    return result;
  };
  const merged = [...local];
  const seen = new Set<string>();
  for (const diagnostic of external) {
    const location = (diagnostic.data as IverilogLocationData | undefined)?.iverilogLocation;
    if (diagnostic.code !== 'iverilog-syntax' || !location) {
      merged.push(diagnostic);
      continue;
    }
    const line = Math.max(0, Math.min(diagnostic.range.start.line, document.lineCount - 1));
    const { text, tokens } = sourceLine(line);
    const syntax = isGenericSyntaxMessage(diagnostic.message) && diagnostic.severity === DiagnosticSeverity.Error
      ? local.filter((item) => String(item.code).startsWith('syntax-') && item.severity === DiagnosticSeverity.Error &&
        item.range.start.line === line && item.range.end.line === line && item.range.end.character > item.range.start.character)
      : [];
    const uniqueRanges = [...new Map(syntax.map((item) => [rangeKey(item.range), item.range])).values()];
    const hasColumn = location === 'column';
    const namedToken = !hasColumn ? tokenNamedByMessage(diagnostic.message, tokens) : undefined;
    let range: Range;
    if (hasColumn) {
      const start = Math.min(diagnostic.range.start.character, text.length);
      const token = tokens.find((item) => item.start <= start && item.end > start);
      range = Range.create(line, start, line, token?.end ?? Math.min(start + 1, text.length));
    } else if (namedToken) {
      range = Range.create(line, namedToken.start, line, namedToken.end);
    } else if (uniqueRanges.length === 1) {
      range = uniqueRanges[0];
    } else {
      // Broad line location is intentional: a missing semicolon may be reported
      // on the following line, so guessing an operator or previous token is unsafe.
      const start = tokens[0]?.start ?? Math.max(0, text.search(/\S/));
      const end = tokens[tokens.length - 1]?.end ?? text.trimEnd().length;
      range = Range.create(line, start, line, Math.max(start, end));
    }

    const localIndex = !hasColumn && uniqueRanges.length === 1
      ? local.findIndex((item) => syntax.includes(item) && rangesEqual(item.range, range)) : -1;
    if (localIndex >= 0) {
      const original = merged[localIndex];
      const message = `${diagnostic.source ?? 'Icarus Verilog'}: ${diagnostic.message}`;
      const related = original.relatedInformation ?? [];
      if (!related.some((item) => item.message === message && item.location.uri === document.uri && rangesEqual(item.location.range, range))) {
        merged[localIndex] = { ...original, relatedInformation: [...related, { location: { uri: document.uri, range }, message }] };
      }
      continue;
    }
    const key = JSON.stringify([rangeKey(range), diagnostic.severity, diagnostic.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...diagnostic, range });
  }
  return merged;
}

/** Slice a sorted whole-document token stream; preserve cross-line comment state. */
function tokensOnLine(tokens: readonly VerilogToken[], start: number, end: number): VerilogToken[] {
  let low = 0, high = tokens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (tokens[middle].end <= start) low = middle + 1;
    else high = middle;
  }
  const result: VerilogToken[] = [];
  for (let index = low; index < tokens.length && tokens[index].start < end; index++) {
    const token = tokens[index];
    if (token.kind !== 'eof' && token.kind !== 'comment') {
      result.push({ ...token, start: Math.max(start, token.start) - start, end: Math.min(end, token.end) - start });
    }
  }
  return result;
}

function isGenericSyntaxMessage(message: string): boolean {
  return /^(?:syntax error|invalid module item|malformed statement|syntax in assignment statement l-value)\.?$/i.test(message.trim());
}

function tokenNamedByMessage(message: string, tokens: readonly VerilogToken[]): VerilogToken | undefined {
  const name = /^(?:Unable to bind (?:wire\/reg\/memory|parameter)|Could not find variable)\s+[`'"]+([^`'"]+)[`'"]/i.exec(message)?.[1]
    ?? /^port\s+[`'"]+([^`'"]+)[`'"]+\s+is not a port\b/i.exec(message)?.[1]
    ?? /^Unable to elaborate r-value:\s*([a-zA-Z_][\w$]*)\s*$/i.exec(message)?.[1];
  if (!name) return undefined;
  const matches = tokens.filter((token) => token.kind === 'identifier' && token.value === name);
  return matches.length === 1 ? matches[0] : undefined;
}
