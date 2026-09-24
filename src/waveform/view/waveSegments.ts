// @index waveform-segments — 渲染用 LOD 遍历：按像素列合并亚像素跳变为密集带，稀疏值段逐段输出；有序时间点按列聚合

import { changeCount, changeIndexAt, changeTime } from '../model/signalValues';
import type { WaveTracks } from '../model/waveformData';
import type { TimeRange } from './viewport';

export interface SegmentSink {
  /** Change `index` holds from x0 to x1 (pixels; may extend past the canvas edges). */
  value(x0: number, x1: number, index: number): void;
  /** Several changes squeezed into [x0, x1): draw a busy band. */
  dense(x0: number, x1: number): void;
}

/**
 * Walk the visible part of one track. Work is bounded by the number of visible
 * value segments at least one pixel wide plus the number of pixel columns, so a
 * fully zoomed-out 100k-edge clock costs no more than the canvas width.
 * Nothing is emitted before the first change or after `dataEnd`.
 */
export function visitSegments(
  tracks: WaveTracks,
  track: number,
  view: TimeRange,
  width: number,
  dataEnd: number,
  sink: SegmentSink
): void {
  const count = changeCount(tracks, track);
  const span = view.end - view.start;
  if (count === 0 || width <= 0 || span <= 0) {
    return;
  }
  const pixelsPerTick = width / span;
  const limit = Math.min(view.end, dataEnd);
  let index = Math.max(0, changeIndexAt(tracks, track, view.start));
  let denseStart = Number.NaN;
  let denseEnd = Number.NaN;
  while (index < count) {
    const start = Math.max(changeTime(tracks, track, index), view.start);
    if (start >= limit) {
      break;
    }
    const next = index + 1 < count ? changeTime(tracks, track, index + 1) : dataEnd;
    const end = Math.min(next, limit);
    const x0 = (start - view.start) * pixelsPerTick;
    const x1 = (end - view.start) * pixelsPerTick;
    if (x1 - x0 >= 1 || index + 1 >= count) {
      if (!Number.isNaN(denseStart)) {
        sink.dense(denseStart, Math.max(x0, denseEnd));
        denseStart = Number.NaN;
      }
      if (end > start) {
        sink.value(x0, x1, index);
      }
      index++;
      continue;
    }
    // Sub-pixel segment: extend a dense run to the end of this pixel column and
    // resume from the last change inside it.
    if (Number.isNaN(denseStart)) {
      denseStart = x0;
    }
    const columnEnd = Math.floor(x0) + 1;
    denseEnd = columnEnd;
    const jump = changeIndexAt(tracks, track, view.start + columnEnd / pixelsPerTick);
    index = Math.max(jump, index + 1);
  }
  if (!Number.isNaN(denseStart)) {
    sink.dense(denseStart, Math.min(denseEnd, (limit - view.start) * pixelsPerTick));
  }
}

/** First index in ascending `times` whose value is ≥ `time`. */
export function lowerBound(times: ArrayLike<number>, time: number, from = 0, to = times.length): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle] < time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Group ascending time points inside the view by pixel column. `sink` receives the
 * column's x and the inclusive index range of the points that fall into it.
 */
export function visitPoints(
  times: ArrayLike<number>,
  view: TimeRange,
  width: number,
  sink: (x: number, first: number, last: number) => void
): void {
  const span = view.end - view.start;
  if (width <= 0 || span <= 0 || times.length === 0) {
    return;
  }
  const pixelsPerTick = width / span;
  let index = lowerBound(times, view.start);
  while (index < times.length && times[index] <= view.end) {
    const x = (times[index] - view.start) * pixelsPerTick;
    const columnEndTime = view.start + (Math.floor(x) + 1) / pixelsPerTick;
    const next = Math.max(index + 1, lowerBound(times, columnEndTime, index + 1));
    sink(x, index, next - 1);
    index = next;
  }
}
