import { describe, expect, it } from 'vitest';
import { sha256Canonical, type CanonicalJson } from '../../mips/replay/canonical';
import {
  maximumOracleDetailedBlockEvents,
  maximumOracleEvidenceEvents,
  maximumProgramImageInputUnits,
  maximumProgramImageSegments,
  maximumProgramImageSourceMapEntries,
  maximumProgramImageSymbols,
  maximumProgramImageWords,
  oracleEvidenceDigests,
  programImageIssues
} from '../../mips/replay/programImage';

const digest = 'a'.repeat(64);

function image(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    fingerprint: digest,
    entryPc: 0x3000,
    segments: [{ name: 'text', baseAddress: 0x3000, words: [0] }],
    symbols: [],
    sourceMap: [],
    inputGraph: [{ id: 'source-0000', contentHash: digest }],
    ...overrides
  };
}

describe('bounded replay ProgramImage and oracle evidence', () => {
  it('rejects every attacker-sized ProgramImage collection before expansion', () => {
    expect(programImageIssues(image({
      segments: [{ name: 'text', baseAddress: 0x3000, words: new Array(maximumProgramImageWords + 1).fill(0) }]
    }))).toContain(`segment word count exceeds the course IM limit ${maximumProgramImageWords}`);
    expect(programImageIssues(image({
      segments: new Array(maximumProgramImageSegments + 1).fill({ name: 'text', baseAddress: 0x3000, words: [] })
    }))).toContain(`segments exceeds the trusted limit ${maximumProgramImageSegments}`);
    expect(programImageIssues(image({ symbols: new Array(maximumProgramImageSymbols + 1).fill({}) })))
      .toContain(`symbols exceeds the trusted limit ${maximumProgramImageSymbols}`);
    expect(programImageIssues(image({ sourceMap: new Array(maximumProgramImageSourceMapEntries + 1).fill({}) })))
      .toContain(`sourceMap exceeds the trusted limit ${maximumProgramImageSourceMapEntries}`);
    expect(programImageIssues(image({ inputGraph: new Array(maximumProgramImageInputUnits + 1).fill({}) })))
      .toContain(`inputGraph exceeds the trusted limit ${maximumProgramImageInputUnits}`);
  });

  it('preserves the canonical evidence digest while aggregating events as a stream', () => {
    const trace = '@00003000: $1 <= 0000000a\n@00003004: *00000004 <= 0000000b\n';
    const evidence = oracleEvidenceDigests(trace, 1);
    const canonical = [
      { pc: '00003000', kind: 'grf', target: '1', value: '0000000A' },
      { pc: '00003004', kind: 'dm', target: '00000004', value: '0000000B' }
    ];
    expect(evidence.eventDigest).toBe(sha256Canonical(canonical as unknown as CanonicalJson));
    expect(evidence).toMatchObject({ eventCount: 2, steps: 2 });
  });

  it('fails closed at the trusted event ceiling without retaining a token array', () => {
    const trace = '@0:$0<=0\n'.repeat(maximumOracleEvidenceEvents + 1);
    expect(() => oracleEvidenceDigests(trace, 1))
      .toThrow(`oracle evidence event count exceeds the trusted limit ${maximumOracleEvidenceEvents}`);
  }, 30_000);

  it('bounds one detailed instruction block before the parser can retain arbitrary raw events', () => {
    const trace = '@PC00003000 -> nop (00000000)\n'
      + '\t\t$0 <= 00000000\n'.repeat(maximumOracleDetailedBlockEvents + 1);
    expect(() => oracleEvidenceDigests(trace, 2))
      .toThrow(`MARS detailed trace instruction block exceeds the trusted limit ${maximumOracleDetailedBlockEvents}`);
  });
});
