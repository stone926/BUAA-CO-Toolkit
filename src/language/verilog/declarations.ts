import type { VerilogDeclKind } from './model';

export const verilogPortDirections = new Set(['input', 'output', 'inout']);

export const verilogNetDeclarationTypes = new Set(['wire']);

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

export function normalizeVerilogDeclKind(value: string): VerilogDeclKind {
  if (verilogNetDeclarationTypes.has(value)) {
    return 'wire';
  }
  return value as VerilogDeclKind;
}
