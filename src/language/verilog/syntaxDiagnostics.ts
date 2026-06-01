import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic, rangeAtOffset } from '../common/lsp';
import { VerilogModule } from './model';
import { VerilogToken } from './lexer';
import { VerilogCstDocument } from './cst';

type BlockToken = 'begin' | 'case' | 'generate' | 'function' | 'task';

interface BlockFrame {
  token: BlockToken;
  offset: number;
}

const openingDelimiters = new Set(['(', '[', '{']);
const closingToOpening = new Map<string, string>([
  [')', '('],
  [']', '['],
  ['}', '{']
]);

const declarationKeywords = new Set([
  'assign',
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'integer',
  'localparam',
  'parameter',
  'genvar',
  'real',
  'realtime',
  'time'
]);

const bodyBoundaryKeywords = new Set([
  'assign',
  'always',
  'initial',
  'begin',
  'case',
  'casex',
  'casez',
  'end',
  'endcase',
  'endmodule',
  'generate',
  'endgenerate',
  'function',
  'endfunction',
  'task',
  'endtask',
  ...declarationKeywords
]);

export function collectSyntaxDiagnostics(
  document: TextDocument,
  cst: VerilogCstDocument,
  modules: VerilogModule[],
  diagnostics: Diagnostic[]
): void {
  for (const diagnostic of cst.diagnostics) {
    diagnostics.push(makeDiagnostic(
      rangeAtOffset(document, diagnostic.start, Math.max(1, diagnostic.end - diagnostic.start)),
      diagnostic.message,
      DiagnosticSeverity.Error,
      diagnostic.code
    ));
  }

  collectMalformedModuleDiagnostics(document, cst.codeTokens, modules, diagnostics);
  collectDelimiterDiagnostics(document, cst.codeTokens, diagnostics);
  collectBlockBalanceDiagnostics(document, cst.codeTokens, diagnostics);
  collectStatementTerminatorDiagnostics(document, cst.codeTokens, modules, diagnostics);
}

function collectMalformedModuleDiagnostics(
  document: TextDocument,
  tokens: VerilogToken[],
  modules: VerilogModule[],
  diagnostics: Diagnostic[]
): void {
  const parsedModuleStarts = new Set(modules.map((module) => document.offsetAt(module.range.start)));
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'eof' || token.value !== 'module' || parsedModuleStarts.has(token.start)) {
      continue;
    }
    const name = nextNonEof(tokens, index + 1);
    if (!name || name.kind !== 'identifier') {
      diagnostics.push(makeDiagnostic(
        rangeAtOffset(document, token.start, token.value.length),
        'Syntax error: module declaration is missing a module name.',
        DiagnosticSeverity.Error,
        'syntax-module-declaration'
      ));
      continue;
    }
    if (findModuleHeaderTerminator(tokens, index) >= 0) {
      continue;
    }
    diagnostics.push(makeDiagnostic(
      rangeAtOffset(document, name.start, Math.max(1, name.end - name.start)),
      `Syntax error: malformed module declaration for '${name.value}'. Expected a semicolon after the optional port list.`,
      DiagnosticSeverity.Error,
      'syntax-module-declaration'
    ));
  }
}

function collectDelimiterDiagnostics(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const stack: VerilogToken[] = [];
  for (const token of tokens) {
    if (token.kind === 'eof') {
      break;
    }
    if (openingDelimiters.has(token.value)) {
      stack.push(token);
      continue;
    }
    const expected = closingToOpening.get(token.value);
    if (!expected) {
      continue;
    }
    const open = stack.pop();
    if (!open || open.value !== expected) {
      diagnostics.push(makeDiagnostic(
        rangeAtOffset(document, token.start, token.end - token.start),
        `Syntax error: unmatched '${token.value}'.`,
        DiagnosticSeverity.Error,
        'syntax-unmatched-delimiter'
      ));
    }
  }
  for (const open of stack) {
    diagnostics.push(makeDiagnostic(
      rangeAtOffset(document, open.start, open.end - open.start),
      `Syntax error: missing closing delimiter for '${open.value}'.`,
      DiagnosticSeverity.Error,
      'syntax-unclosed-delimiter'
    ));
  }
}

function collectBlockBalanceDiagnostics(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const stack: BlockFrame[] = [];
  for (const token of tokens) {
    if (token.kind === 'eof') {
      break;
    }
    const value = token.value;
    if (value === 'begin') {
      stack.push({ token: 'begin', offset: token.start });
      continue;
    }
    if (value === 'case' || value === 'casex' || value === 'casez') {
      stack.push({ token: 'case', offset: token.start });
      continue;
    }
    if (value === 'generate' || value === 'function' || value === 'task') {
      stack.push({ token: value, offset: token.start });
      continue;
    }

    const expected = matchingOpenBlock(value);
    if (!expected) {
      continue;
    }
    const stackIndex = findLastBlock(stack, expected);
    if (stackIndex < 0) {
      diagnostics.push(makeDiagnostic(
        rangeAtOffset(document, token.start, token.end - token.start),
        `Syntax error: '${value}' has no matching ${expected}.`,
        DiagnosticSeverity.Error,
        `syntax-unmatched-${value}`
      ));
      continue;
    }
    stack.splice(stackIndex, 1);
  }

  for (const open of stack) {
    diagnostics.push(makeDiagnostic(
      rangeAtOffset(document, open.offset, open.token.length),
      `Syntax error: '${open.token}' is missing a matching ${matchingCloseBlock(open.token)}.`,
      DiagnosticSeverity.Error,
      `syntax-unclosed-${open.token}`
    ));
  }
}

