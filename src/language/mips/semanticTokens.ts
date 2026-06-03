import {
  Range,
  SemanticTokens,
  SemanticTokensBuilder
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { rangesEqual } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { rangeKey } from '../common/util';
import { cp0RegisterAtPosition } from './display';
import { getCachedMipsParse } from './parseCache';
import {
  directives,
  instructions,
  instructionSemanticTokenType,
  isFloatingPointRegister,
  isRegister,
  MipsSemanticTokenType,
  mipsSemanticTokenTypes
} from './resources';
import { MipsSemanticReferenceKind } from './semantic';
import { MipsServerState } from './state';
import {
  mipsCstTokenRange
} from './syntax';

interface MipsSemanticTokenCandidate {
  range: Range;
  tokenType: MipsSemanticTokenType;
  modifiers?: string[];
}

const tokenTypeIndex = new Map(mipsSemanticTokenTypes.map((type, index) => [type, index] as const));
const tokenModifierIndex = new Map<string, number>([['declaration', 0]]);

export function getMipsSemanticTokens(document: TextDocument, settings: CoSettings, state: MipsServerState): SemanticTokens {
  const parsed = getCachedMipsParse(document, settings, state);
  const tokens: MipsSemanticTokenCandidate[] = [];
  const builder = new SemanticTokensBuilder();
  const semanticReferences = new Map(parsed.semantic.references.map((reference) => [rangeKey(reference.range), reference]));

  for (const declaration of parsed.semantic.declarations) {
    const tokenType = declaration.macro
      ? 'mipsMacro'
      : declaration.symbol
        ? semanticSymbolTokenType(declaration.symbol.kind)
        : undefined;
    if (tokenType) {
      pushSemanticToken(tokens, declaration.selectionRange, tokenType, ['declaration']);
    }
  }

  for (const line of parsed.ast.lines) {
    for (const cstToken of line.tokens) {
      const token = cstToken.value;
      const range = mipsCstTokenRange(cstToken);
      if (cstToken.kind === 'comment') {
        pushSemanticToken(tokens, range, 'mipsComment');
        continue;
      }
      if (cstToken.kind === 'string') {
        pushSemanticToken(tokens, range, 'mipsString');
        continue;
      }
      if (cstToken.kind === 'number') {
        pushSemanticToken(tokens, range, 'mipsNumber');
        continue;
      }
      if (cstToken.kind === 'punctuation') {
        pushSemanticToken(tokens, range, 'mipsPunctuation');
        continue;
      }
      if (cstToken.kind !== 'identifier' && cstToken.kind !== 'directive' && cstToken.kind !== 'register' && cstToken.kind !== 'macroParameter') {
        continue;
      }
      if (parsed.semantic.declarationRangeKeys.has(rangeKey(range))) {
        continue;
      }

      if (token.startsWith('$') && cp0RegisterAtPosition(parsed, token, range.start)) {
        pushSemanticToken(tokens, range, 'mipsCp0Register');
      } else if (token.startsWith('$') && (isRegister(token) || isFloatingPointRegister(token))) {
        pushSemanticToken(tokens, range, 'mipsRegister');
      } else if (token.startsWith('.') && directives.has(token.toLowerCase())) {
        pushSemanticToken(tokens, range, 'mipsDirective');
      } else if (instructions[token.toLowerCase()]) {
        const parsedInstruction = parsed.instructions.find((line) => rangesEqual(line.range, range));
        pushSemanticToken(tokens, range, instructionSemanticTokenType(instructions[token.toLowerCase()], settings, parsedInstruction?.usesPseudoForm));
      } else {
        const reference = semanticReferences.get(rangeKey(range));
        const tokenType = reference ? semanticReferenceTokenType(reference.kind) : undefined;
        if (tokenType) {
          pushSemanticToken(tokens, range, tokenType);
        }
      }
    }
  }

  tokens.sort(compareSemanticTokens);
  for (const token of tokens) {
    const type = tokenTypeIndex.get(token.tokenType);
    if (type === undefined) {
      continue;
    }
    builder.push(
      token.range.start.line,
      token.range.start.character,
      token.range.end.character - token.range.start.character,
      type,
      tokenModifierBitset(token.modifiers)
    );
  }
  return builder.build();
}

function semanticSymbolTokenType(kind: string): MipsSemanticTokenType | undefined {
  switch (kind) {
    case 'label':
      return 'mipsLabel';
    case 'data':
      return 'mipsDataSymbol';
    case 'eqv':
      return 'mipsEqvSymbol';
    case 'macroParam':
      return 'mipsMacroParameter';
    default:
      return undefined;
  }
}

function semanticReferenceTokenType(kind: MipsSemanticReferenceKind): MipsSemanticTokenType | undefined {
  switch (kind) {
    case 'label':
      return 'mipsLabel';
    case 'data':
      return 'mipsDataSymbol';
    case 'eqv':
      return 'mipsEqvSymbol';
    case 'macro':
      return 'mipsMacro';
    case 'macroParam':
      return 'mipsMacroParameter';
    default:
      return undefined;
  }
}

function pushSemanticToken(
  tokens: MipsSemanticTokenCandidate[],
  range: Range,
  tokenType: MipsSemanticTokenType,
  modifiers?: string[]
): void {
  if (range.start.line === range.end.line && range.start.character === range.end.character) {
    return;
  }
  tokens.push({
    range,
    tokenType,
    modifiers
  });
}

function compareSemanticTokens(left: MipsSemanticTokenCandidate, right: MipsSemanticTokenCandidate): number {
  if (left.range.start.line !== right.range.start.line) {
    return left.range.start.line - right.range.start.line;
  }
  if (left.range.start.character !== right.range.start.character) {
    return left.range.start.character - right.range.start.character;
  }
  return left.range.end.character - right.range.end.character;
}

function tokenModifierBitset(modifiers?: string[]): number {
  if (!modifiers?.length) {
    return 0;
  }
  let bitset = 0;
  for (const modifier of modifiers) {
    const index = tokenModifierIndex.get(modifier);
    if (index !== undefined) {
      bitset |= 1 << index;
    }
  }
  return bitset;
}
