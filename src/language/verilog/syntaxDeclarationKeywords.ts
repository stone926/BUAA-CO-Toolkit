import { VerilogToken } from './lexer';

export const declarationKeywords = new Set([
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'integer',
  'real',
  'realtime',
  'time',
  'parameter',
  'localparam',
  'genvar'
]);

export const portDirectionKeywords = new Set(['input', 'output', 'inout']);
const portDeclarationTypes = new Set(['wire', 'reg', 'logic']);
const parameterDeclarationTypes = new Set(['integer', 'real', 'realtime', 'time']);

export const declarationModifiers = new Set([
  'automatic',
  'signed',
  'unsigned',
  'scalared',
  'vectored'
]);

export const declarationPrefixKeywords = new Set([
  ...declarationKeywords,
  ...portDirectionKeywords,
  ...portDeclarationTypes,
  ...parameterDeclarationTypes,
  ...declarationModifiers
]);

export function isAllowedDeclarationType(firstKeyword: string, value: string): boolean {
  if (portDirectionKeywords.has(firstKeyword)) {
    return portDeclarationTypes.has(value);
  }
  if (firstKeyword === 'parameter' || firstKeyword === 'localparam') {
    return parameterDeclarationTypes.has(value);
  }
  return false;
}

export function firstIdentifierIndex(tokens: VerilogToken[], start: number): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind === 'identifier') {
      return index;
    }
  }
  return -1;
}
