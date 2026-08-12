// @index semantic-token-collector — 统一排序、去重并编码 LSP semantic tokens
import { Range, SemanticTokens, SemanticTokensBuilder } from 'vscode-languageserver/node';
import { rangeKey } from './util';

interface SemanticTokenCandidate<TokenType extends string> {
  range: Range;
  tokenType: TokenType;
  modifiers?: readonly string[];
}

/**
 * Collects semantic identifiers and encodes them against the server-wide legend.
 * TextMate owns lexical tokens, so candidates are expected to be single-line,
 * non-overlapping symbol ranges.
 */
export class SemanticTokenCollector<TokenType extends string> {
  private readonly candidatesByRange = new Map<string, SemanticTokenCandidate<TokenType>>();
  private readonly tokenTypeIndex: ReadonlyMap<TokenType, number>;
  private readonly tokenModifierIndex: ReadonlyMap<string, number>;

  constructor(
    tokenTypes: readonly TokenType[],
    tokenTypeOffset = 0,
    tokenModifiers: readonly string[] = ['declaration']
  ) {
    this.tokenTypeIndex = new Map(tokenTypes.map((type, index) => [type, tokenTypeOffset + index]));
    this.tokenModifierIndex = new Map(tokenModifiers.map((modifier, index) => [modifier, index]));
  }

  add(range: Range, tokenType: TokenType, modifiers?: readonly string[]): void {
    if (range.start.line !== range.end.line || range.start.character >= range.end.character) {
      return;
    }
    const key = rangeKey(range);
    if (!this.candidatesByRange.has(key)) {
      this.candidatesByRange.set(key, { range, tokenType, modifiers });
    }
  }

  build(): SemanticTokens {
    const builder = new SemanticTokensBuilder();
    const candidates = [...this.candidatesByRange.values()].sort(compareCandidates);
    let previous: SemanticTokenCandidate<TokenType> | undefined;
    for (const candidate of candidates) {
      if (previous && rangesOverlap(previous.range, candidate.range)) {
        continue;
      }
      const type = this.tokenTypeIndex.get(candidate.tokenType);
      if (type === undefined) {
        continue;
      }
      builder.push(
        candidate.range.start.line,
        candidate.range.start.character,
        candidate.range.end.character - candidate.range.start.character,
        type,
        this.modifierBitset(candidate.modifiers)
      );
      previous = candidate;
    }
    return builder.build();
  }

  private modifierBitset(modifiers?: readonly string[]): number {
    let bitset = 0;
    for (const modifier of modifiers ?? []) {
      const index = this.tokenModifierIndex.get(modifier);
      if (index !== undefined) {
        bitset |= 1 << index;
      }
    }
    return bitset;
  }
}

function compareCandidates<TokenType extends string>(
  left: SemanticTokenCandidate<TokenType>,
  right: SemanticTokenCandidate<TokenType>
): number {
  if (left.range.start.line !== right.range.start.line) {
    return left.range.start.line - right.range.start.line;
  }
  if (left.range.start.character !== right.range.start.character) {
    return left.range.start.character - right.range.start.character;
  }
  return left.range.end.character - right.range.end.character;
}

function rangesOverlap(left: Range, right: Range): boolean {
  return left.start.line === right.start.line && right.start.character < left.end.character;
}
