// @index waveform-viewport — 时间视窗数学：适配全程、以锚点缩放、平移、区间放大、确保可见与像素↔tick 换算

export interface TimeRange {
  readonly start: number;
  readonly end: number;
}

/** Smallest visible span in ticks; dumps cannot resolve finer than one tick anyway. */
export const minimumViewSpan = 2;
/** Fraction of the view that may extend past either end of the data. */
const overscroll = 0.05;

/** Data bounds that always have a positive span, even for empty or single-timestamp dumps. */
export function dataBounds(startTime: number, endTime: number): TimeRange {
  return { start: startTime, end: Math.max(endTime, startTime + minimumViewSpan) };
}

export function viewSpan(view: TimeRange): number {
  return view.end - view.start;
}

export function fitView(bounds: TimeRange): TimeRange {
  return { start: bounds.start, end: bounds.end };
}

/** Keep the span within limits and the window overlapping the data. */
export function clampView(view: TimeRange, bounds: TimeRange): TimeRange {
  const dataSpan = viewSpan(bounds);
  const maximumSpan = dataSpan * (1 + 2 * overscroll);
  let span = Math.min(Math.max(viewSpan(view), minimumViewSpan), maximumSpan);
  if (!Number.isFinite(span) || span <= 0) {
    span = dataSpan;
  }
  const margin = span * overscroll;
  let start = Number.isFinite(view.start) ? view.start : bounds.start;
  start = Math.min(start, bounds.end + margin - span);
  start = Math.max(start, bounds.start - margin);
  return { start, end: start + span };
}

/** Zoom by `factor` (>1 zooms in) keeping `anchor` at the same screen position. */
export function zoomView(view: TimeRange, factor: number, anchor: number, bounds: TimeRange): TimeRange {
  const span = viewSpan(view);
  const nextSpan = span / factor;
  const ratio = span > 0 ? (anchor - view.start) / span : 0.5;
  const start = anchor - ratio * nextSpan;
  return clampView({ start, end: start + nextSpan }, bounds);
}

export function panView(view: TimeRange, deltaTicks: number, bounds: TimeRange): TimeRange {
  return clampView({ start: view.start + deltaTicks, end: view.end + deltaTicks }, bounds);
}

export function rangeView(from: number, to: number, bounds: TimeRange): TimeRange {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  return clampView({ start, end: Math.max(end, start + minimumViewSpan) }, bounds);
}

/** Pan the minimum amount so `time` lies inside the view with `marginFraction` of padding. */
export function ensureVisible(view: TimeRange, time: number, bounds: TimeRange, marginFraction = 0.1): TimeRange {
  const span = viewSpan(view);
  const margin = span * marginFraction;
  if (time >= view.start + margin && time <= view.end - margin) {
    return view;
  }
  const start = time < view.start + margin ? time - margin : time + margin - span;
  return clampView({ start, end: start + span }, bounds);
}

export function centerView(view: TimeRange, time: number, bounds: TimeRange): TimeRange {
  const span = viewSpan(view);
  return clampView({ start: time - span / 2, end: time + span / 2 }, bounds);
}

export function timeToX(view: TimeRange, width: number, time: number): number {
  return ((time - view.start) * width) / viewSpan(view);
}

export function xToTime(view: TimeRange, width: number, x: number): number {
  return view.start + (x * viewSpan(view)) / Math.max(width, 1);
}
