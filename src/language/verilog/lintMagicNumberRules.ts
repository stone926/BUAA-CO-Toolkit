import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings, isVerilogLintRuleEnabled } from '../common/settings';
import { VerilogCstDocument } from './cst';
import { VerilogToken } from './lexer';
import { VerilogModule } from './model';
import {
  tokenRange,
  trimStatementTokens
} from './lintUtils';

export function collectMagicNumberDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  text: string,
  module: VerilogModule,
  cst: VerilogCstDocument,
  diagnostics: Diagnostic[]
): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-004')) {
    return;
  }
  const bodyStart = document.offsetAt(module.headerEnd);
  const bodyEnd = document.offsetAt(module.range.end);
  for (const token of cst.codeTokens) {
    if (token.kind !== 'number' || token.start < bodyStart || token.start >= bodyEnd) {
      continue;
    }
    const statement = cst.statements.find((item) => token.start >= item.start && token.start < item.end);
    const statementTokens = statement ? trimStatementTokens(statement.tokens) : [];
    if (
      statementTokens.some((item) => item.value === 'parameter' || item.value === 'localparam' || item.value === '`define') ||
      isTrivialLiteralToken(token.value) ||
      isInsideBracketRangeTokens(statementTokens, token)
    ) {
      continue;
    }
    diagnostics.push(makeDiagnostic(tokenRange(document, token), 'VC-004: replace magic numbers with a descriptive localparam, parameter, or macro.', DiagnosticSeverity.Information, 'vc-004-magic-number'));
  }
}

function isTrivialLiteralToken(value: string): boolean {
  const parsed = parseVerilogLiteral(value);
  return parsed !== undefined && (parsed === 0n || parsed === 1n);
}

function isInsideBracketRangeTokens(tokens: VerilogToken[], target: VerilogToken): boolean {
  const index = tokens.indexOf(target);
  if (index < 0) {
    return false;
  }
  let left = index - 1;
  while (left >= 0 && tokens[left].value !== '[' && tokens[left].value !== ';') {
    if (tokens[left].value === ']') {
      return false;
    }
    left--;
  }
  if (tokens[left]?.value !== '[') {
    return false;
  }
  let right = index + 1;
  while (right < tokens.length && tokens[right].value !== ']' && tokens[right].value !== ';') {
    right++;
  }
  return tokens[right]?.value === ']';
}

function parseVerilogLiteral(value: string): bigint | undefined {
  const apostrophe = value.indexOf("'");
  if (apostrophe < 0) {
    return parseDecimalBigInt(value);
  }
  const sizeAndBase = value.slice(apostrophe + 1).split('_').join('');
  const baseChar = [...sizeAndBase].find((char) => {
    const lower = char.toLowerCase();
    return lower === 'b' || lower === 'o' || lower === 'd' || lower === 'h';
  });
  if (!baseChar) {
    return undefined;
  }
  const digits = sizeAndBase.slice(sizeAndBase.indexOf(baseChar) + 1);
  if (!digits || [...digits].some((char) => char === 'x' || char === 'X' || char === 'z' || char === 'Z' || char === '?')) {
    return undefined;
  }
  const radix = baseChar.toLowerCase() === 'b' ? 2 : baseChar.toLowerCase() === 'o' ? 8 : baseChar.toLowerCase() === 'd' ? 10 : 16;
  let result = 0n;
  for (const char of digits) {
    const digit = parseInt(char, radix);
    if (!Number.isInteger(digit) || digit < 0 || digit >= radix) {
      return undefined;
    }
    result = result * BigInt(radix) + BigInt(digit);
  }
  return result;
}

function parseDecimalBigInt(value: string): bigint | undefined {
  if (![...value].every((char) => char === '_' || (char >= '0' && char <= '9'))) {
    return undefined;
  }
  return BigInt(value.split('_').join(''));
}
