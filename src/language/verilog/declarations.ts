import { VerilogToken } from './lexer';
import type { VerilogDeclKind } from './model';
import { findMatchingTokenForward } from './tokenUtils';

export const verilogPortDirections = new Set(['input', 'output', 'inout']);

export const verilogNetDeclarationTypes = new Set([
  'wire',
  'tri',
  'tri0',
  'tri1',
  'triand',
  'trior',
  'trireg',
  'wand',
  'wor',
  'supply0',
  'supply1'
]);

export const verilogVariableDeclarationTypes = new Set([
  'reg',
  'logic',
  'integer',
  'real',
  'realtime',
  'time',
  'genvar'
]);

export const verilogParameterDeclarationTypes = new Set(['parameter', 'localparam']);
export const verilogParameterTypeKeywords = new Set(['integer', 'real', 'realtime', 'time']);

export const verilogDeclarationKeywords = new Set([
  ...verilogPortDirections,
  ...verilogNetDeclarationTypes,
  ...verilogVariableDeclarationTypes,
  ...verilogParameterDeclarationTypes
]);

export const verilogPortDeclarationTypes = new Set([
  ...verilogNetDeclarationTypes,
  'reg',
  'logic'
]);

export const verilogExplicitPortNetTypes = new Set([
  ...verilogNetDeclarationTypes,
  'reg',
  'logic',
  'integer',
  'time',
  'real',
  'realtime'
]);

export const verilogDeclarationModifiers = new Set([
  'automatic',
  'signed',
  'unsigned',
  'scalared',
  'vectored'
]);

export const verilogDeclarationPrefixKeywords = new Set([
  ...verilogDeclarationKeywords,
  ...verilogPortDeclarationTypes,
  ...verilogParameterTypeKeywords,
  ...verilogDeclarationModifiers
]);

const verilogStrengthKeywords = new Set([
  'supply0',
  'supply1',
  'strong0',
  'strong1',
  'pull0',
  'pull1',
  'weak0',
  'weak1',
  'highz0',
  'highz1',
  'small',
  'medium',
  'large'
]);

export function normalizeVerilogDeclKind(value: string): VerilogDeclKind {
  if (verilogNetDeclarationTypes.has(value)) {
    return 'wire';
  }
  return value as VerilogDeclKind;
}

export function skipVerilogStrengthGroup(tokens: VerilogToken[], index: number): number {
  if (!isVerilogStrengthGroup(tokens, index)) {
    return index;
  }
  const close = findMatchingTokenForward(tokens, index, '(', ')');
  return close >= 0 ? close + 1 : index;
}

export function isVerilogStrengthGroup(tokens: VerilogToken[], index: number): boolean {
  if (tokens[index]?.value !== '(') {
    return false;
  }
  const close = findMatchingTokenForward(tokens, index, '(', ')');
  if (close < 0) {
    return false;
  }
  const strengths = tokens
    .slice(index + 1, close)
    .filter((token) => token.value !== ',');
  return strengths.length >= 1 &&
    strengths.length <= 2 &&
    strengths.every((token) => verilogStrengthKeywords.has(token.value));
}
