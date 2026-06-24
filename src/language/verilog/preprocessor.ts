import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { rangeKey } from '../common/util';
import { parseVerilogCst } from './cst';
import { VerilogToken } from './lexer';
import {
  VerilogDirective,
  VerilogInclude,
  VerilogMacro,
  VerilogMacroUse
} from './model';

export const preprocessorDirectives = new Set([
  'define',
  'undef',
  'ifdef',
  'ifndef',
  'elsif',
  'else',
  'endif',
  'include',
  'timescale',
  'default_nettype',
  'resetall',
  'undefineall',
  'begin_keywords',
  'end_keywords',
  'celldefine',
  'endcelldefine',
  'pragma'
]);

export function parseMacros(document: TextDocument, text: string): VerilogMacro[] {
  return parseMacrosFromTokens(document, parseVerilogCst(document, text).codeTokens);
}

export function parseMacrosFromTokens(document: TextDocument, tokens: VerilogToken[]): VerilogMacro[] {
  const macros: VerilogMacro[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!isDirective(token, 'define')) {
      continue;
    }
    const name = nextTokenOnLine(document, tokens, index + 1, token);
    if (!name || name.kind !== 'identifier') {
      continue;
    }
    const nameEnd = document.positionAt(name.end);
    const lineEnd = document.positionAt(token.end).line;
    const lineText = lineAt(document, lineEnd).text;
    const bodyStart = nameEnd.character;
    const body = lineText.slice(bodyStart).trim();
    macros.push({
      name: name.value,
      range: lineAt(document, document.positionAt(token.start).line).range,
      selectionRange: tokenRange(document, name),
      body: body || undefined
    });
  }
  return macros;
}

export function parseMacroUses(
  document: TextDocument,
  text: string,
  macros: VerilogMacro[] = parseMacros(document, text)
): VerilogMacroUse[] {
  return parseMacroUsesFromTokens(document, macros, parseVerilogCst(document, text).codeTokens);
}

export function parseMacroUsesFromTokens(
  document: TextDocument,
  macros: VerilogMacro[],
  tokens: VerilogToken[]
): VerilogMacroUse[] {
  const uses: VerilogMacroUse[] = [];
  const declarationRanges = new Set(macros.map((macro) => rangeKey(macro.selectionRange)));
  for (const token of tokens) {
    if (token.kind !== 'directive') {
      continue;
    }
    const name = directiveName(token);
    if (!name || preprocessorDirectives.has(name)) {
      continue;
    }
    const selectionRange = Range.create(document.positionAt(token.start + 1), document.positionAt(token.end));
    if (declarationRanges.has(rangeKey(selectionRange))) {
      continue;
    }
    uses.push({
      name,
      range: tokenRange(document, token),
      selectionRange
    });
  }
  return uses;
}

export function parseIncludes(document: TextDocument, text: string): VerilogInclude[] {
  return parseIncludesFromTokens(document, parseVerilogCst(document, text).codeTokens);
}

export function parseIncludesFromTokens(document: TextDocument, tokens: VerilogToken[]): VerilogInclude[] {
  const includes: VerilogInclude[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!isDirective(token, 'include')) {
      continue;
    }
    const path = nextTokenOnLine(document, tokens, index + 1, token);
    if (!path || path.kind !== 'string' || path.value.length < 2) {
      continue;
    }
    includes.push({
      path: path.value.slice(1, -1),
      range: lineAt(document, document.positionAt(token.start).line).range,
      pathRange: Range.create(document.positionAt(path.start + 1), document.positionAt(path.end - 1))
    });
  }
  return includes;
}

export function parseDirectives(document: TextDocument, text: string): VerilogDirective[] {
  return parseDirectivesFromTokens(document, parseVerilogCst(document, text).codeTokens);
}

export function parseDirectivesFromTokens(document: TextDocument, tokens: VerilogToken[]): VerilogDirective[] {
  const directives: VerilogDirective[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const name = directiveName(token);
    if (!name || !preprocessorDirectives.has(name)) {
      continue;
    }
    const argument = nextTokenOnLine(document, tokens, index + 1, token);
    directives.push({
      name,
      argument: argument?.value,
      range: lineAt(document, document.positionAt(token.start).line).range,
      selectionRange: Range.create(document.positionAt(token.start + 1), document.positionAt(token.end)),
      argumentRange: argument ? tokenRange(document, argument) : undefined
    });
  }
  return directives;
}

function nextTokenOnLine(document: TextDocument, tokens: VerilogToken[], start: number, anchor: VerilogToken): VerilogToken | undefined {
  const line = document.positionAt(anchor.start).line;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'eof') {
      return undefined;
    }
    if (document.positionAt(token.start).line !== line) {
      return undefined;
    }
    return token;
  }
  return undefined;
}

function isDirective(token: VerilogToken, name: string): boolean {
  return directiveName(token) === name;
}

function directiveName(token: VerilogToken): string | undefined {
  return token.kind === 'directive' && token.value.startsWith('`') ? token.value.slice(1) : undefined;
}

function tokenRange(document: TextDocument, token: VerilogToken): Range {
  return Range.create(document.positionAt(token.start), document.positionAt(token.end));
}
