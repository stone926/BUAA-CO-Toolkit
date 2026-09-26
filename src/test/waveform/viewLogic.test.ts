import { describe, expect, it } from 'vitest';
import { parseTimeScale } from '../../waveform/model/timeScale';
import { WaveformData } from '../../waveform/model/waveformData';
import { parseVcd } from '../../waveform/vcd/vcdReader';
import { CycleCounter } from '../../waveform/view/cycleCounter';
import { shortestUniqueNames } from '../../waveform/view/displayNames';
import { MarkerList, markerName } from '../../waveform/view/markers';
import { parseTimeInput } from '../../waveform/view/timeInput';
import {
  centerView,
  clampView,
  dataBounds,
  ensureVisible,
  panView,
  rangeView,
  timeToX,
  xToTime,
  zoomView
} from '../../waveform/view/viewport';
import { lowerBound, visitPoints, visitSegments } from '../../waveform/view/waveSegments';

function clockDump(periods: number): WaveformData {
  const lines = ['$timescale 1ps $end', '$scope module tb $end', '$var reg 1 ! clk $end', '$var reg 8 " n [7:0] $end', '$enddefinitions $end'];
  for (let index = 0; index <= periods * 2; index++) {
    lines.push(`#${index * 5}`, `${index % 2}!`);
    if (index % 2 === 0) {
      lines.push(`b${(index / 2).toString(2)} "`);
    }
  }
  return parseVcd(lines.join('\n'));
}

describe('viewport math', () => {
  const bounds = dataBounds(0, 1000);

  it('keeps a degenerate dump viewable', () => {
    expect(dataBounds(7, 7)).toEqual({ start: 7, end: 9 });
  });

  it('zooms around an anchor without moving it on screen', () => {
    const view = { start: 0, end: 1000 };
    const zoomed = zoomView(view, 4, 500, bounds);
    expect(zoomed).toEqual({ start: 375, end: 625 });
    const anchorBefore = timeToX(view, 1000, 250);
    const around = zoomView(view, 2, 250, bounds);
    expect(timeToX(around, 1000, 250)).toBeCloseTo(anchorBefore);
  });

  it('clamps span and position with a small overscroll margin', () => {
    expect(clampView({ start: -5000, end: -4000 }, bounds)).toEqual({ start: -50, end: 950 });
    expect(clampView({ start: 0, end: 1 }, bounds)).toEqual({ start: 0, end: 2 });
    const wide = clampView({ start: -1e9, end: 1e9 }, bounds);
    expect(wide.end - wide.start).toBeCloseTo(1100);
    // The overscroll margin scales with the visible span.
    expect(panView({ start: 0, end: 100 }, 10_000, bounds)).toEqual({ start: 905, end: 1005 });
  });

  it('turns drags, reveals and centering into views', () => {
    expect(rangeView(600, 200, bounds)).toEqual({ start: 200, end: 600 });
    expect(ensureVisible({ start: 0, end: 100 }, 50, bounds)).toEqual({ start: 0, end: 100 });
    expect(ensureVisible({ start: 0, end: 100 }, 300, bounds)).toEqual({ start: 210, end: 310 });
    expect(centerView({ start: 0, end: 100 }, 500, bounds)).toEqual({ start: 450, end: 550 });
    expect(xToTime({ start: 100, end: 200 }, 50, 25)).toBe(150);
  });
});

describe('cycle counting', () => {
  it('counts rising edges and navigates between them', () => {
    const data = clockDump(4);
    const cycles = new CycleCounter(data.tracks, data.vars[0].track);
    // Rising edges at 5, 15, 25, 35.
    expect(cycles.totalCycles).toBe(4);
    expect(cycles.cycleAt(4)).toBe(0);
    expect(cycles.cycleAt(5)).toBe(1);
    expect(cycles.cycleAt(24)).toBe(2);
    expect(cycles.edgeTime(3)).toBe(25);
    expect(cycles.edgeTime(9)).toBeUndefined();
    expect(cycles.nextEdge(5)).toBe(15);
    expect(cycles.previousEdge(15)).toBe(5);
    expect(cycles.previousEdge(16)).toBe(15);
    expect(cycles.cyclesBetween(5, 35)).toBe(3);
    expect(cycles.edgesInRange(0, 30, 10)).toEqual([5, 15, 25]);
    expect(cycles.edgesInRange(0, 40, 2)).toEqual([]);
  });
});

