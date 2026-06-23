import {
  Range,
  SemanticTokens,
  SemanticTokensBuilder
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentResultCache } from '../common/documentResultCache';
import { CoSettings, defaultCoSettings } from '../common/settings';
import { rangeKey } from '../common/util';
import { mipsSemanticTokenTypes } from '../mips/resources';
import {
  systemTasks,
  VerilogSemanticTokenType,
  verilogKeywords,
  verilogSemanticTokenTypes
} from './model';
import { getCachedVerilogParse } from './parseCache';
import { VerilogSemanticReference, VerilogSemanticSymbol } from './semanticModel';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { verilogTokenRange } from './cst';

interface SemanticTokenCandidate {
  range: Range;
  tokenType: VerilogSemanticTokenType;
  modifiers?: string[];
}

const verilogTokenTypeIndex = new Map(verilogSemanticTokenTypes.map((type, index) => [type, mipsSemanticTokenTypes.length + index] as const));
const tokenModifierIndex = new Map<string, number>([['declaration', 0]]);
const semanticTokenCache = new DocumentResultCache<SemanticTokens>();

export function getVerilogSemanticTokens(document: TextDocument, _settings: CoSettings, index: VerilogWorkspaceIndex): SemanticTokens {
  return semanticTokenCache.getOrCreate(
    document,
    `verilog-semantic:${index.version}`,
    () => buildVerilogSemanticTokens(document, index)
  );
}

function buildVerilogSemanticTokens(document: TextDocument, index: VerilogWorkspaceIndex): SemanticTokens {
  const parsed = getCachedVerilogParse(document, defaultCoSettings, false);
  const tokens: SemanticTokenCandidate[] = [];
  const pushed = new Set<string>();
  const builder = new SemanticTokensBuilder();
  const context: VerilogSemanticTokenContext = {
    index,
    portConnectionTypes: new Map()
  };

  for (const symbol of parsed.semantic.symbols) {
    const tokenType = semanticSymbolTokenType(symbol);
    if (tokenType) {
      pushSemanticToken(tokens, pushed, symbol.selectionRange, tokenType, ['declaration']);
    }
  }
  for (const reference of parsed.semantic.references) {
    const tokenType = semanticReferenceTokenType(reference, context);
    if (tokenType) {
      pushSemanticToken(tokens, pushed, reference.macroUse?.range ?? reference.range, tokenType);
    }
  }

  for (const tokenNode of parsed.cst.tokens) {
    if (tokenNode.kind === 'eof') {
      continue;
    }
    const range = verilogTokenRange(document, tokenNode);
    const token = tokenNode.value;
    if (tokenNode.kind === 'comment') {
      pushTokenText(tokens, pushed, range, token, 'verilogComment');
      continue;
    }
    if (tokenNode.kind === 'string') {
      pushStringTokenParts(tokens, pushed, range, token);
      continue;
    }
    if (tokenNode.kind === 'number') {
      pushSemanticToken(tokens, pushed, range, 'verilogNumber');
      continue;
    }
    if (tokenNode.kind === 'systemIdentifier') {
      const name = token.startsWith('$') ? token.slice(1) : token;
      if (systemTasks.has(name)) {
        pushSemanticToken(tokens, pushed, range, 'verilogSystemTask');
      }
      continue;
    }
    if (tokenNode.kind === 'directive') {
      pushSemanticToken(tokens, pushed, range, 'verilogMacro');
      continue;
    }
    if (tokenNode.kind === 'keyword') {
      pushSemanticToken(tokens, pushed, range, 'verilogKeyword');
      continue;
    }
    if (tokenNode.kind === 'punctuation' || tokenNode.kind === 'operator') {
      pushSemanticToken(tokens, pushed, range, 'verilogPunctuation');
      continue;
    }
    if (tokenNode.kind !== 'identifier') {
      continue;
    }
    if (pushed.has(rangeKey(range))) {
      continue;
    }
    if (verilogKeywords.has(token)) {
      pushSemanticToken(tokens, pushed, range, 'verilogKeyword');
      continue;
    }
  }

  tokens.sort(compareSemanticTokens);
  for (const token of tokens) {
    const type = verilogTokenTypeIndex.get(token.tokenType);
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

interface VerilogSemanticTokenContext {
  index: VerilogWorkspaceIndex;
  portConnectionTypes: Map<string, VerilogSemanticTokenType | undefined>;
}

function semanticSymbolTokenType(symbol: VerilogSemanticSymbol): VerilogSemanticTokenType | undefined {
  switch (symbol.kind) {
    case 'module':
      return 'verilogModule';
    case 'port':
      return 'verilogPort';
    case 'signal':
      return 'verilogSignal';
    case 'parameter':
      return 'verilogParameter';
    case 'instance':
      return 'verilogInstance';
    case 'macro':
      return 'verilogMacro';
    default:
      return undefined;
  }
}

function semanticReferenceTokenType(reference: VerilogSemanticReference, context: VerilogSemanticTokenContext): VerilogSemanticTokenType | undefined {
  if (reference.kind === 'portConnection') {
    if (!reference.instance) {
      return 'verilogSignal';
    }
    const cacheKey = `${reference.instance.moduleName}\u0000${reference.name}`;
    if (context.portConnectionTypes.has(cacheKey)) {
      return context.portConnectionTypes.get(cacheKey);
    }
    const targetModule = context.index.getModule(reference.instance.moduleName);
    const target = targetModule?.ports.find((port) => port.name === reference.name)
      ?? targetModule?.parameters.find((param) => param.name === reference.name);
    const tokenType = target?.kind === 'parameter' || target?.kind === 'localparam'
      ? 'verilogParameter'
      : target ? 'verilogPort' : 'verilogSignal';
    context.portConnectionTypes.set(cacheKey, tokenType);
    return tokenType;
  }
  if (reference.kind === 'macro') {
    return 'verilogMacro';
  }
  if (reference.kind === 'module') {
    return 'verilogModule';
  }
  if (reference.symbol) {
    return semanticSymbolTokenType(reference.symbol);
  }
  return undefined;
}

function pushTokenText(
  tokens: SemanticTokenCandidate[],
  pushed: Set<string>,
  range: Range,
  text: string,
  tokenType: VerilogSemanticTokenType
): void {
  let line = range.start.line;
  let character = range.start.character;
  let segmentStart = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text[index] !== '\n') {
      continue;
    }
    const rawSegment = text.slice(segmentStart, index);
    const segment = rawSegment.endsWith('\r') ? rawSegment.slice(0, -1) : rawSegment;
    if (segment.length > 0) {
      pushSemanticToken(tokens, pushed, Range.create(line, character, line, character + segment.length), tokenType);
    }
    line++;
    character = 0;
    segmentStart = index + 1;
  }
}

