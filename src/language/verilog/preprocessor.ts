import { Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { rangeKey } from '../common/util';
import { parseVerilogExpressionTokens, VerilogExpressionAst } from './exprAst';
import { lexVerilog, VerilogToken } from './lexer';
import {
  VerilogDirective,
  VerilogInclude,
  VerilogMacro,
  VerilogMacroUse
} from './model';

import { isVerilogMacroNameToken, preprocessVerilogTokens, preprocessorDirectives, verilogDirectiveLineEnd } from './preprocessorState';
export { preprocessVerilogTokens, preprocessorDirectives, verilogDirectiveLineEnd } from './preprocessorState';
export type { VerilogPreprocessorOptions, VerilogPreprocessorResult, VerilogPreprocessorIssue } from './preprocessorState';

export function parseMacros(document: TextDocument, text: string): VerilogMacro[] {
  return parseMacrosFromTokens(document, lexVerilog(text).tokens);
}

export function parseMacrosFromTokens(document: TextDocument, tokens: VerilogToken[]): VerilogMacro[] {
  tokens = activeVerilogTokens(document.getText(), tokens);
  const macros: VerilogMacro[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!isDirective(token, 'define')) {
      continue;
    }
    const name = nextTokenOnLine(document, tokens, index + 1, token);
    if (!isVerilogMacroNameToken(name)) {
      continue;
    }
    const logicalEnd = verilogDirectiveLineEnd(document.getText(), token.end, true);
    const body = document.getText().slice(name.end, logicalEnd).replace(/\\\r?\n/g, ' ').trim();
    macros.push({
      name: name.value,
      range: Range.create(document.positionAt(token.start), document.positionAt(logicalEnd)),
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
  return parseMacroUsesFromTokens(document, macros, lexVerilog(text).tokens);
}

export function parseMacroUsesFromTokens(
  document: TextDocument,
  macros: VerilogMacro[],
  tokens: VerilogToken[]
): VerilogMacroUse[] {
  tokens = activeVerilogTokens(document.getText(), tokens);
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
  return parseIncludesFromTokens(document, lexVerilog(text).tokens);
}

export function parseIncludesFromTokens(document: TextDocument, tokens: VerilogToken[]): VerilogInclude[] {
  tokens = activeVerilogTokens(document.getText(), tokens);
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
  return parseDirectivesFromTokens(document, lexVerilog(text).tokens);
}

export function parseDirectivesFromTokens(document: TextDocument, tokens: VerilogToken[]): VerilogDirective[] {
  tokens = activeVerilogTokens(document.getText(), tokens);
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

/** Select active compilation branches without rewriting any token source position. */
export function activeVerilogTokens(text: string, tokens: VerilogToken[]): VerilogToken[] {
  return preprocessVerilogTokens(text, tokens, { collectIssues: false, followIncludes: false }).tokens;
}

/** Value-only object-macro bindings; neither expression nor invocation positions are rewritten. */
export function objectMacroExpressionsFromTokens(text: string, tokens: VerilogToken[]): Map<number, VerilogExpressionAst> {
  tokens = activeVerilogTokens(text, tokens);
  const definitions = new Map<string, VerilogToken[]>();
  const expressions = new Map<number, VerilogExpressionAst>();
  const parsedBodies = new Map<VerilogToken[], VerilogExpressionAst | undefined>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const name = directiveName(token);
    if (name === 'define') {
      const end = verilogDirectiveLineEnd(text, token.end, true);
      const identifier = tokens[index + 1];
      const bodyStart = index + 2;
      while (tokens[index + 1]?.start < end) index++;
      if (!isVerilogMacroNameToken(identifier)) continue;
      const body = tokens.slice(bodyStart, index + 1).filter((part) => part.value !== '\\');
      const functionLike = body[0]?.value === '(' && body[0].start === identifier.end;
      if (functionLike) definitions.delete(identifier.value);
      else definitions.set(identifier.value, body);
    } else if (name === 'undef') {
      definitions.delete(tokens[index + 1]?.value);
    } else if (name === 'undefineall') {
      definitions.clear();
    } else if (name && !preprocessorDirectives.has(name)) {
      const body = definitions.get(name);
      if (body && !parsedBodies.has(body)) parsedBodies.set(body, parseVerilogExpressionTokens(body));
      const expression = body && parsedBodies.get(body);
      if (expression) expressions.set(token.start, expression);
    }
  }
  return expressions;
}