describe('segment traversal', () => {
  it('emits every wide segment and folds sub-pixel runs into dense bands', () => {
    const data = clockDump(1000);
    const track = data.vars[0].track;
    const values: Array<[number, number, number]> = [];
    const dense: Array<[number, number]> = [];
    visitSegments(data.tracks, track, { start: 0, end: 100 }, 100, data.endTime, {
      value: (x0, x1, index) => values.push([x0, x1, index]),
      dense: (x0, x1) => dense.push([x0, x1])
    });
    expect(values.slice(0, 3)).toEqual([[0, 5, 0], [5, 10, 1], [10, 15, 2]]);
    expect(dense).toEqual([]);

    let emitted = 0;
    const bands: Array<[number, number]> = [];
    visitSegments(data.tracks, track, { start: 0, end: 10_000 }, 200, data.endTime, {
      value: () => emitted++,
      dense: (x0, x1) => bands.push([x0, x1])
    });
    // 2000 changes squeeze into 200 columns: work stays bounded by the width.
    expect(emitted).toBeLessThanOrEqual(2);
    expect(bands.length).toBe(1);
    expect(bands[0][0]).toBe(0);
    expect(bands[0][1]).toBeGreaterThanOrEqual(199);
  });

  it('does not draw before the first change or after the dump ends', () => {
    const data = parseVcd('$timescale 1ps $end\n$scope module t $end\n$var wire 1 ! a $end\n$enddefinitions $end\n#50\n1!\n#80\n0!\n');
    const values: Array<[number, number]> = [];
    visitSegments(data.tracks, data.vars[0].track, { start: 0, end: 200 }, 200, data.endTime, {
      value: (x0, x1) => values.push([x0, x1]),
      dense: () => undefined
    });
    expect(values).toEqual([[50, 80]]);
  });

  it('groups sorted points by pixel column', () => {
    const times = new Float64Array([1, 2, 3, 50, 99, 150]);
    expect(lowerBound(times, 3)).toBe(2);
    expect(lowerBound(times, 1000)).toBe(6);
    const columns: Array<[number, number, number]> = [];
    visitPoints(times, { start: 0, end: 100 }, 10, (x, first, last) => columns.push([x, first, last]));
    expect(columns).toEqual([[0.1, 0, 2], [5, 3, 3], [9.9, 4, 4]]);
  });
});

