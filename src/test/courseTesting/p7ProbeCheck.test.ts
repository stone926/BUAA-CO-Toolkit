import { describe, expect, it } from 'vitest';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { P7ProbeMetadata } from '../../courseTesting/builtinAsmGenerator';

const baseMetadata: P7ProbeMetadata = {
  version: 1,
  logBase: 0x2800,
  recordWords: 8,
  scenarios: [
    {
      id: 1,
      kind: 'external',
      expectedIpMask: 0x1000,
      expectedExcCode: 0,
      allowedEpc: [0x3020],
      donePc: 0x3028,
      waitPc: 0x3020,
      armAddress: 0x27d0,
      armValue: 1,
      externalDelayCycles: 3
    },
    { id: 2, kind: 'timer0', expectedIpMask: 0x0400, allowedEpc: [0x3040], donePc: 0x3048, waitPc: 0x3040 }
  ]
};

describe('P7 probe checker', () => {
  it('accepts valid external and timer records', () => {
    const sim = [
      ...recordLines(0, [0xc0a70001, 1, 1, 0x1c03, 0x1000, 0x3020, 0, 0]),
      ...recordLines(1, [0xc0a70001, 2, 2, 0x1c03, 0x0400, 0x3040, 0, 0]),
      'CO_P7_PROBE external_arm scenario=1 addr=000027d0 value=00000001 time=80',
      'CO_P7_PROBE external_raise scenario=1 pc=00003020 time=96',
      'CO_P7_PROBE external_ack scenario=1 time=100'
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), baseMetadata);

    expect(result.passed).toBe(true);
    expect(result.records).toHaveLength(2);
  });

  it('reports missing IP, missing ack, and uncleared timer CTRL', () => {
    const sim = [
      ...recordLines(0, [0xc0a70001, 1, 1, 0x1c03, 0x0000, 0x3020, 0, 0]),
      ...recordLines(1, [0xc0a70001, 2, 2, 0x1c03, 0x0400, 0x3040, 0x9, 0])
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), baseMetadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.message.includes('Cause.IP'))).toBe(true);
    expect(result.failures.some((failure) => failure.message.includes('armed'))).toBe(true);
    expect(result.failures.some((failure) => failure.message.includes('raised'))).toBe(true);
    expect(result.failures.some((failure) => failure.message.includes('0x7f20'))).toBe(true);
    expect(result.failures.some((failure) => failure.message.includes('timer CTRL'))).toBe(true);
  });

  it('fails on testbench MMIO-on-DM diagnostics', () => {
    const sim = [
      ...recordLines(0, [0xc0a70001, 1, 1, 0x1c03, 0x1000, 0x3020, 0, 0]),
      ...recordLines(1, [0xc0a70001, 2, 2, 0x1c03, 0x0400, 0x3040, 0, 0]),
      'CO_P7_PROBE external_arm scenario=1 addr=000027d0 value=00000001 time=80',
      'CO_P7_PROBE external_raise scenario=1 pc=00003020 time=96',
      'CO_P7_PROBE external_ack scenario=1 time=100',
      'CO_P7_PROBE mmio_on_dm pc=00003000 addr=00007f00 byteen=f time=104'
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), baseMetadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.kind === 'tb' && failure.message.includes('mmio_on_dm'))).toBe(true);
  });

  it('checks exact internal exception codes and duplicate records', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: 0x2800,
      recordWords: 8,
      scenarios: [
        { id: 1, kind: 'adel', expectedIpMask: 0, expectedExcCode: 4, allowedEpc: [0x3020], donePc: 0x3024, waitPc: 0x3020 },
        { id: 2, kind: 'ov', expectedIpMask: 0, expectedExcCode: 12, allowedEpc: [0x3040], donePc: 0x3044, waitPc: 0x3040 }
      ]
    };
    const sim = [
      ...recordLines(0, [0xc0a70001, 1, 5, 0x0002, 0x0010, 0x3020, 0, 0]),
      ...recordLines(1, [0xc0a70001, 2, 9, 0x0002, 0x0030, 0x3040, 0, 0]),
      ...recordLines(2, [0xc0a70001, 2, 9, 0x0002, 0x0030, 0x3040, 0, 0])
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.scenarioId === 2 && failure.message.includes('duplicate'))).toBe(true);
  });

  it('reports exact internal exception code mismatches', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: 0x2800,
      recordWords: 8,
      scenarios: [
        { id: 1, kind: 'syscall', expectedIpMask: 0, expectedExcCode: 8, allowedEpc: [0x3020], donePc: 0x3024, waitPc: 0x3020 }
      ]
    };
    const sim = recordLines(0, [0xc0a70001, 1, 7, 0x0002, 0x0028, 0x3020, 0, 0]).join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.message.includes('ExcCode'))).toBe(true);
  });
});

function recordLines(index: number, values: number[]): string[] {
  const base = 0x2800 + index * 32;
  return values.map((value, field) =>
    `10@00004180: *${(base + field * 4).toString(16).padStart(8, '0')} <= ${(value >>> 0).toString(16).padStart(8, '0')}`);
}
