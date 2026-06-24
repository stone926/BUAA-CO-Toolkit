import {
  Range,
  SemanticTokens,
  SemanticTokensBuilder
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentResultCache } from '../common/documentResultCache';
import { CoSettings } from '../common/settings';
import { rangeKey } from '../common/util';
import { cp0RegisterAtPosition } from './display';
import { getCachedMipsParse } from './parseCache';
import type { MipsAstLine, MipsExecutableAst, MipsOperandAst, MipsStatementAst } from './ast';
import { getNumericLikeRanges, isCharLiteral } from './literals';
import { collectMipsOperandReferences } from './operandReferences';
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

interface MipsSemanticTokenCandidate {
  range: Range;
  tokenType: MipsSemanticTokenType;
  modifiers?: string[];
}

const tokenTypeIndex = new Map(mipsSemanticTokenTypes.map((type, index) => [type, index] as const));
const tokenModifierIndex = new Map<string, number>([['declaration', 0]]);
const semanticTokenCache = new DocumentResultCache<SemanticTokens>();

export function getMipsSemanticTokens(document: TextDocument, settings: CoSettings, state: MipsServerState): SemanticTokens {
  return semanticTokenCache.getOrCreate(
    document,
    `mips-semantic:${settings.mips.instructionColorMode}`,
    () => buildMipsSemanticTokens(document, settings, state)
  );
}

