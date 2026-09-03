import { describe, expect, it } from 'vitest';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { P7ProbeMetadata } from '../../courseTesting/builtinAsmGenerator';
import {
  p7ExternalInterruptAckAddress,
  p7Hex,
  p7ProbeLogBase,
  p7ProbeMagic,
  p7ProbeRecordWords
} from '../../courseTesting/p7Hardware';

const baseMetadata: P7ProbeMetadata = {
  version: 1,
  logBase: p7ProbeLogBase,
  recordWords: p7ProbeRecordWords,
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
  it('requires an independent second Status sample inside its packed record', () => {
    const metadata: P7ProbeMetadata = {
      version: 1, logBase: p7ProbeLogBase, recordWords: p7ProbeRecordWords,
      scenarios: [{
        id: 1, kind: 'timer0', expectedIpMask: 0x400, allowedEpc: [0x3020], donePc: 0x3024,
        replayStatusAddress: 0x27d8,
        expectedRecords: [
          { expectedIpMask: 0x400, expectedExcCode: 0, allowedEpc: [0x3020] },
          { expectedIpMask: 0, expectedExcCode: 10, allowedEpc: [0x3020] }
        ]
      }]
    };
    const lines = recordLines(0, [p7ProbeMagic, 1, 2, 0x1c03, 0x400, 0x3020, 10 << 2, 0x3020]);
    const sample = '0@00004190: *000027d8 <= 00001c03';
    const valid = [lines[0], sample, ...lines.slice(1)].join('\n');
    expect(checkP7Probe(valid, parseSimOutput(valid), metadata).passed).toBe(true);
    for (const invalid of [
      lines.join('\n'),
      [sample, ...lines].join('\n'),
      [...lines, sample].join('\n'),
      [lines[0], sample, sample, ...lines.slice(1)].join('\n'),
      valid.replace('*000027d8 <= 00001c03', '*000027d8 <= 00001c01')
    ]) {
      const checked = checkP7Probe(invalid, parseSimOutput(invalid), metadata);
      expect(checked.failures.some((failure) => failure.message.includes('Status'))).toBe(true);
    }
  });

  it('accepts valid external and timer records', () => {
    const sim = [
      ...recordLines(0, [p7ProbeMagic, 1, 1, 0x1c03, 0x1000, 0x3020, 0, 0]),
      ...recordLines(1, [p7ProbeMagic, 2, 2, 0x1c03, 0x0400, 0x3040, 0, 0]),
      'CO_P7_PROBE external_arm scenario=1 addr=000027d0 value=00000001 time=80',
      'CO_P7_PROBE external_raise scenario=1 pc=00003020 time=96',
      'CO_P7_PROBE external_ack scenario=1 time=100'
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), baseMetadata);

    expect(result.passed).toBe(true);
    expect(result.records).toHaveLength(2);
  });

  it('accepts a wait-loop delay-slot interrupt with BD set and branch EPC', () => {
    const sim = [
      ...recordLines(0, [p7ProbeMagic, 1, 1, 0x1c03, 0x80001000, 0x3020, 0, 0]),
      ...recordLines(1, [p7ProbeMagic, 2, 2, 0x1c03, 0x0400, 0x3040, 0, 0]),
      'CO_P7_PROBE external_arm scenario=1 addr=000027d0 value=00000001 time=80',
      'CO_P7_PROBE external_raise scenario=1 pc=00003024 time=96',
      'CO_P7_PROBE external_ack scenario=1 time=100'
    ].join('\n');

    expect(checkP7Probe(sim, parseSimOutput(sim), baseMetadata).passed).toBe(true);
  });

  it('requires the configured interrupt mask, IE, and EXL bits in recorded Status', () => {
    const sim = [
      ...recordLines(0, [p7ProbeMagic, 1, 1, 0x1c01, 0x1000, 0x3020, 0, 0]),
      ...recordLines(1, [p7ProbeMagic, 2, 2, 0x0002, 0x0400, 0x3040, 0, 0]),
      'CO_P7_PROBE external_arm scenario=1 addr=000027d0 value=00000001 time=80',
      'CO_P7_PROBE external_raise scenario=1 pc=00003020 time=96',
      'CO_P7_PROBE external_ack scenario=1 time=100'
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), baseMetadata);

    expect(result.passed).toBe(false);
    expect(result.failures.filter((failure) => failure.message.includes('Status'))).toHaveLength(2);
  });

  it('requires unimplemented Status and Cause bits to remain zero', () => {
    const sim = [
      ...recordLines(0, [p7ProbeMagic, 1, 1, 0x1c07, 0x1001, 0x3020, 0, 0]),
      ...recordLines(1, [p7ProbeMagic, 2, 2, 0x1c03, 0x0401, 0x3040, 0, 0]),
      'CO_P7_PROBE external_arm scenario=1 addr=000027d0 value=00000001 time=80',
      'CO_P7_PROBE external_raise scenario=1 pc=00003020 time=96',
      'CO_P7_PROBE external_ack scenario=1 time=100'
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), baseMetadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.message.includes('Status differs'))).toBe(true);
    expect(result.failures.filter((failure) => failure.message.includes('unimplemented bits'))).toHaveLength(2);
  });

  it('rejects unexpected pending sources in an isolated timer scenario', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [
        { id: 1, kind: 'timer0', expectedIpMask: 0x0400, allowedEpc: [0x3020], donePc: 0x3028, waitPc: 0x3020 }
      ]
    };
    const sim = recordLines(0, [p7ProbeMagic, 1, 2, 0x1c03, 0x1c00, 0x3020, 0, 0]).join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.message.includes('Cause.IP differs'))).toBe(true);
  });

  it('reports missing IP, missing ack, and uncleared timer CTRL', () => {
    const sim = [
      ...recordLines(0, [p7ProbeMagic, 1, 1, 0x1c03, 0x0000, 0x3020, 0, 0]),
      ...recordLines(1, [p7ProbeMagic, 2, 2, 0x1c03, 0x0400, 0x3040, 0x9, 0])
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), baseMetadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.message.includes('Cause.IP'))).toBe(true);
    expect(result.failures.some((failure) => failure.message.includes('armed'))).toBe(true);
    expect(result.failures.some((failure) => failure.message.includes('raised'))).toBe(true);
    expect(result.failures.some((failure) => failure.message.includes(p7Hex(p7ExternalInterruptAckAddress)))).toBe(true);
    expect(result.failures.some((failure) => failure.message.includes('timer CTRL'))).toBe(true);
  });

  it('requires timer CTRL and COUNT to be exactly zero after the handler clears CTRL', () => {
    const metadata: P7ProbeMetadata = {
      ...baseMetadata,
      scenarios: [baseMetadata.scenarios[1]]
    };
    const sim = recordLines(0, [p7ProbeMagic, 2, 2, 0x1c03, 0x0400, 0x3040, 0x8, 0x1]).join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.message.includes('timer CTRL differs'))).toBe(true);
    expect(result.failures.some((failure) => failure.message.includes('timer COUNT differs'))).toBe(true);
  });

  it('requires physical record order to match metadata scenario order', () => {
    const sim = [
      ...recordLines(0, [p7ProbeMagic, 2, 2, 0x1c03, 0x0400, 0x3040, 0, 0]),
      ...recordLines(1, [p7ProbeMagic, 1, 1, 0x1c03, 0x1000, 0x3020, 0, 0]),
      'CO_P7_PROBE external_arm scenario=1 addr=000027d0 value=00000001 time=80',
      'CO_P7_PROBE external_raise scenario=1 pc=00003020 time=96',
      'CO_P7_PROBE external_ack scenario=1 time=100'
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), baseMetadata);

    expect(result.passed).toBe(false);
    expect(result.failures.filter((failure) => failure.message.includes('record order'))).toHaveLength(2);
  });

  it('fails on testbench MMIO-on-DM diagnostics', () => {
    const sim = [
      ...recordLines(0, [p7ProbeMagic, 1, 1, 0x1c03, 0x1000, 0x3020, 0, 0]),
      ...recordLines(1, [p7ProbeMagic, 2, 2, 0x1c03, 0x0400, 0x3040, 0, 0]),
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
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [
        { id: 1, kind: 'adel', expectedIpMask: 0, expectedExcCode: 4, allowedEpc: [0x3020], donePc: 0x3024, waitPc: 0x3020 },
        { id: 2, kind: 'ov', expectedIpMask: 0, expectedExcCode: 12, allowedEpc: [0x3040], donePc: 0x3044, waitPc: 0x3040 }
      ]
    };
    const sim = [
      ...recordLines(0, [p7ProbeMagic, 1, 5, 0x1c03, 0x0010, 0x3020, 0, 0]),
      ...recordLines(1, [p7ProbeMagic, 2, 9, 0x1c03, 0x0030, 0x3040, 0, 0]),
      ...recordLines(2, [p7ProbeMagic, 2, 9, 0x1c03, 0x0030, 0x3040, 0, 0])
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.scenarioId === 2 && failure.message.includes('duplicate'))).toBe(true);
  });

  it('reports exact internal exception code mismatches', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [
        { id: 1, kind: 'syscall', expectedIpMask: 0, expectedExcCode: 8, allowedEpc: [0x3020], donePc: 0x3024, waitPc: 0x3020 }
      ]
    };
    const sim = recordLines(0, [p7ProbeMagic, 1, 7, 0x1c03, 0x0028, 0x3020, 0, 0]).join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.message.includes('ExcCode'))).toBe(true);
  });

  it('rejects unexpected Cause.IP and Cause.BD on generated internal exceptions', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [
        { id: 1, kind: 'syscall', expectedIpMask: 0, expectedExcCode: 8, allowedEpc: [0x3020], donePc: 0x3024, waitPc: 0x3020 },
        { id: 2, kind: 'adel', expectedIpMask: 0, expectedExcCode: 4, allowedEpc: [0x3040], donePc: 0x3044, waitPc: 0x3040 }
      ]
    };
    const sim = [
      ...recordLines(0, [p7ProbeMagic, 1, 7, 0x1c03, 0x80000020, 0x3020, 0, 0]),
      ...recordLines(1, [p7ProbeMagic, 2, 5, 0x1c03, 0x2010, 0x3040, 0, 0])
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.scenarioId === 1 && failure.message.includes('Cause.BD'))).toBe(true);
    expect(result.failures.some((failure) => failure.scenarioId === 2 && failure.message.includes('Cause.IP'))).toBe(true);
  });

  it('accepts the exact BD and branch EPC for a delay-slot exception', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [
        {
          id: 1,
          kind: 'syscall',
          expectedIpMask: 0,
          expectedExcCode: 8,
          expectedBd: true,
          allowedEpc: [0x3020],
          victimPc: 0x3024,
          donePc: 0x3028,
          waitPc: 0x3020
        }
      ]
    };
    const sim = [
      '8@00003028: $1 <= 00000001',
      ...recordLines(0, [p7ProbeMagic, 1, 7, 0x1c03, 0x80000020, 0x3020, 0, 0])
    ].join('\n');

    expect(checkP7Probe(sim, parseSimOutput(sim), metadata).passed).toBe(true);
  });

  it('rejects GPR and DM commits from precise-exception victim PCs', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [
        {
          id: 1,
          kind: 'ov',
          expectedIpMask: 0,
          expectedExcCode: 12,
          expectedBd: false,
          allowedEpc: [0x3020],
          victimPc: 0x3020,
          donePc: 0x3024,
          waitPc: 0x3020
        },
        {
          id: 2,
          kind: 'ades',
          expectedIpMask: 0,
          expectedExcCode: 5,
          expectedBd: false,
          allowedEpc: [0x3040],
          victimPc: 0x3040,
          donePc: 0x3044,
          waitPc: 0x3040
        }
      ]
    };
    const sim = [
      '5@00003020: $2 <= deadbeef',
      ...recordLines(0, [p7ProbeMagic, 1, 9, 0x1c03, 0x00000030, 0x3020, 0, 0]),
      '7@00003040: *00000000 <= 12345678',
      ...recordLines(1, [p7ProbeMagic, 2, 6, 0x1c03, 0x00000014, 0x3040, 0, 0])
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.scenarioId === 1 && failure.message.includes('committed GPR'))).toBe(true);
    expect(result.failures.some((failure) => failure.scenarioId === 2 && failure.message.includes('committed DM'))).toBe(true);
  });

  it('rejects a missing BD bit or non-branch EPC for delay-slot exceptions', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [
        {
          id: 1,
          kind: 'syscall',
          expectedIpMask: 0,
          expectedExcCode: 8,
          expectedBd: true,
          allowedEpc: [0x3020],
          donePc: 0x3028,
          waitPc: 0x3020
        },
        {
          id: 2,
          kind: 'ri',
          expectedIpMask: 0,
          expectedExcCode: 10,
          expectedBd: true,
          allowedEpc: [0x3040],
          donePc: 0x3048,
          waitPc: 0x3040
        }
      ]
    };
    const sim = [
      ...recordLines(0, [p7ProbeMagic, 1, 7, 0x1c03, 0x00000020, 0x3020, 0, 0]),
      ...recordLines(1, [p7ProbeMagic, 2, 8, 0x1c03, 0x80000028, 0x3044, 0, 0])
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.scenarioId === 1 && failure.message.includes('Cause.BD differs'))).toBe(true);
    expect(result.failures.some((failure) => failure.scenarioId === 2 && failure.message.includes('EPC'))).toBe(true);
  });

  it('rejects BD when EPC does not identify the wait branch', () => {
    const metadata: P7ProbeMetadata = {
      ...baseMetadata,
      scenarios: [{ ...baseMetadata.scenarios[1], allowedEpc: [0x303c, 0x3040] }]
    };
    const sim = recordLines(0, [p7ProbeMagic, 2, 2, 0x1c03, 0x80000400, 0x303c, 0, 0]).join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.message.includes('Cause.BD=1'))).toBe(true);
  });

  it('rejects a probe record containing unknown hex digits', () => {
    const metadata: P7ProbeMetadata = {
      ...baseMetadata,
      scenarios: [baseMetadata.scenarios[1]]
    };
    const lines = recordLines(0, [p7ProbeMagic, 2, 2, 0x1c03, 0x0400, 0x3040, 0, 0]);
    lines[7] = lines[7].replace(/00000000$/, 'xxxxxxxx');
    const sim = lines.join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.records).toHaveLength(0);
    expect(result.failures.some((failure) => failure.message.includes('missing probe record'))).toBe(true);
  });

  it('rejects a sparse probe record instead of treating a missing field as zero', () => {
    const metadata: P7ProbeMetadata = {
      ...baseMetadata,
      scenarios: [baseMetadata.scenarios[1]]
    };
    const lines = recordLines(0, [p7ProbeMagic, 2, 2, 0x1c03, 0x0400, 0x3040, 0, 0]);
    lines.splice(6, 1);
    const sim = lines.join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.records).toHaveLength(0);
    expect(result.failures.some((failure) => failure.message.includes('missing probe record'))).toBe(true);
  });

  it('validates packed interrupt-priority and retried-syscall observations in order', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [{
        id: 1,
        kind: 'external',
        expectedIpMask: 0x1000,
        expectedExcCode: 0,
        expectedBd: false,
        allowedEpc: [0x3020],
        victimPc: 0x3020,
        donePc: 0x3024,
        waitPc: 0x3020,
        armAddress: 0x27d0,
        armValue: 1,
        externalDelayCycles: 0,
        expectedRecords: [
          { expectedIpMask: 0x1000, expectedExcCode: 0, expectedBd: false, allowedEpc: [0x3020] },
          { expectedIpMask: 0, expectedExcCode: 8, expectedBd: false, allowedEpc: [0x3020] }
        ],
        requireCompletion: true
      }]
    };
    const sim = [
      'CO_P7_PROBE external_arm scenario=1 addr=000027d0 value=00000001 time=80',
      'CO_P7_PROBE external_raise scenario=1 pc=00003020 time=96',
      'CO_P7_PROBE external_ack scenario=1 time=100',
      ...recordLines(0, [p7ProbeMagic, 1, 1, 0x1c03, 0x1000, 0x3020, 0x20, 0x3020]),
      '20@00003024: $1 <= 00000001'
    ].join('\n');

    expect(checkP7Probe(sim, parseSimOutput(sim), metadata).passed).toBe(true);

    const reversed = [
      'CO_P7_PROBE external_arm scenario=1 addr=000027d0 value=00000001 time=80',
      'CO_P7_PROBE external_raise scenario=1 pc=00003020 time=96',
      'CO_P7_PROBE external_ack scenario=1 time=100',
      ...recordLines(0, [p7ProbeMagic, 1, 1, 0x1c03, 0x20, 0x3020, 0x1000, 0x3020]),
      '20@00003024: $1 <= 00000001'
    ].join('\n');
    const result = checkP7Probe(reversed, parseSimOutput(reversed), metadata);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.message.includes('record 1'))).toBe(true);
    expect(result.failures.some((failure) => failure.message.includes('record 2'))).toBe(true);

    const victimCommit = sim.replace(
      'CO_P7_PROBE external_ack scenario=1 time=100',
      'CO_P7_PROBE external_ack scenario=1 time=100\n12@00003020: $8 <= deadbeef'
    );
    expect(checkP7Probe(victimCommit, parseSimOutput(victimCommit), metadata).failures
      .some((failure) => failure.message.includes('exception victim'))).toBe(true);
  });

  it('rejects eret fall-through poison commits', () => {
    const sim = [
      ...recordLines(0, [p7ProbeMagic, 2, 2, 0x1c03, 0x0400, 0x3040, 0, 0]),
      '20@00004200: *000027d4 <= 00000000'
    ].join('\n');
    const metadata: P7ProbeMetadata = {
      ...baseMetadata,
      scenarios: [baseMetadata.scenarios[1]]
    };

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.kind === 'eret' && failure.message.includes('poison'))).toBe(true);
  });

  it('requires masked-window commits before the handler record', () => {
    const scenario: P7ProbeMetadata['scenarios'][number] = {
      id: 1,
      kind: 'external',
      expectedIpMask: 0x1000,
      expectedExcCode: 0,
      allowedEpc: [0x3030],
      donePc: 0x3040,
      waitPc: 0x3030,
      triggerPc: 0x3010,
      armAddress: 0x27d0,
      armValue: 1,
      requiredPreHandlerCommits: [{ pc: 0x3020, kind: 'dm', target: 0x27dc, value: 0x6001 }]
    };
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [scenario]
    };
    const diagnostics = [
      'CO_P7_PROBE external_arm scenario=1 addr=000027d0 value=00000001 time=80',
      'CO_P7_PROBE external_raise scenario=1 pc=00003010 time=96',
      'CO_P7_PROBE external_ack scenario=1 time=100'
    ];
    const valid = [
      ...diagnostics,
      '10@00003020: *000027dc <= 00006001',
      ...recordLines(0, [p7ProbeMagic, 1, 1, 0x1c03, 0x1000, 0x3030, 0, 0])
    ].join('\n');
    expect(checkP7Probe(valid, parseSimOutput(valid), metadata).passed).toBe(true);

    const late = [
      ...diagnostics,
      ...recordLines(0, [p7ProbeMagic, 1, 1, 0x1c03, 0x1000, 0x3030, 0, 0]),
      '30@00003020: *000027dc <= 00006001'
    ].join('\n');
    expect(checkP7Probe(late, parseSimOutput(late), metadata).failures
      .some((failure) => failure.message.includes('pre-handler'))).toBe(true);
  });

  it('accepts a cleared Cause.IP readback for pulse-shaped timer mode', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [{
        id: 1,
        kind: 'timer0',
        expectedIpMask: 0x0400,
        allowedEpc: [0x3020],
        donePc: 0x3028,
        expectedRecords: [{
          expectedIpMask: 0x0400,
          allowedIpMasks: [0, 0x0400],
          expectedExcCode: 0,
          allowedEpc: [0x3020]
        }]
      }]
    };
    const sim = recordLines(0, [p7ProbeMagic, 1, 2, 0x1c03, 0, 0x3020, 0, 0]).join('\n');

    expect(checkP7Probe(sim, parseSimOutput(sim), metadata).passed).toBe(true);
  });

  it('requires two Mode-1 reloads, a cleared old IP marker, and a later fresh interrupt', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      shard: 'timer',
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [{
        id: 1,
        kind: 'timer0',
        expectedIpMask: 0x0400,
        allowedEpc: [0x3060, 0x3064],
        donePc: 0x3068,
        expectedRecords: [
          {
            expectedIpMask: 0x0400,
            allowedIpMasks: [0, 0x0400],
            expectedExcCode: 0,
            allowedEpc: [0x3020, 0x3024],
            allowedBdEpc: [0x3020]
          },
          {
            expectedIpMask: 0x0400,
            allowedIpMasks: [0, 0x0400],
            expectedExcCode: 0,
            allowedEpc: [0x3060, 0x3064],
            allowedBdEpc: [0x3060]
          }
        ],
        requiredPreHandlerCommits: [
          { pc: 0x3030, kind: 'grf', target: 11, value: 1 },
          { pc: 0x3030, kind: 'grf', target: 11, value: 2 },
          { pc: 0x3040, kind: 'grf', target: 15, value: 0 },
          { pc: 0x3044, kind: 'dm', target: 0x27dc, value: 0x7101 }
        ]
      }]
    };
    const protocolCommits = [
      '10@00003030: $11 <= 00000001',
      '11@00003030: $11 <= 00000002',
      '12@00003040: $15 <= 00000000',
      '13@00003044: *000027dc <= 00007101'
    ];
    const sim = [
      ...protocolCommits,
      ...recordLines(0, [p7ProbeMagic, 1, 2, 0x1c03, 0, 0x3020, 0x0400, 0x3060])
    ].join('\n');

    expect(checkP7Probe(sim, parseSimOutput(sim), metadata).passed).toBe(true);

    const missingDeassertMarker = sim.replace('13@00003044: *000027dc <= 00007101\n', '');
    expect(checkP7Probe(missingDeassertMarker, parseSimOutput(missingDeassertMarker), metadata).failures
      .some((failure) => failure.message.includes('pre-handler DM'))).toBe(true);

    const wrongRecord = [
      ...protocolCommits,
      ...recordLines(0, [p7ProbeMagic, 1, 2, 0x1c03, 0x80000400, 0x3024, 0x0400, 0x3060])
    ].join('\n');
    expect(checkP7Probe(wrongRecord, parseSimOutput(wrongRecord), metadata).failures
      .some((failure) => failure.message.includes('record 1') && failure.message.includes('wait branch'))).toBe(true);
  });

  it('rejects the Mode-1 stale-IRQ failure marker emitted before fresh arming', () => {
    const metadata: P7ProbeMetadata = {
      ...baseMetadata,
      scenarios: [baseMetadata.scenarios[1]]
    };
    const sim = [
      '9@000041d0: *000027dc <= bad10001',
      ...recordLines(0, [p7ProbeMagic, 2, 2, 0x1c03, 0x0400, 0x3040, 0, 0])
    ].join('\n');

    const result = checkP7Probe(sim, parseSimOutput(sim), metadata);

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.kind === 'timer' && failure.message.includes('stale IRQ'))).toBe(true);
  });

  it('checks one-shot timer CTRL/COUNT before the handler clears CTRL', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      shard: 'timer',
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [{
        id: 1,
        kind: 'timer0',
        expectedIpMask: 0x0400,
        allowedEpc: [0x3020],
        donePc: 0x3028,
        expectedRecords: [{
          expectedIpMask: 0x0400,
          expectedExcCode: 0,
          allowedEpc: [0x3020],
          allowedAuxPairs: [[8, 0]],
          auxPairDescription: 'Timer0 one-shot CTRL/COUNT before handler clear'
        }]
      }]
    };
    const valid = recordLines(0, [p7ProbeMagic, 1, 2, 0x1c03, 0x0400, 0x3020, 8, 0]).join('\n');
    const maskedByHandlerClear = recordLines(0, [p7ProbeMagic, 1, 2, 0x1c03, 0x0400, 0x3020, 0, 0]).join('\n');

    expect(checkP7Probe(valid, parseSimOutput(valid), metadata).passed).toBe(true);
    expect(checkP7Probe(maskedByHandlerClear, parseSimOutput(maskedByHandlerClear), metadata).failures
      .some((failure) => failure.message.includes('one-shot'))).toBe(true);
  });

  it('preserves historical HI/LO expectations and checks post-handler completion', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [{
        id: 1,
        kind: 'syscall',
        expectedIpMask: 0,
        expectedExcCode: 8,
        expectedBd: false,
        allowedEpc: [0x3020],
        victimPc: 0x3020,
        donePc: 0x3028,
        expectedRecords: [{
          expectedIpMask: 0,
          expectedExcCode: 8,
          expectedBd: false,
          allowedEpc: [0x3020],
          allowedAuxPairs: [[0x13579bdf, 0x2468ace0]]
        }],
        requireCompletion: true
      }]
    };
    const valid = [
      ...recordLines(0, [p7ProbeMagic, 1, 7, 0x1c03, 0x20, 0x3020, 0x13579bdf, 0x2468ace0]),
      '20@00003028: $1 <= 00000001'
    ].join('\n');
    expect(checkP7Probe(valid, parseSimOutput(valid), metadata).passed).toBe(true);

    const wrongHi = valid.replace('13579bdf', '0000003f');
    expect(checkP7Probe(wrongHi, parseSimOutput(wrongHi), metadata).failures
      .some((failure) => failure.message.includes('HI/LO'))).toBe(true);

    const earlyCompletion = [
      '1@00003028: $1 <= 00000001',
      ...recordLines(0, [p7ProbeMagic, 1, 7, 0x1c03, 0x20, 0x3020, 0x13579bdf, 0x2468ace0])
    ].join('\n');
    expect(checkP7Probe(earlyCompletion, parseSimOutput(earlyCompletion), metadata).failures
      .some((failure) => failure.message.includes('before the final'))).toBe(true);
  });

  it('rejects Timer register side effects observed only by handler read-back', () => {
    const countMetadata: P7ProbeMetadata = {
      version: 1,
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [{
        id: 1,
        kind: 'ades',
        expectedIpMask: 0,
        expectedExcCode: 5,
        expectedBd: false,
        allowedEpc: [0x3020],
        victimPc: 0x3020,
        donePc: 0x3024,
        expectedRecords: [{
          expectedIpMask: 0,
          expectedExcCode: 5,
          expectedBd: false,
          allowedEpc: [0x3020],
          auxPairDescription: 'Timer0 COUNT before/after invalid store',
          requireEqualAuxPair: true
        }]
      }]
    };
    const stableCount = recordLines(0, [p7ProbeMagic, 1, 6, 0x1c03, 0x14, 0x3020, 0x37, 0x37]).join('\n');
    expect(checkP7Probe(stableCount, parseSimOutput(stableCount), countMetadata).passed).toBe(true);

    const changedCount = stableCount.replace(/00000037$/, '2468ace6');
    const changedResult = checkP7Probe(changedCount, parseSimOutput(changedCount), countMetadata);
    expect(changedResult.passed).toBe(false);
    expect(changedResult.failures.some((failure) =>
      failure.message.includes('Timer0 COUNT') && failure.message.includes('changed across the exception'))).toBe(true);

    const presetMetadata: P7ProbeMetadata = {
      ...countMetadata,
      scenarios: [{
        ...countMetadata.scenarios[0],
        expectedRecords: [{
          expectedIpMask: 0,
          expectedExcCode: 5,
          expectedBd: false,
          allowedEpc: [0x3020],
          allowedAuxPairs: [[0x13579bdf, 0x13579bdf]],
          auxPairDescription: 'Timer1 PRESET before/after invalid store',
          requireEqualAuxPair: true
        }]
      }]
    };
    const wrongButStablePreset = recordLines(0, [
      p7ProbeMagic, 1, 6, 0x1c03, 0x14, 0x3020, 0x2468ace6, 0x2468ace6
    ]).join('\n');
    const presetResult = checkP7Probe(wrongButStablePreset, parseSimOutput(wrongButStablePreset), presetMetadata);
    expect(presetResult.passed).toBe(false);
    expect(presetResult.failures.some((failure) =>
      failure.message.includes('Timer1 PRESET') && failure.message.includes('observation differs'))).toBe(true);
  });

  it('rejects repeated record-field writes and invalid AdES output enables', () => {
    const metadata: P7ProbeMetadata = {
      version: 1,
      logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords,
      scenarios: [{
        id: 1,
        kind: 'ades',
        expectedIpMask: 0,
        expectedExcCode: 5,
        expectedBd: false,
        allowedEpc: [0x3020],
        victimPc: 0x3020,
        donePc: 0x3024
      }]
    };
    const lines = recordLines(0, [p7ProbeMagic, 1, 6, 0x1c03, 0x14, 0x3020, 0, 0]);
    const duplicateField = [...lines, lines[5]].join('\n');
    expect(checkP7Probe(duplicateField, parseSimOutput(duplicateField), metadata).failures
      .some((failure) => failure.message.includes('written more than once'))).toBe(true);

    const invalidEnable = [
      ...lines,
      'CO_P7_PROBE invalid_store_effect scenario=1 pc=00003020 data_byteen=f int_byteen=0 time=100'
    ].join('\n');
    expect(checkP7Probe(invalidEnable, parseSimOutput(invalidEnable), metadata).failures
      .some((failure) => failure.message.includes('invalid_store_effect'))).toBe(true);

    const outOfRange = [...lines, '20@00003020: *00003000 <= 12345678'].join('\n');
    expect(checkP7Probe(outOfRange, parseSimOutput(outOfRange), metadata).failures
      .some((failure) => failure.message.includes('exceeds the tutorial range'))).toBe(true);
  });
});

function recordLines(index: number, values: number[]): string[] {
  const base = p7ProbeLogBase + index * p7ProbeRecordWords * 4;
  return values.map((value, field) =>
    `10@00004180: *${(base + field * 4).toString(16).padStart(8, '0')} <= ${(value >>> 0).toString(16).padStart(8, '0')}`);
}
