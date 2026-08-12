import { verilogKeywords, verilogLanguageCatalog } from './model';

export type VerilogTokenKind =
  | 'identifier'
  | 'keyword'
  | 'number'
  | 'string'
  | 'comment'
  | 'systemIdentifier'
  | 'directive'
  | 'operator'
  | 'punctuation'
  | 'unknown'
  | 'eof';

export interface VerilogToken {
  kind: VerilogTokenKind;
  value: string;
  start: number;
  end: number;
}

export interface VerilogLexDiagnostic {
  start: number;
  end: number;
  message: string;
  code: string;
}

export interface VerilogLexResult {
  tokens: VerilogToken[];
  diagnostics: VerilogLexDiagnostic[];
}

const punctuation = new Set(['(', ')', '[', ']', '{', '}', ';', ',', '.', '#', '@']);
const operatorsByLength = buildOperatorsByLength();
const operatorLengths = [...operatorsByLength.keys()].filter((length) => length > 1).sort((left, right) => right - left);
const singleOperators = operatorsByLength.get(1) ?? new Set<string>();

export function lexVerilog(text: string): VerilogLexResult {
  const scanned = scanVerilog(text, false);
  return {
    tokens: scanned.tokens,
    diagnostics: scanned.diagnostics
  };
}

export function lexVerilogWithTrivia(text: string): VerilogLexResult {
  return scanVerilog(text, true);
}

export function lexVerilogCst(text: string): VerilogLexResult {
  return lexVerilogWithTrivia(text);
}

function scanVerilog(text: string, includeComments: boolean): VerilogLexResult {
  const tokens: VerilogToken[] = [];
  const diagnostics: VerilogLexDiagnostic[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (/\s/.test(char)) {
      index++;
      continue;
    }

    if (char === '/' && text[index + 1] === '/') {
      const end = skipLineComment(text, index + 2);
      if (includeComments) {
        tokens.push({ kind: 'comment', value: text.slice(index, end), start: index, end });
      }
      index = end;
      continue;
    }

    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) {
        if (includeComments) {
          tokens.push({ kind: 'comment', value: text.slice(index), start: index, end: text.length });
        }
        diagnostics.push({
          start: index,
          end: text.length,
          message: 'Syntax error: block comment is missing closing */.',
          code: 'syntax-unclosed-comment'
        });
        break;
      }
      if (includeComments) {
        tokens.push({ kind: 'comment', value: text.slice(index, end + 2), start: index, end: end + 2 });
      }
      index = end + 2;
      continue;
    }

    if (char === '"') {
      const token = readString(text, index, diagnostics);
      tokens.push(token);
      index = token.end;
      continue;
    }

    if (char === '`') {
      const directive = readDirective(text, index);
      tokens.push(directive);
      index = directive.end;
      continue;
    }

    if (char === '$') {
      const systemIdentifier = readSystemIdentifier(text, index);
      tokens.push(systemIdentifier);
      index = systemIdentifier.end;
      continue;
    }

    if (char === '\\') {
      const escapedIdentifier = readEscapedIdentifier(text, index);
      tokens.push(escapedIdentifier);
      index = escapedIdentifier.end;
      continue;
    }

    if (isNumberStart(text, index)) {
      const number = readNumber(text, index);
      tokens.push(number);
      index = number.end;
      continue;
    }

    if (isIdentifierStart(char)) {
      const identifier = readIdentifierToken(text, index);
      tokens.push(identifier);
      index = identifier.end;
      continue;
    }

    const operator = readCompoundOperator(text, index);
    if (operator) {
      tokens.push({ kind: 'operator', value: operator, start: index, end: index + operator.length });
      index += operator.length;
      continue;
    }

    if (punctuation.has(char)) {
      tokens.push({ kind: 'punctuation', value: char, start: index, end: index + 1 });
      index++;
      continue;
    }

    if (singleOperators.has(char)) {
      tokens.push({ kind: 'operator', value: char, start: index, end: index + 1 });
      index++;
      continue;
    }

    tokens.push({ kind: 'unknown', value: char, start: index, end: index + 1 });
    diagnostics.push({
      start: index,
      end: index + 1,
      message: `Syntax error: unexpected character '${char}'.`,
      code: 'syntax-unexpected-character'
    });
    index++;
  }

  tokens.push({ kind: 'eof', value: '<eof>', start: text.length, end: text.length });
  return { tokens, diagnostics };
}

