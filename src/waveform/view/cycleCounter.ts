// @index waveform-cycles — 时钟上升沿前缀计数：任意时刻的周期序号、上/下一个上升沿与两时刻间周期数

import { BitLevel, bitLevel, changeCount, changeIndexAt, changeTime } from '../model/signalValues';
import type { WaveTracks } from '../model/waveformData';

export class CycleCounter {
  /** risingBefore[i] = rising edges among changes 0..i of the clock track. */
  private readonly rising: Uint32Array;
  private readonly count: number;

  constructor(private readonly tracks: WaveTracks, private readonly track: number) {
    this.count = changeCount(tracks, track);
    this.rising = new Uint32Array(this.count);
    let edges = 0;
    let previous: BitLevel | undefined;
    for (let index = 0; index < this.count; index++) {
      const level = bitLevel(tracks, track, index);
      if (level === BitLevel.One && previous !== undefined && previous !== BitLevel.One) {
        edges++;
      }
      this.rising[index] = edges;
      previous = level;
    }
  }

  get totalCycles(): number {
    return this.count ? this.rising[this.count - 1] : 0;
  }

  /** Number of rising edges at or before `time`. */
  cycleAt(time: number): number {
    const index = changeIndexAt(this.tracks, this.track, time);
    return index >= 0 ? this.rising[index] : 0;
  }

  cyclesBetween(from: number, to: number): number {
    return Math.abs(this.cycleAt(to) - this.cycleAt(from));
  }

  /** Time of rising edge number `cycle` (1-based), if it exists. */
  edgeTime(cycle: number): number | undefined {
    if (cycle < 1 || cycle > this.totalCycles) {
      return undefined;
    }
    let low = 0;
    let high = this.count - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.rising[middle] >= cycle) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    return changeTime(this.tracks, this.track, low);
  }

  nextEdge(time: number): number | undefined {
    return this.edgeTime(this.cycleAt(time) + 1);
  }

  previousEdge(time: number): number | undefined {
    const cycle = this.cycleAt(time);
    const edge = this.edgeTime(cycle);
    if (edge !== undefined && edge < time) {
      return edge;
    }
    return this.edgeTime(cycle - 1);
  }

  /** Rising edges within [from, to], for drawing a cycle grid; empty when more than `limit`. */
  edgesInRange(from: number, to: number, limit: number): number[] {
    const first = this.cycleAt(from) + 1;
    const last = this.cycleAt(to);
    if (last - first + 1 > limit) {
      return [];
    }
    const edges: number[] = [];
    for (let cycle = first; cycle <= last; cycle++) {
      const time = this.edgeTime(cycle);
      if (time !== undefined) {
        edges.push(time);
      }
    }
    return edges;
  }
}