function buildMipsSemanticTokens(document: TextDocument, settings: CoSettings, state: MipsServerState): SemanticTokens {
  const parsed = getCachedMipsParse(document, settings, state);
  const tokens: MipsSemanticTokenCandidate[] = [];
  const builder = new SemanticTokensBuilder();
  const semanticReferences = new Map(parsed.semantic.references.map((reference) => [rangeKey(reference.range), reference]));
  const instructionByRange = new Map(parsed.instructions.map((line) => [rangeKey(line.range), line]));

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
    pushAstLineSemanticTokens(tokens, line, parsed, settings, semanticReferences, instructionByRange);
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

function pushAstLineSemanticTokens(
  tokens: MipsSemanticTokenCandidate[],
  line: MipsAstLine,
  parsed: ReturnType<typeof getCachedMipsParse>,
  settings: CoSettings,
  semanticReferences: Map<string, { kind: MipsSemanticReferenceKind }>,
  instructionByRange: Map<string, { usesPseudoForm: boolean }>
): void {
  if (line.kind === 'commentLine') {
    pushSemanticToken(tokens, line.comment.range, 'mipsComment');
    return;
  }
  if (line.kind !== 'statement') {
    return;
  }
  for (const label of line.labels) {
    pushSemanticToken(tokens, label.colonRange, 'mipsPunctuation');
  }
  if (line.comment) {
    pushSemanticToken(tokens, line.comment.range, 'mipsComment');
  }
  const executable = line.executable;
  if (!executable) {
    return;
  }
  pushNamedSemanticToken(tokens, parsed, settings, semanticReferences, instructionByRange, executable.mnemonic, executable.mnemonicRange);
  pushOperandPunctuationTokens(tokens, line, executable);
  for (const operand of executable.operands) {
    pushOperandSemanticTokens(tokens, operand, parsed, semanticReferences);
  }
}

function pushOperandSemanticTokens(
  tokens: MipsSemanticTokenCandidate[],
  operand: MipsOperandAst,
  parsed: ReturnType<typeof getCachedMipsParse>,
  semanticReferences: Map<string, { kind: MipsSemanticReferenceKind }>
): void {
  if (parsed.semantic.declarationRangeKeys.has(rangeKey(operand.range))) {
    return;
  }
  switch (operand.kind) {
    case 'memory':
      pushOperandSemanticTokens(tokens, operand.offset, parsed, semanticReferences);
      pushOperandSemanticTokens(tokens, operand.base, parsed, semanticReferences);
      return;
    case 'string':
      pushSemanticToken(tokens, operand.range, 'mipsString');
      return;
    case 'integer':
    case 'float':
      pushSemanticToken(tokens, operand.range, 'mipsNumber');
      return;
    case 'register':
      pushRegisterSemanticToken(tokens, parsed, operand.text, operand.range);
      return;
    case 'macroParameter':
    case 'symbol':
      pushReferenceSemanticToken(tokens, semanticReferences, operand.text, operand.range);
      return;
    case 'expression':
      pushExpressionSemanticTokens(tokens, operand, parsed, semanticReferences);
      return;
  }
}

function pushExpressionSemanticTokens(
  tokens: MipsSemanticTokenCandidate[],
  operand: MipsOperandAst,
  parsed: ReturnType<typeof getCachedMipsParse>,
  semanticReferences: Map<string, { kind: MipsSemanticReferenceKind }>
): void {
  for (const reference of collectMipsOperandReferences(operand, { includeRegisters: true })) {
    if (parsed.semantic.declarationRangeKeys.has(rangeKey(reference.range))) {
      continue;
    }
    if (reference.text.startsWith('$') && (isRegister(reference.text) || isFloatingPointRegister(reference.text))) {
      pushRegisterSemanticToken(tokens, parsed, reference.text, reference.range);
    } else {
      pushReferenceSemanticToken(tokens, semanticReferences, reference.text, reference.range);
    }
  }

  const quotedRanges = quotedLiteralRanges(operand.text, '"');
  const charRanges = quotedLiteralRanges(operand.text, '\'');
  for (const charRange of charRanges) {
    if (isCharLiteral(operand.text.slice(charRange.start, charRange.end))) {
      pushSemanticToken(tokens, relativeRange(operand.range, charRange), 'mipsNumber');
    }
  }

  const ignoredRanges = [...quotedRanges, ...charRanges];
  for (const numericRange of getNumericLikeRanges(operand.text)) {
    if (!ignoredRanges.some((range) => textSpansOverlap(range, numericRange))) {
      pushSemanticToken(tokens, relativeRange(operand.range, numericRange), 'mipsNumber');
    }
  }
}

function pushNamedSemanticToken(
  tokens: MipsSemanticTokenCandidate[],
  parsed: ReturnType<typeof getCachedMipsParse>,
  settings: CoSettings,
  semanticReferences: Map<string, { kind: MipsSemanticReferenceKind }>,
  instructionByRange: Map<string, { usesPseudoForm: boolean }>,
  text: string,
  range: Range
): void {
  const key = rangeKey(range);
  if (parsed.semantic.declarationRangeKeys.has(key)) {
    return;
  }
  const reference = semanticReferences.get(key);
  const tokenType = reference ? semanticReferenceTokenType(reference.kind) : undefined;
  if (tokenType) {
    pushSemanticToken(tokens, range, tokenType);
    return;
  }
  if (text.startsWith('.') && directives.has(text.toLowerCase())) {
    pushSemanticToken(tokens, range, 'mipsDirective');
    return;
  }
  const instruction = instructions[text.toLowerCase()];
  if (instruction) {
    const parsedInstruction = instructionByRange.get(key);
    pushSemanticToken(tokens, range, instructionSemanticTokenType(instruction, settings, parsedInstruction?.usesPseudoForm));
  }
}

function pushReferenceSemanticToken(
  tokens: MipsSemanticTokenCandidate[],
  semanticReferences: Map<string, { kind: MipsSemanticReferenceKind }>,
  text: string,
  range: Range
): void {
  const reference = semanticReferences.get(rangeKey(range));
  const tokenType = reference ? semanticReferenceTokenType(reference.kind) : undefined;
  if (tokenType) {
    pushSemanticToken(tokens, range, tokenType);
  } else if (text.startsWith('.') && directives.has(text.toLowerCase())) {
    pushSemanticToken(tokens, range, 'mipsDirective');
  } else if (instructions[text.toLowerCase()]) {
    pushSemanticToken(tokens, range, 'mipsInstruction');
  }
}

function pushRegisterSemanticToken(tokens: MipsSemanticTokenCandidate[], parsed: ReturnType<typeof getCachedMipsParse>, text: string, range: Range): void {
  if (text.startsWith('$') && cp0RegisterAtPosition(parsed, text, range.start)) {
    pushSemanticToken(tokens, range, 'mipsCp0Register');
  } else if (text.startsWith('$') && (isRegister(text) || isFloatingPointRegister(text))) {
    pushSemanticToken(tokens, range, 'mipsRegister');
  }
}

function pushOperandPunctuationTokens(tokens: MipsSemanticTokenCandidate[], line: MipsStatementAst, executable: MipsExecutableAst): void {
  const operandRange = executable.operandRange;
  if (!operandRange) {
    return;
  }
  let quote: '"' | '\'' | undefined;
  let escaped = false;
  for (let character = operandRange.start.character; character < operandRange.end.character; character++) {
    const char = line.text[character];
    if (quote) {
      if (char === quote && !escaped) {
        quote = undefined;
        escaped = false;
      } else if (char !== '\\') {
        escaped = false;
      } else {
        escaped = !escaped;
      }
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      escaped = false;
      continue;
    }
    if (char === ',' || char === '(' || char === ')' || char === ':') {
      pushSemanticToken(tokens, Range.create(line.line, character, line.line, character + 1), 'mipsPunctuation');
    }
  }
}

function relativeRange(base: Range, span: { start: number; end: number }): Range {
  return Range.create(
    base.start.line,
    base.start.character + span.start,
    base.start.line,
    base.start.character + span.end
  );
}

function quotedLiteralRanges(text: string, quote: '"' | '\''): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start: number | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start === undefined) {
      if (char === quote) {
        start = index;
        escaped = false;
      }
      continue;
    }
    if (char === quote && !escaped) {
      ranges.push({ start, end: index + 1 });
      start = undefined;
      escaped = false;
      continue;
    }
    escaped = char === '\\' && !escaped;
    if (char !== '\\') {
      escaped = false;
    }
  }
  if (start !== undefined) {
    ranges.push({ start, end: text.length });
  }
  return ranges;
}

function textSpansOverlap(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start < right.end && right.start < left.end;
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
