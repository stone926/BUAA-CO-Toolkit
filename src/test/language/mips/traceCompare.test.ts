import { describe, expect, it } from 'vitest';
import { compareTraceIterables, compareTraces, firstTraceDiffEntry, firstTraceDiffSnapshot } from '../../../language/mips/traceCompare';
import { parseMarsOutput } from '../../../language/mips/traceParser';

describe('CPU trace compare', () => {
  it('matches traces by PC, target, and value while ignoring cycles by default', () => {
    const mars = parseMarsOutput('10@00003000: $1 <= 00000001\n20@00003004: *00001000 <= 00000002\n');
    const sim = parseMarsOutput('100@00003000: $1 <= 00000001\n120@00003004: *00001000 <= 00000002\n');

    const result = compareTraces(mars, sim);

    expect(result.matched).toBe(true);
    expect(result.firstDiffIndex).toBe(-1);
    expect(result.summary).toMatchObject({
      oracleEvents: 2,
      dutEvents: 2,
      matchedEvents: 2,
      diffEvents: 0
    });
    expect(result.summary).not.toHaveProperty('marsEvents');
    expect(result.summary).not.toHaveProperty('simEvents');
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
      oracle: { kind: 'dm', pc: '00003004' },
      dut: { kind: 'dm', pc: '00003004' }
    });
    expect(result.entries[0]).not.toHaveProperty('mars');
    expect(result.entries[0]).not.toHaveProperty('sim');
    expect(result.entries[1]).toMatchObject({
      status: 'ok',
      oracle: { kind: 'grf', pc: '00003000' },
      dut: { kind: 'grf', pc: '00003000' }
    });
    expect(result.entries[1]).not.toHaveProperty('mars');
    expect(result.entries[1]).not.toHaveProperty('sim');
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
    expect(result.entries[1].status).toBe('oracle-only');
  });

  it('serializes the first difference for batch reports', () => {
    const mars = parseMarsOutput('@00003000: $1 <= 00000001\n@00003004: $2 <= 00000002\n');
    const sim = parseMarsOutput('@00003000: $1 <= 00000001\n@00003004: $2 <= 00000003\n');

    const snapshot = firstTraceDiffSnapshot(compareTraces(mars, sim));

    expect(snapshot).toMatchObject({
      index: 1,
      status: 'diff',
      reason: 'Write value differs.',
      oracle: {
        pc: '00003004',
        kind: 'grf',
        target: '2',
        value: '00000002',
        lineNumber: 2
      },
      dut: {
        pc: '00003004',
        kind: 'grf',
        target: '2',
        value: '00000003',
        lineNumber: 2
      }
    });
    expect(snapshot).not.toHaveProperty('mars');
    expect(snapshot).not.toHaveProperty('sim');
  });

  it('does not serialize a first difference for matching traces', () => {
    const mars = parseMarsOutput('@00003000: $1 <= 00000001\n');
    const sim = parseMarsOutput('@00003000: $1 <= 00000001\n');

    expect(firstTraceDiffSnapshot(compareTraces(mars, sim))).toBeUndefined();
  });

  it('can retain only bounded entries while preserving summaries and first diff details', () => {
    const mars = parseMarsOutput([
      '@00003000: $1 <= 00000001',
      '@00003004: $2 <= 00000002',
      '@00003008: $3 <= 00000003'
    ].join('\n'));
    const sim = parseMarsOutput([
      '@00003000: $1 <= 00000001',
      '@00003004: $2 <= 00000002',
      '@00003008: $3 <= 00000004'
    ].join('\n'));

    const result = compareTraces(mars, sim, { retainedEntryLimit: 1 });

    expect(result.entries).toHaveLength(1);
    expect(result.entriesTruncated).toBe(true);
    expect(result.summary).toMatchObject({
      oracleEvents: 3,
      dutEvents: 3,
      matchedEvents: 2,
      diffEvents: 1
    });
    expect(result.firstDiffIndex).toBe(2);
    expect(firstTraceDiffEntry(result)).toMatchObject({
      index: 2,
      status: 'diff',
      reason: 'Write value differs.'
    });
    expect(firstTraceDiffSnapshot(result)).toMatchObject({
      index: 2,
      oracle: { value: '00000003' },
      dut: { value: '00000004' }
    });
  });

  it('compares non-array trace iterables without retaining full entries', () => {
    function* events(text: string) {
      yield* parseMarsOutput(text);
    }

    const result = compareTraceIterables(
      events('@00003000: $1 <= 00000001\n@00003004: $2 <= 00000002'),
      events('@00003000: $1 <= 00000001\n@00003004: $2 <= 00000002'),
      { retainedEntryLimit: 0 }
    );

    expect(result.matched).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.entriesTruncated).toBe(true);
    expect(result.summary).toMatchObject({
      oracleEvents: 2,
      dutEvents: 2,
      matchedEvents: 2,
      diffEvents: 0
    });
    expect(result.summary).not.toHaveProperty('marsEvents');
    expect(result.summary).not.toHaveProperty('simEvents');
  });

  it('upgrades legacy trace-side aliases when snapshotting old report entries', () => {
    const oracle = parseMarsOutput('@00003000: $1 <= 00000001\n')[0];
    const dut = parseMarsOutput('@00003000: $1 <= 00000002\n')[0];

    expect(firstTraceDiffSnapshot({
      matched: false,
      firstDiffIndex: 0,
      entries: [{ index: 0, status: 'mars-only', mars: oracle, sim: dut }],
      summary: {
        oracleEvents: 1,
        dutEvents: 1,
        marsEvents: 1,
        simEvents: 1,
        matchedEvents: 0,
        diffEvents: 1
      }
    })).toMatchObject({
      status: 'oracle-only',
      oracle: { value: '00000001' },
      dut: { value: '00000002' }
    });
  });
});
