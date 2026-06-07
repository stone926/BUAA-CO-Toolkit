import { describe, expect, it } from 'vitest';
import { formatTraceEvent, parseCpuTraceLine, parseMarsOutput } from '../../../language/mips/traceParser';

describe('MIPS CPU trace parser', () => {
  it('parses P4 trace lines without cycle numbers', () => {
    const events = parseMarsOutput(`
MARS 4.5
@00003000: $03 <= 0000000a
@00003004: *00001004 <= 00000000
`);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      cycle: undefined,
      pc: '00003000',
      kind: 'grf',
      target: '3',
      value: '0000000A',
      lineNumber: 3
    });
    expect(events[1]).toMatchObject({
      pc: '00003004',
      kind: 'dm',
      target: '00001004',
      value: '00000000'
    });
  });

  it('parses P5/P6 trace lines with cycle numbers', () => {
    const event = parseCpuTraceLine('120@3004: *1004 <= 0', 7);

    expect(event).toMatchObject({
      cycle: 120,
      pc: '00003004',
      kind: 'dm',
      target: '00001004',
      value: '00000000',
      raw: '120@3004: *1004 <= 0',
      lineNumber: 7
    });
  });

  it('parses modified MARS coL1 register spacing', () => {
    const event = parseCpuTraceLine('@00003000: $ 1 <= 00000001');

    expect(event).toMatchObject({
      pc: '00003000',
      kind: 'grf',
      target: '1',
      value: '00000001'
    });
  });

  it('keeps unknown simulator values parseable for comparison reports', () => {
    const event = parseCpuTraceLine('140@00003008: $2 <= xxxxxxxx');

    expect(event).toBeDefined();
    expect(event?.value).toBe('XXXXXXXX');
  });

  it('formats normalized events back to the course trace shape', () => {
    const event = parseCpuTraceLine('@0x3000: $03 <= 0xa');

    expect(event).toBeDefined();
    expect(formatTraceEvent(event!)).toBe('@00003000: $3 <= 0000000A');
  });
});
