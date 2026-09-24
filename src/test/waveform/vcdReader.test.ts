import { describe, expect, it } from 'vitest';
import { changeCount, changeIndexAt, changeTime, nextChangeTime, previousChangeTime, valueState, ValueState } from '../../waveform/model/signalValues';
import { formatTrackValue } from '../../waveform/model/valueFormat';
import { TrackEncoding, WaveformData } from '../../waveform/model/waveformData';
import { VcdParser, VcdHandler } from '../../waveform/vcd/vcdParser';
import { VcdReader, parseVcd } from '../../waveform/vcd/vcdReader';

const header = `$date today $end
$version Icarus Verilog $end
$timescale 1ps $end
$scope module tb $end
$var reg 1 ! clk $end
$var wire 8 " data [7:0] $end
$var reg 32 # pc [31:0] $end
$var real 1 $ temperature $end
$var string 1 % state $end
$var parameter 6 & MULT $end
$scope module uut $end
$var wire 1 ! clk $end
$var wire 8 ' bus [7:0] $end
$upscope $end
$upscope $end
$enddefinitions $end
`;

function values(data: WaveformData, path: string, radix: 'hex' | 'bin' | 'udec' = 'hex'): Array<[number, string]> {
  const variable = data.vars.find((candidate) => candidate.path === path);
  expect(variable, path).toBeDefined();
  const track = variable!.track;
  return Array.from({ length: changeCount(data.tracks, track) }, (_, index) =>
    [changeTime(data.tracks, track, index), formatTrackValue(data.tracks, track, index, radix)] as [number, string]);
}