function collectStatementTerminatorDiagnostics(
  document: TextDocument,
  tokens: VerilogToken[],
  modules: VerilogModule[],
  diagnostics: Diagnostic[]
): void {
  for (const module of modules) {
    const bodyStart = document.offsetAt(module.headerEnd);
    const bodyEnd = document.offsetAt(module.endmoduleRange?.start ?? module.range.end);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.start < bodyStart || token.start >= bodyEnd || !declarationKeywords.has(token.value)) {
        continue;
      }
      if (isInsidePortDeclarationList(tokens, index)) {
        continue;
      }
      if (findStatementSemicolon(tokens, index, bodyEnd) >= 0) {
        continue;
      }
      diagnostics.push(makeDiagnostic(
        rangeAtOffset(document, token.start, token.end - token.start),
        `Syntax error: '${token.value}' statement is missing a terminating semicolon.`,
        DiagnosticSeverity.Error,
        'syntax-missing-semicolon'
      ));
    }
  }
}

function findModuleHeaderTerminator(tokens: VerilogToken[], moduleIndex: number): number {
  let index = moduleIndex + 1;
  const name = nextNonEof(tokens, index);
  if (!name || name.kind !== 'identifier') {
    return -1;
  }
  index = tokens.indexOf(name) + 1;

  if (tokens[index]?.value === '#') {
    index++;
    if (tokens[index]?.value !== '(') {
      return -1;
    }
    index = findMatchingToken(tokens, index, '(', ')');
    if (index < 0) {
      return -1;
    }
    index++;
  }

  if (tokens[index]?.value === '(') {
    index = findMatchingToken(tokens, index, '(', ')');
    if (index < 0) {
      return -1;
    }
    index++;
  }

  return tokens[index]?.value === ';' ? index : -1;
}

function findStatementSemicolon(tokens: VerilogToken[], startIndex: number, maxOffset: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = startIndex + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'eof' || token.start >= maxOffset) {
      return -1;
    }
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    }

    const topLevel = paren === 0 && bracket === 0 && brace === 0;
    if (topLevel && token.value === ';') {
      return index;
    }
    if (topLevel && index > startIndex + 1 && bodyBoundaryKeywords.has(token.value)) {
      return -1;
    }
  }
  return -1;
}

function isInsidePortDeclarationList(tokens: VerilogToken[], index: number): boolean {
  let parenDepth = 0;
  for (let current = index - 1; current >= 0; current--) {
    const token = tokens[current];
    if (token.value === ')') {
      parenDepth++;
      continue;
    }
    if (token.value === '(') {
      if (parenDepth === 0) {
        return nearestKeywordBefore(tokens, current)?.value === 'module';
      }
      parenDepth--;
      continue;
    }
    if (parenDepth === 0 && token.value === ';') {
      return false;
    }
  }
  return false;
}

function nearestKeywordBefore(tokens: VerilogToken[], index: number): VerilogToken | undefined {
  for (let current = index - 1; current >= 0; current--) {
    const token = tokens[current];
    if (token.kind === 'keyword') {
      return token;
    }
    if (token.value === ';') {
      return undefined;
    }
  }
  return undefined;
}

function findMatchingToken(tokens: VerilogToken[], openIndex: number, openValue: string, closeValue: string): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === openValue) {
      depth++;
    } else if (token.value === closeValue) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function matchingOpenBlock(value: string): BlockToken | undefined {
  if (value === 'end') {
    return 'begin';
  }
  if (value === 'endcase') {
    return 'case';
  }
  if (value === 'endgenerate') {
    return 'generate';
  }
  if (value === 'endfunction') {
    return 'function';
  }
  if (value === 'endtask') {
    return 'task';
  }
  return undefined;
}

function matchingCloseBlock(value: BlockToken): string {
  if (value === 'case') {
    return 'endcase';
  }
  if (value === 'generate') {
    return 'endgenerate';
  }
  if (value === 'function') {
    return 'endfunction';
  }
  if (value === 'task') {
    return 'endtask';
  }
  return 'end';
}

function findLastBlock(stack: BlockFrame[], token: BlockToken): number {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index].token === token) {
      return index;
    }
  }
  return -1;
}

function nextNonEof(tokens: VerilogToken[], start: number): VerilogToken | undefined {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind !== 'eof') {
      return tokens[index];
    }
  }
  return undefined;
}