function pushStringTokenParts(
  tokens: SemanticTokenCandidate[],
  pushed: Set<string>,
  range: Range,
  text: string
): void {
  let segmentStart = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '%') {
      index++;
      continue;
    }
    const formatEnd = readFormatSpecifierEnd(text, index);
    if (formatEnd === undefined) {
      index++;
      continue;
    }
    if (index > segmentStart) {
      pushSemanticToken(tokens, pushed, offsetRange(range, segmentStart, index), 'verilogString');
    }
    pushSemanticToken(tokens, pushed, offsetRange(range, index, formatEnd), 'verilogFormatSpecifier');
    index = formatEnd;
    segmentStart = formatEnd;
  }
  if (segmentStart < text.length) {
    pushSemanticToken(tokens, pushed, offsetRange(range, segmentStart, text.length), 'verilogString');
  }
}

function readFormatSpecifierEnd(text: string, start: number): number | undefined {
  let index = start + 1;
  if (index >= text.length) {
    return undefined;
  }
  if (text[index] === '%') {
    return index + 1;
  }
  while (index < text.length && isFormatFlag(text[index])) {
    index++;
  }
  if (text[index] === '*') {
    index++;
  } else {
    while (index < text.length && isAsciiDigit(text[index])) {
      index++;
    }
  }
  if (text[index] === '.') {
    index++;
    while (index < text.length && isAsciiDigit(text[index])) {
      index++;
    }
  }
  const lengthStart = index;
  while (index < text.length && isFormatLengthModifier(text[index])) {
    index++;
  }
  if (index > lengthStart && index < text.length && isFormatConversion(text[index])) {
    return index + 1;
  }
  index = lengthStart;
  return index < text.length && isFormatConversion(text[index]) ? index + 1 : undefined;
}

function offsetRange(range: Range, start: number, end: number): Range {
  return Range.create(
    range.start.line,
    range.start.character + start,
    range.start.line,
    range.start.character + end
  );
}

function isFormatFlag(char: string): boolean {
  return char === '-' || char === '+' || char === '0' || char === '#' || char === ' ';
}

function isFormatLengthModifier(char: string): boolean {
  const lower = char.toLowerCase();
  return lower === 'h' || lower === 'l' || lower === 'm';
}

function isFormatConversion(char: string): boolean {
  const lower = char.toLowerCase();
  return lower >= 'a' && lower <= 'z';
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function pushSemanticToken(
  tokens: SemanticTokenCandidate[],
  pushed: Set<string>,
  range: Range,
  tokenType: VerilogSemanticTokenType,
  modifiers?: string[]
): void {
  if (range.start.line !== range.end.line || range.start.character === range.end.character) {
    return;
  }
  const key = rangeKey(range);
  if (pushed.has(key)) {
    return;
  }
  pushed.add(key);
  tokens.push({
    range,
    tokenType,
    modifiers
  });
}

function compareSemanticTokens(left: SemanticTokenCandidate, right: SemanticTokenCandidate): number {
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