describe('VCD parsing', () => {
  it('reads header metadata, hierarchy, aliases and value changes', () => {
    const data = parseVcd(`${header}#0
$dumpvars
0!
bx "
b101 #
r1.5 $
sIDLE %
b1100 &
bz '
$end
#5
1!
b1010 "
#10
0!
r2.25 $
sRUN %
b00000001 '
`);
    expect(data.timescale).toMatchObject({ magnitude: 1, unit: 'ps' });
    expect(data.metadata).toMatchObject({ date: 'today', version: 'Icarus Verilog', incomplete: false });
    expect(data.scopes.map((scope) => scope.path)).toEqual(['tb', 'tb.uut']);
    expect(data.vars.map((variable) => variable.path)).toEqual([
      'tb.clk', 'tb.data', 'tb.pc', 'tb.temperature', 'tb.state', 'tb.MULT', 'tb.uut.clk', 'tb.uut.bus'
    ]);
    const clk = data.vars.find((variable) => variable.path === 'tb.clk')!;
    const aliasClk = data.vars.find((variable) => variable.path === 'tb.uut.clk')!;
    expect(aliasClk.track).toBe(clk.track);
    expect(values(data, 'tb.clk')).toEqual([[0, '0'], [5, '1'], [10, '0']]);
    expect(values(data, 'tb.data')).toEqual([[0, 'xx'], [5, '0a']]);
    expect(values(data, 'tb.pc')).toEqual([[0, '00000005']]);
    expect(values(data, 'tb.temperature')).toEqual([[0, '1.5'], [10, '2.25']]);
    expect(values(data, 'tb.state')).toEqual([[0, 'IDLE'], [10, 'RUN']]);
    expect(values(data, 'tb.uut.bus', 'bin')).toEqual([[0, 'zzzzzzzz'], [10, '00000001']]);
    expect(data.startTime).toBe(0);
    expect(data.endTime).toBe(10);
    expect(data.tracks.encoding[data.vars.find((variable) => variable.path === 'tb.temperature')!.track]).toBe(TrackEncoding.Real);
    expect(data.diagnostics).toEqual([]);
  });

  it('parses identically regardless of chunk boundaries', () => {
    const text = `${header}#0\n0!\nb10101010 "\n#7\n1!\nb1 "\n#9\nr-3e2 $\n`;
    const whole = parseVcd(text);
    const bytes = new TextEncoder().encode(text);
    const reader = new VcdReader();
    for (let offset = 0; offset < bytes.length; offset += 3) {
      reader.push(bytes.subarray(offset, offset + 3));
    }
    const chunked = reader.finish();
    for (const variable of whole.vars) {
      expect(values(chunked, variable.path)).toEqual(values(whole, variable.path));
    }
    expect(values(whole, 'tb.temperature')).toEqual([[9, '-300']]);
  });

  it('merges duplicate scope blocks produced by per-word $dumpvars and keeps memory words', () => {
    const data = parseVcd(`$timescale 1ns $end
$scope module tb $end
$scope module grf $end
$var reg 32 ! x [31:0] $end
$upscope $end
$upscope $end
$scope module tb $end
$scope module grf $end
$var reg 32 " \\regs[0] [31:0] $end
$upscope $end
$upscope $end
$scope module tb $end
$scope module grf $end
$var reg 32 # \\regs[1] [31:0] $end
$var reg 32 ! x [31:0] $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
b0 !
b11 "
b100 #
`);
    expect(data.scopes.map((scope) => scope.path)).toEqual(['tb', 'tb.grf']);
    expect(data.vars.map((variable) => variable.name)).toEqual(['x', 'regs[0]', 'regs[1]']);
    expect(data.vars[1]).toMatchObject({ path: 'tb.grf.regs[0]', range: '[31:0]', msb: 31, lsb: 0, width: 32 });
    expect(values(data, 'tb.grf.regs[1]')).toEqual([[0, '00000004']]);
    expect(data.timescale).toMatchObject({ magnitude: 1, unit: 'ns' });
  });

  it('left-extends short vectors per IEEE 1364 and truncates overlong ones', () => {
    const data = parseVcd(`$timescale 10 ps $end
$scope module t $end
$var wire 8 a v [7:0] $end
$enddefinitions $end
#0
b1 a
#1
bx1 a
#2
bz a
#3
b111100001 a
`);
    expect(values(data, 't.v', 'bin')).toEqual([
      [0, '00000001'],
      [1, 'xxxxxxx1'],
      [2, 'zzzzzzzz'],
      [3, '11100001']
    ]);
    expect(data.timescale.femtoseconds).toBe(10_000);
    expect(data.diagnostics.some((diagnostic) => diagnostic.message.includes('截断'))).toBe(true);
  });

  it('drops repeated values and lets the last write at one timestamp win', () => {
    const data = parseVcd(`$timescale 1ps $end
$scope module t $end
$var reg 4 a v [3:0] $end
$enddefinitions $end
#0
b0001 a
#1
b0001 a
#2
b0010 a
b0001 a
#3
b0100 a
b1000 a
`);
    expect(values(data, 't.v')).toEqual([[0, '1'], [3, '8']]);
    expect(data.metadata.changeCount).toBe(2);
  });

  it('decodes wide vectors and four-state states', () => {
    const wide = `b1${'0'.repeat(63)}x`;
    const data = parseVcd(`$timescale 1ps $end
$scope module t $end
$var reg 65 a w [64:0] $end
$var reg 4 b m [3:0] $end
$enddefinitions $end
#0
${wide} a
b1z0x b
#1
b${'1'.repeat(65)} a
bzzzz b
`);
    const variable = data.vars.find((candidate) => candidate.name === 'w')!;
    expect(data.tracks.wordsPerValue[variable.track]).toBe(3);
    expect(formatTrackValue(data.tracks, variable.track, 1, 'udec')).toBe((2n ** 65n - 1n).toString());
    expect(formatTrackValue(data.tracks, variable.track, 1, 'hex')).toBe('1ffffffffffffffff');
    expect(formatTrackValue(data.tracks, variable.track, 0, 'hex')).toBe('1000000000000000X');
    const mixed = data.vars.find((candidate) => candidate.name === 'm')!;
    expect(valueState(data.tracks, mixed.track, 0)).toBe(ValueState.Mixed);
    expect(valueState(data.tracks, mixed.track, 1)).toBe(ValueState.AllHighZ);
    expect(formatTrackValue(data.tracks, mixed.track, 0, 'bin')).toBe('1z0x');
  });

  it('reports unusable input instead of throwing', () => {
    const data = parseVcd(`$timescale 3 ps $end
$scope module t $end
$var wire 1 ! a $end
$enddefinitions $end
#0
1!
1?
q!
#-4
#20
0!
#10
1!
`);
    const messages = data.diagnostics.map((diagnostic) => diagnostic.message).join('\n');
    expect(messages).toContain('$timescale');
    expect(messages).toContain('未声明的 id');
    expect(messages).toContain('无法识别的值变化');
    expect(messages).toContain('时间戳倒退');
    expect(messages).toContain('无法解析时间');
    expect(data.timescale.unit).toBe('ps');
    // After the backwards #10 the change lands on #20, where it cancels the 0 written there.
    expect(values(data, 't.a')).toEqual([[0, '1']]);
  });

  it('flags truncated files and bounds recorded changes', () => {
    const truncatedHeader = parseVcd('$timescale 1ps $end\n$scope module t $end\n$var wire 1 ! a');
    expect(truncatedHeader.metadata.incomplete).toBe(true);
    expect(truncatedHeader.diagnostics.some((diagnostic) => diagnostic.message.includes('$enddefinitions'))).toBe(true);

    const midValue = parseVcd('$timescale 1ps $end\n$scope module t $end\n$var wire 4 ! a [3:0] $end\n$enddefinitions $end\n#0\nb1010');
    expect(midValue.metadata.incomplete).toBe(true);

    const limited = parseVcd(`$timescale 1ps $end
$scope module t $end
$var wire 1 ! a $end
$enddefinitions $end
#0
0!
#1
1!
#2
0!
#3
1!
`, { maximumChanges: 2 });
    expect(limited.metadata.changeCount).toBe(2);
    expect(limited.diagnostics.some((diagnostic) => diagnostic.message.includes('上限'))).toBe(true);
  });

  it('skips comments and dump control keywords in the body', () => {
    const data = parseVcd(`$timescale 1ps $end
$scope module t $end
$var wire 1 ! a $end
$enddefinitions $end
$comment Show the parameter values. $end
#0
$dumpvars 0! $end
#4
$comment not a value 1! $end
$dumpoff x! $end
#8
$dumpon 1! $end
`);
    expect(values(data, 't.a')).toEqual([[0, '0'], [4, 'x'], [8, '1']]);
  });

  it('offers binary-search navigation over change times', () => {
    const data = parseVcd(`$timescale 1ps $end
$scope module t $end
$var wire 1 ! a $end
$enddefinitions $end
#10
0!
#20
1!
#30
0!
`);
    const track = data.vars[0].track;
    expect(changeIndexAt(data.tracks, track, 5)).toBe(-1);
    expect(changeIndexAt(data.tracks, track, 20)).toBe(1);
    expect(changeIndexAt(data.tracks, track, 29)).toBe(1);
    expect(nextChangeTime(data.tracks, track, 20)).toBe(30);
    expect(nextChangeTime(data.tracks, track, 30)).toBeUndefined();
    expect(previousChangeTime(data.tracks, track, 20)).toBe(10);
    expect(previousChangeTime(data.tracks, track, 25)).toBe(20);
    expect(previousChangeTime(data.tracks, track, 10)).toBeUndefined();
  });

  it('streams tokens to a handler without building a model', () => {
    const seen: string[] = [];
    const handler: VcdHandler = {
      headerCommand: (command, body) => seen.push(`${command}(${body.join(' ')})`),
      endDefinitions: () => seen.push('end'),
      time: (value) => seen.push(`#${value}`),
      vector: (id, bits, start, end) => seen.push(`${id}=${String.fromCharCode(...bits.subarray(start, end))}`),
      real: (id, value) => seen.push(`${id}=r${value}`),
      text: (id, value) => seen.push(`${id}=s${value}`),
      diagnostic: (message) => seen.push(`!${message}`)
    };
    const parser = new VcdParser(handler);
    parser.push(new TextEncoder().encode('$scope module a $end $enddefinitions $end #1 1% b01 & R0.5 ( S中文 )'));
    expect(parser.end()).toEqual({ incomplete: false, headerComplete: true });
    expect(seen).toEqual(['$scope(module a)', 'end', '#1', '%=1', '&=01', '(=r0.5', ')=s中文']);
  });
});
