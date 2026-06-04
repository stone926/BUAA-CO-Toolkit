import { describe, expect, it } from 'vitest';
import { detectDisplayTraceFormats, parseSimOutput } from '../../../language/verilog/traceParser';

describe('Verilog simulator trace parser', () => {
  it('detects P4 and P5+ course display formats', () => {
    const formats = detectDisplayTraceFormats(`
module tb;
  initial begin
    $display("@%h: $%d <= %h", PC, A3, WD);
    $display("%d@%h: *%h <= %h", $time, PC, addr, data);
  end
endmodule
`);

    expect(formats).toEqual([
      { profile: 'P4', kind: 'grf', rawFormat: '@%h: $%d <= %h' },
      { profile: 'P5+', kind: 'dm', rawFormat: '%d@%h: *%h <= %h' }
    ]);
  });

  it('extracts trace events from ISim output mixed with tool logs', () => {
    const events = parseSimOutput(`
ISim log header
100@00003000: $3 <= 00000001
run: finished
120@00003004: *00001004 <= 00000002
`);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      cycle: 100,
      pc: '00003000',
      kind: 'grf',
      target: '3',
      value: '00000001'
    });
    expect(events[1]).toMatchObject({
      cycle: 120,
      kind: 'dm',
      target: '00001004'
    });
  });

  it('recognizes zero-padded display width specifiers used by stricter testbenches', () => {
    const formats = detectDisplayTraceFormats('$display("%0d@%08h: $%0d <= %08h", $time, pc, reg, data);');

    expect(formats).toEqual([
      { profile: 'P5+', kind: 'grf', rawFormat: '%0d@%08h: $%0d <= %08h' }
    ]);
  });
});