function skipLineComment(text: string, index: number): number {
  const newline = text.indexOf('\n', index);
  return newline < 0 ? text.length : newline + 1;
}

function readString(text: string, start: number, diagnostics: VerilogLexDiagnostic[]): VerilogToken {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      if (text[index + 1] === '\r' && text[index + 2] === '\n') {
        index += 3;
      } else {
        // Includes ordinary escapes and a backslash + LF/CR continuation.
        index = Math.min(index + 2, text.length);
      }
      continue;
    }
    if (char === '\n' || char === '\r') {
      diagnostics.push({
        start,
        end: index,
        message: 'Syntax error: string literal is missing a closing quote.',
        code: 'syntax-unclosed-string'
      });
      return { kind: 'string', value: text.slice(start, index), start, end: index };
    }
    if (char === '"') {
      return { kind: 'string', value: text.slice(start, index + 1), start, end: index + 1 };
    }
    index++;
  }
  diagnostics.push({
    start,
    end: text.length,
    message: 'Syntax error: string literal is missing a closing quote.',
    code: 'syntax-unclosed-string'
  });
  return { kind: 'string', value: text.slice(start), start, end: text.length };
}

function readDirective(text: string, start: number): VerilogToken {
  let index = start + 1;
  while (index < text.length && isIdentifierPart(text[index])) {
    index++;
  }
  return { kind: 'directive', value: text.slice(start, index), start, end: index };
}

function readSystemIdentifier(text: string, start: number): VerilogToken {
  let index = start + 1;
  while (index < text.length && isIdentifierPart(text[index])) {
    index++;
  }
  return { kind: 'systemIdentifier', value: text.slice(start, index), start, end: index };
}

function readEscapedIdentifier(text: string, start: number): VerilogToken {
  let index = start + 1;
  while (index < text.length && !/\s/.test(text[index])) {
    index++;
  }
  return { kind: 'identifier', value: text.slice(start, index), start, end: index };
}

function isNumberStart(text: string, index: number): boolean {
  const char = text[index];
  if (/\d/.test(char)) {
    return true;
  }
  return char === '\'' && /[sSbBoOdDhH]/.test(text[index + 1] ?? '');
}

function readNumber(text: string, start: number): VerilogToken {
  let index = start;
  while (index < text.length && /[0-9_]/.test(text[index])) {
    index++;
  }
  if (text[index] === '\'') {
    index++;
    if (/[sS]/.test(text[index] ?? '')) {
      index++;
    }
    if (/[bBoOdDhH]/.test(text[index] ?? '')) {
      index++;
    }
    while (index < text.length && /[0-9a-fA-F_xXzZ?]/.test(text[index])) {
      index++;
    }
  }
  return { kind: 'number', value: text.slice(start, index), start, end: index };
}

function readIdentifierToken(text: string, start: number): VerilogToken {
  let index = start + 1;
  while (index < text.length && isIdentifierPart(text[index])) {
    index++;
  }
  const value = text.slice(start, index);
  return {
    kind: verilogKeywords.has(value) ? 'keyword' : 'identifier',
    value,
    start,
    end: index
  };
}

export function isIdentifierLike(kind: VerilogTokenKind): boolean {
  return kind === 'identifier' || kind === 'keyword' || kind === 'directive';
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function buildOperatorsByLength(): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  for (const operator of Object.values(verilogLanguageCatalog.operators).flat()) {
    if (punctuation.has(operator)) {
      continue;
    }
    const operators = result.get(operator.length) ?? new Set<string>();
    operators.add(operator);
    result.set(operator.length, operators);
  }
  return result;
}

function readCompoundOperator(text: string, start: number): string | undefined {
  for (const length of operatorLengths) {
    const candidate = text.slice(start, start + length);
    if (operatorsByLength.get(length)?.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
