import { describe, expect, it } from 'vitest';
import { Range } from 'vscode-languageserver/node';
import { SemanticTokenCollector } from '../../../language/common/semanticTokens';

describe('SemanticTokenCollector', () => {
  it('sorts, deduplicates and encodes declaration modifiers', () => {
    const collector = new SemanticTokenCollector(['module', 'signal'] as const, 3);
    collector.add(Range.create(1, 4, 1, 7), 'signal');
    collector.add(Range.create(0, 2, 0, 5), 'module', ['declaration']);
    collector.add(Range.create(0, 2, 0, 5), 'signal');

    expect(collector.build().data).toEqual([
      0, 2, 3, 3, 1,
      1, 4, 3, 4, 0
    ]);
  });

  it('drops multiline, empty and overlapping candidates rejected by the LSP legend', () => {
    const collector = new SemanticTokenCollector(['signal'] as const);
    collector.add(Range.create(0, 0, 1, 2), 'signal');
    collector.add(Range.create(1, 1, 1, 1), 'signal');
    collector.add(Range.create(2, 1, 2, 5), 'signal');
    collector.add(Range.create(2, 3, 2, 7), 'signal');

    expect(collector.build().data).toEqual([2, 1, 4, 0, 0]);
  });
});
