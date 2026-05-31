import {
  Range,
  SemanticTokens,
  SemanticTokensBuilder
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { rangesEqual } from '../common/lsp';
import { createMipsTokenRegex } from '../common/util';
import { CoSettings } from '../common/settings';
import { cp0RegisterAtPosition } from './display';
import {
  allDataSymbols,
  allEqvSymbols,
  allLabelSymbols,
  allMacroParams,
  allMacros,
  findMacroParamAtPosition,
  resolveDataSymbolAtPosition,
  resolveEqvSymbolAtPosition,
  resolveLabelAtPosition
} from './parser';
import { getCachedMipsParse } from './parseCache';
import { isKnownDeclarationRange } from './queries';
import {
  directives,
  instructions,
  instructionSemanticTokenType,
  isFloatingPointRegister,
  isRegister,
  MipsSemanticTokenType,
  mipsSemanticTokenTypes
} from './resources';
import { MipsServerState } from './state';
import {
  findCommentIndex,
  getStringRanges,
  isInsideAnyRange
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

  for (const macro of allMacros(parsed)) {
    pushSemanticToken(tokens, macro.selectionRange, 'mipsMacro', ['declaration']);
  }
  for (const param of allMacroParams(parsed)) {
    pushSemanticToken(tokens, param.selectionRange, 'mipsMacroParameter', ['declaration']);
  }
  for (const symbol of allLabelSymbols(parsed)) {
    pushSemanticToken(tokens, symbol.selectionRange, 'mipsLabel', ['declaration']);
  }
  for (const symbol of allDataSymbols(parsed)) {
    pushSemanticToken(tokens, symbol.selectionRange, 'mipsDataSymbol', ['declaration']);
  }
  for (const symbol of allEqvSymbols(parsed)) {
    pushSemanticToken(tokens, symbol.selectionRange, 'mipsEqvSymbol', ['declaration']);
  }

  const tokenRegex = createMipsTokenRegex();
  const numberRegex = /[-+]?(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|0[0-7]+|\b\d+\b)/g;
  const punctuationRegex = /[(),:]/g;
  const lines = document.getText().split('\n');
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const text = lines[lineNumber];
    const commentIndex = findCommentIndex(text);
    if (commentIndex >= 0) {
      pushSemanticToken(tokens, Range.create(lineNumber, commentIndex, lineNumber, text.length), 'mipsComment');
    }
    const code = commentIndex >= 0 ? text.slice(0, commentIndex) : text;
    const stringRanges = getStringRanges(code);
    for (const stringRange of stringRanges) {
      pushSemanticToken(tokens, Range.create(lineNumber, stringRange.start, lineNumber, stringRange.end), 'mipsString');
    }

    let numberMatch: RegExpExecArray | null;
    while ((numberMatch = numberRegex.exec(code))) {
      const previous = numberMatch.index > 0 ? code[numberMatch.index - 1] : '';
      if (!isInsideAnyRange(numberMatch.index, stringRanges) && previous !== '$') {
        pushSemanticToken(tokens, Range.create(lineNumber, numberMatch.index, lineNumber, numberMatch.index + numberMatch[0].length), 'mipsNumber');
      }
    }

    let punctuationMatch: RegExpExecArray | null;
    while ((punctuationMatch = punctuationRegex.exec(code))) {
      if (!isInsideAnyRange(punctuationMatch.index, stringRanges)) {
        pushSemanticToken(tokens, Range.create(lineNumber, punctuationMatch.index, lineNumber, punctuationMatch.index + punctuationMatch[0].length), 'mipsPunctuation');
      }
    }

    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(code))) {
      const token = match[0];
      const previous = match.index > 0 ? code[match.index - 1] : '';
      if (previous === '$' || isInsideAnyRange(match.index, stringRanges)) {
        continue;
      }

      const range = Range.create(lineNumber, match.index, lineNumber, match.index + token.length);
      if (isKnownDeclarationRange(range, parsed)) {
        continue;
      }

      if (token.startsWith('$') && cp0RegisterAtPosition(document, token, range.start)) {
        pushSemanticToken(tokens, range, 'mipsCp0Register');
      } else if (token.startsWith('$') && (isRegister(token) || isFloatingPointRegister(token))) {
        pushSemanticToken(tokens, range, 'mipsRegister');
      } else if (token.startsWith('.') && directives.has(token.toLowerCase())) {
        pushSemanticToken(tokens, range, 'mipsDirective');
      } else if (token.startsWith('%') && findMacroParamAtPosition(parsed, token, range.start)) {
        pushSemanticToken(tokens, range, 'mipsMacroParameter');
      } else if (instructions[token.toLowerCase()]) {
        const parsedInstruction = parsed.instructions.find((line) => rangesEqual(line.range, range));
        pushSemanticToken(tokens, range, instructionSemanticTokenType(instructions[token.toLowerCase()], settings, parsedInstruction?.usesPseudoForm));
      } else if (parsed.macros.has(token)) {
        pushSemanticToken(tokens, range, 'mipsMacro');
      } else if (resolveLabelAtPosition(parsed, token, range.start)) {
        pushSemanticToken(tokens, range, 'mipsLabel');
      } else if (resolveDataSymbolAtPosition(parsed, token, range.start)) {
        pushSemanticToken(tokens, range, 'mipsDataSymbol');
      } else if (resolveEqvSymbolAtPosition(parsed, token, range.start)) {
        pushSemanticToken(tokens, range, 'mipsEqvSymbol');
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