describe('markers', () => {
  it('keeps labels when other markers are removed and reuses the smallest free one', () => {
    const markers = new MarkerList();
    const placed = [10, 20, 30].map((time) => markers.add(time));
    expect(placed.map(markerName)).toEqual(['M1', 'M2', 'M3']);
    expect(markers.remove(2)).toBe(true);
    expect(markers.all.map(markerName)).toEqual(['M1', 'M3']);
    expect(markers.remove(2)).toBe(false);
    expect(markerName(markers.add(40))).toBe('M2');
  });

  it('reuses a marker at the same time and keeps the label when one is moved', () => {
    const markers = new MarkerList();
    markers.add(10);
    markers.add(20);
    expect(markers.add(10).label).toBe(1);
    expect(markers.size).toBe(2);
    expect(markers.active?.label).toBe(1);
    expect(markers.move(2, 25)).toBe(true);
    expect(markers.active).toEqual({ time: 25, label: 2 });
    expect(markers.move(7, 30)).toBe(false);
  });

  it('measures against the nearest remaining marker when the active one is removed', () => {
    const markers = new MarkerList();
    [10, 50, 30].forEach((time) => markers.add(time));
    markers.activate(2);
    markers.remove(1);
    expect(markers.active?.label).toBe(2);
    markers.remove(2);
    expect(markers.active).toEqual({ time: 30, label: 3 });
    markers.clear();
    expect(markers.size).toBe(0);
    expect(markers.active).toBeUndefined();
  });

  it('finds markers near a time and steps between them in time order', () => {
    const markers = new MarkerList();
    [30, 10, 20].forEach((time) => markers.add(time));
    expect(markers.nearest(12)?.label).toBe(2);
    // Equally close: the later-placed marker is drawn on top, so it wins.
    expect(markers.nearest(15)?.label).toBe(3);
    expect(markers.nearest(15, 4)).toBeUndefined();
    expect(markers.adjacent(10, 1)?.time).toBe(20);
    expect(markers.adjacent(20, -1)?.time).toBe(10);
    expect(markers.adjacent(25, 1)?.time).toBe(30);
    expect(markers.adjacent(30, 1)).toBeUndefined();
    expect(markers.adjacent(10, -1)).toBeUndefined();
  });

  it('restores saved markers inside the dump, numbering unlabeled and repeated ones', () => {
    const markers = new MarkerList();
    markers.restore([{ time: 5 }, { time: 10, label: 1 }, { time: 99, label: 4 }, { time: 20, label: 1 }, { time: 30, label: 3 }], 0, 40);
    const restored = [{ time: 5, label: 2 }, { time: 10, label: 1 }, { time: 20, label: 4 }, { time: 30, label: 3 }];
    expect(markers.all).toEqual(restored);
    expect(markers.active?.label).toBe(2);
    expect(markers.toPersisted()).toEqual(restored);
    markers.retain(0, 15);
    expect(markers.all.map(markerName)).toEqual(['M2', 'M1']);
    markers.restore([], 0, 40);
    expect(markers.size).toBe(0);
  });
});

describe('time input', () => {
  const ps = parseTimeScale('1ps')!;

  it('accepts physical times, raw ticks and cycle numbers', () => {
    expect(parseTimeInput('474ns', ps, 'ns')).toEqual({ kind: 'time', ticks: 474_000 });
    expect(parseTimeInput(' 1.5 µs ', ps, 'ns')).toEqual({ kind: 'time', ticks: 1_500_000 });
    expect(parseTimeInput('474', ps, 'ns')).toEqual({ kind: 'time', ticks: 474_000 });
    expect(parseTimeInput('474 ns', ps, 'us')).toEqual({ kind: 'time', ticks: 474_000 });
    expect(parseTimeInput('#123', ps, 'ns')).toEqual({ kind: 'time', ticks: 123 });
    expect(parseTimeInput('c118', ps, 'ns')).toEqual({ kind: 'cycle', cycle: 118 });
    expect(parseTimeInput('周期 12', ps, 'ns')).toEqual({ kind: 'cycle', cycle: 12 });
    expect(parseTimeInput('cycle 3', ps, 'ns')).toEqual({ kind: 'cycle', cycle: 3 });
  });

  it('rejects anything else', () => {
    expect(parseTimeInput('', ps, 'ns')).toBeUndefined();
    expect(parseTimeInput('12 parsecs', ps, 'ns')).toBeUndefined();
    expect(parseTimeInput('abc', ps, 'ns')).toBeUndefined();
  });
});

describe('display names', () => {
  it('adds the shortest scope prefix that disambiguates duplicated leaves', () => {
    expect(shortestUniqueNames([
      'tb.clk',
      'tb.uut.CPU.FDreg.clk',
      'tb.uut.CPU.DEreg.clk',
      'tb.uut.CPU.FDreg.D_ins',
      'tb.uut.CPU.FDreg.D_ins'
    ])).toEqual([
      { prefix: 'tb.', leaf: 'clk' },
      { prefix: 'FDreg.', leaf: 'clk' },
      { prefix: 'DEreg.', leaf: 'clk' },
      { prefix: '', leaf: 'D_ins' },
      { prefix: '', leaf: 'D_ins' }
    ]);
  });
});
