import { describe, expect, it } from 'vitest';
import { compareTraces, firstTraceDiffSnapshot } from '../../../language/mips/traceCompare';
import { parseMarsOutput } from '../../../language/mips/traceParser';

describe('CPU trace compare', () => {
  it('matches traces by PC, target, and value while ignoring cycles by default', () => {
    const mars = parseMarsOutput('10@00003000: $1 <= 00000001\n20@00003004: *00001000 <= 00000002\n');
    const sim = parseMarsOutput('100@00003000: $1 <= 00000001\n120@00003004: *00001000 <= 00000002\n');

    const result = compareTraces(mars, sim);

    expect(result.matched).toBe(true);
    expect(result.firstDiffIndex).toBe(-1);
    expect(result.summary).toMatchObject({
      marsEvents: 2,
      simEvents: 2,
      matchedEvents: 2,
      diffEvents: 0
    });
  });

  it('can require cycle equality in strict mode', () => {
    const mars = parseMarsOutput('10@00003000: $1 <= 00000001\n');
    const sim = parseMarsOutput('12@00003000: $1 <= 00000001\n');

    const result = compareTraces(mars, sim, { compareCycles: true });

    expect(result.matched).toBe(false);
    expect(result.firstDiffIndex).toBe(0);
    expect(result.entries[0].status).toBe('cycle-diff');
  });

  it('matches adjacent memory and register writes from the same cycle regardless of display order', () => {
    const mars = parseMarsOutput([
      '@00003004: *00001000 <= 00000002',
      '@00003000: $1 <= 00000001'
    ].join('\n'));
    const sim = parseMarsOutput([
      '100@00003000: $1 <= 00000001',
      '100@00003004: *00001000 <= 00000002'
    ].join('\n'));

    const result = compareTraces(mars, sim);

    expect(result.matched).toBe(true);
    expect(result.summary.matchedEvents).toBe(2);
    expect(result.entries[0]).toMatchObject({
      status: 'ok',
      mars: { kind: 'dm', pc: '00003004' },
      sim: { kind: 'dm', pc: '00003004' }
    });
    expect(result.entries[1]).toMatchObject({
      status: 'ok',
      mars: { kind: 'grf', pc: '00003000' },
      sim: { kind: 'grf', pc: '00003000' }
    });
  });

  it('does not hide reordered events from different cycles', () => {
    const mars = parseMarsOutput([
      '@00003004: *00001000 <= 00000002',
      '@00003000: $1 <= 00000001'
    ].join('\n'));
    const sim = parseMarsOutput([
      '100@00003000: $1 <= 00000001',
      '120@00003004: *00001000 <= 00000002'
    ].join('\n'));

    const result = compareTraces(mars, sim);

    expect(result.matched).toBe(false);
    expect(result.firstDiffIndex).toBe(0);
    expect(result.entries[0].status).toBe('diff');
  });

  it('reports the first semantic difference', () => {
    const mars = parseMarsOutput('@00003000: $1 <= 00000001\n@00003004: $2 <= 00000002\n');
    const sim = parseMarsOutput('@00003000: $1 <= 00000001\n@00003004: $2 <= 00000003\n');

    const result = compareTraces(mars, sim);

    expect(result.matched).toBe(false);
    expect(result.firstDiffIndex).toBe(1);
    expect(result.entries[1]).toMatchObject({
      status: 'diff',
      reason: 'Write value differs.'
    });
  });

  it('marks extra events on either side', () => {
    const mars = parseMarsOutput('@00003000: $1 <= 00000001\n@00003004: $2 <= 00000002\n');
    const sim = parseMarsOutput('@00003000: $1 <= 00000001\n');

    const result = compareTraces(mars, sim);

    expect(result.matched).toBe(false);
    expect(result.entries[1].status).toBe('mars-only');
  });

  it('serializes the first difference for batch reports', () => {
    const mars = parseMarsOutput('@00003000: $1 <= 00000001\n@00003004: $2 <= 00000002\n');
    const sim = parseMarsOutput('@00003000: $1 <= 00000001\n@00003004: $2 <= 00000003\n');

    const snapshot = firstTraceDiffSnapshot(compareTraces(mars, sim));

    expect(snapshot).toMatchObject({
      index: 1,
      status: 'diff',
      reason: 'Write value differs.',
      mars: {
        pc: '00003004',
        kind: 'grf',
        target: '2',
        value: '00000002',
        lineNumber: 2
      },
      sim: {
        pc: '00003004',
        kind: 'grf',
        target: '2',
        value: '00000003',
        lineNumber: 2
      }
    });
  });

  it('does not serialize a first difference for matching traces', () => {
    const mars = parseMarsOutput('@00003000: $1 <= 00000001\n');
    const sim = parseMarsOutput('@00003000: $1 <= 00000001\n');

    expect(firstTraceDiffSnapshot(compareTraces(mars, sim))).toBeUndefined();
  });
});
