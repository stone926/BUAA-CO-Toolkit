// @index waveform-webview-renderer — 波形画布绘制：单比特阶梯线/事件脉冲/总线六边形/四态 x z/密集带、折叠分组活动、网格与周期线、游标/标记/测量/框选叠加

import type { Radix } from '../model/radix';
import { BitLevel, bitLevel, valueState, ValueState } from '../model/signalValues';
import type { TimeScale } from '../model/timeScale';
import { chooseTickStep } from '../model/timeScale';
import { formatTrackValue } from '../model/valueFormat';
import { TrackEncoding, WaveformData } from '../model/waveformData';
import { visitPoints, visitSegments } from '../view/waveSegments';
import type { TimeRange } from '../view/viewport';
import { timeToX } from '../view/viewport';
import type { GroupRow, SignalRow, VisibleRow } from '../view/waveRows';
import { rowHeight } from './actions';
import type { WaveStore } from './store';
import { Palette, withAlpha } from './theme';

export const waveFontSize = 12;
const levelInset = 5;
const busSlope = 3.5;
const minimumLabelPixels = 14;

export interface WaveOverlay {
  /** Pointer x for the hover guide line, when hovering. */
  readonly hoverX?: number;
  /** Rubber-band range selection in pixels. */
  readonly dragRange?: { readonly x0: number; readonly x1: number };
}

export interface WaveRenderContext {
  readonly ctx: CanvasRenderingContext2D;
  readonly dpr: number;
  readonly width: number;
  readonly height: number;
  readonly palette: Palette;
  readonly charWidth: number;
}

export function waveFont(palette: Palette): string {
  return `${waveFontSize}px ${palette.monoFamily}`;
}

/** Draw the whole waveform canvas for the rows currently scrolled into view. */
export function renderWaves(context: WaveRenderContext, store: WaveStore, rows: readonly VisibleRow[], overlay: WaveOverlay): void {
  const { ctx, width, height, palette } = context;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);
  const data = store.data;
  if (!data) {
    return;
  }
  const first = Math.max(0, Math.floor(store.scrollTop / rowHeight));
  const last = Math.min(rows.length - 1, Math.floor((store.scrollTop + height) / rowHeight));

  for (let index = first; index <= last; index++) {
    const top = index * rowHeight - store.scrollTop;
    const row = rows[index].row;
    if (index % 2 === 1) {
      ctx.fillStyle = palette.rowStripe;
      ctx.fillRect(0, top, width, rowHeight);
    }
    if (store.selection.has(row.id)) {
      ctx.fillStyle = withAlpha(palette.cursor, palette.dark ? 0.1 : 0.08);
      ctx.fillRect(0, top, width, rowHeight);
    }
  }
  drawGrid(context, store, data.timescale);
  drawMeasureBand(context, store);

  ctx.font = waveFont(palette);
  ctx.textBaseline = 'middle';
  for (let index = first; index <= last; index++) {
    const top = index * rowHeight - store.scrollTop;
    const row = rows[index].row;
    if (row.kind === 'group') {
      if (row.collapsed) {
        drawGroupActivity(context, store, data, row, top);
      }
      continue;
    }
    drawSignalRow(context, store, data, row, top);
  }
  drawOverlays(context, store, overlay);
}

function signalColor(palette: Palette, row: SignalRow): string {
  return palette.rowColors[row.color ?? 0] ?? palette.rowColors[0];
}

function drawSignalRow(context: WaveRenderContext, store: WaveStore, data: WaveformData, row: SignalRow, top: number): void {
  const { ctx, palette, width } = context;
  if (row.varIndex < 0) {
    ctx.fillStyle = palette.dim;
    ctx.fillText('（当前波形中没有此信号）', 8, top + rowHeight / 2);
    return;
  }
  const variable = data.vars[row.varIndex];
  const track = variable.track;
  const encoding = data.tracks.encoding[track];
  if (variable.kind === 'event') {
    drawEventTrack(context, store, data, track, top, signalColor(palette, row));
  } else if (encoding === TrackEncoding.Bits && data.tracks.width[track] === 1) {
    drawBitTrack(context, store, data, track, top, signalColor(palette, row));
  } else {
    drawBusTrack(context, store, data, track, top, signalColor(palette, row), row.radix);
  }
  void width;
}

/** Named events have no level: every change is one trigger, drawn as an upward arrow. */
function drawEventTrack(context: WaveRenderContext, store: WaveStore, data: WaveformData, track: number, top: number, color: string): void {
  const { ctx, width, dpr } = context;
  const high = snap(top + levelInset, dpr);
  const low = snap(top + rowHeight - levelInset, dpr);
  const arrows = new Path2D();
  const times = data.tracks.times.subarray(data.tracks.changeStart[track], data.tracks.changeStart[track + 1]);
  visitPoints(times, store.view, width, (x) => {
    const column = snap(x, dpr);
    arrows.moveTo(column, low);
    arrows.lineTo(column, high);
    arrows.moveTo(column - 3, high + 4);
    arrows.lineTo(column, high);
    arrows.lineTo(column + 3, high + 4);
  });
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.stroke(arrows);
}

function drawBitTrack(context: WaveRenderContext, store: WaveStore, data: WaveformData, track: number, top: number, color: string): void {
  const { ctx, palette, width, dpr } = context;
  const high = snap(top + levelInset, dpr);
  const low = snap(top + rowHeight - levelInset, dpr);
  const middle = snap(top + rowHeight / 2, dpr);
  const line = new Path2D();
  const highFill = new Path2D();
  const unknownFill = new Path2D();
  const unknownLine = new Path2D();
  const highZLine = new Path2D();
  const dense = new Path2D();
  let previousY: number | undefined;
  let previousEnd = Number.NaN;
  visitSegments(data.tracks, track, store.view, width, data.endTime, {
    value(x0, x1, index) {
      const left = snap(Math.max(x0, -2), dpr);
      const right = snap(Math.min(x1, width + 2), dpr);
      const level = bitLevel(data.tracks, track, index);
      const y = level === BitLevel.One ? high : level === BitLevel.Zero ? low : middle;
      const joined = previousY !== undefined && Math.abs(previousEnd - x0) < 0.01;
      if (level === BitLevel.Unknown) {
        unknownFill.rect(left, high, right - left, low - high);
        unknownLine.moveTo(left, high);
        unknownLine.lineTo(right, high);
        unknownLine.moveTo(left, low);
        unknownLine.lineTo(right, low);
        if (joined) {
          unknownLine.moveTo(left, high);
          unknownLine.lineTo(left, low);
        }
      } else if (level === BitLevel.HighZ) {
        if (joined && previousY !== middle) {
          highZLine.moveTo(left, previousY!);
          highZLine.lineTo(left, middle);
        }
        highZLine.moveTo(left, middle);
        highZLine.lineTo(right, middle);
      } else {
        if (joined && previousY !== y) {
          line.moveTo(left, previousY!);
          line.lineTo(left, y);
        } else {
          line.moveTo(left, y);
        }
        line.lineTo(right, y);
        if (level === BitLevel.One) {
          highFill.rect(left, high, right - left, low - high);
        }
      }
      previousY = level === BitLevel.Unknown ? undefined : y;
      previousEnd = x1;
    },
    dense(x0, x1) {
      dense.rect(Math.max(x0, -2), high, Math.max(1, Math.min(x1, width + 2) - Math.max(x0, -2)), low - high);
      previousY = undefined;
      previousEnd = x1;
    }
  });
  ctx.fillStyle = withAlpha(color, palette.dark ? 0.13 : 0.12);
  ctx.fill(highFill);
  ctx.fillStyle = withAlpha(color, 0.42);
  ctx.fill(dense);
  ctx.fillStyle = withAlpha(palette.unknown, 0.28);
  ctx.fill(unknownFill);
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.stroke(line);
  ctx.strokeStyle = palette.unknown;
  ctx.stroke(unknownLine);
  ctx.strokeStyle = palette.highZ;
  ctx.stroke(highZLine);
}

function drawBusTrack(
  context: WaveRenderContext,
  store: WaveStore,
  data: WaveformData,
  track: number,
  top: number,
  color: string,
  radix: Radix
): void {
  const { ctx, palette, width, dpr, charWidth } = context;
  const high = snap(top + levelInset, dpr);
  const low = snap(top + rowHeight - levelInset, dpr);
  const middle = snap(top + rowHeight / 2, dpr);
  const textY = top + rowHeight / 2 + 0.5;
  const known = new Path2D();
  const unknown = new Path2D();
  const highZ = new Path2D();
  const dense = new Path2D();
  const labels: Array<{ x: number; text: string; kind: ValueState }> = [];
  visitSegments(data.tracks, track, store.view, width, data.endTime, {
    value(x0, x1, index) {
      const state = valueState(data.tracks, track, index);
      const left = Math.max(x0, -busSlope - 2);
      const right = Math.min(x1, width + busSlope + 2);
      const slope = Math.min(busSlope, (x1 - x0) / 2);
      if (state === ValueState.AllHighZ) {
        highZ.moveTo(snap(left, dpr), middle);
        highZ.lineTo(snap(right, dpr), middle);
      } else {
        const path = state === ValueState.Known ? known : unknown;
        const l = snap(left, dpr);
        const r = snap(right, dpr);
        path.moveTo(l, middle);
        path.lineTo(l + slope, high);
        path.lineTo(r - slope, high);
        path.lineTo(r, middle);
        path.lineTo(r - slope, low);
        path.lineTo(l + slope, low);
        path.closePath();
      }
      // Keep labels readable when a long segment starts left of the view.
      const labelLeft = Math.max(x0 + slope + 3, 3);
      const available = Math.min(x1, width) - slope - 3 - labelLeft;
      if (available >= minimumLabelPixels) {
        const text = fitText(formatTrackValue(data.tracks, track, index, radix), available, charWidth);
        if (text) {
          labels.push({ x: labelLeft, text, kind: state });
        }
      }
    },
    dense(x0, x1) {
      const left = Math.max(x0, -2);
      dense.rect(left, high, Math.max(1, Math.min(x1, width + 2) - left), low - high);
    }
  });
  ctx.lineWidth = 1;
  ctx.fillStyle = withAlpha(color, palette.dark ? 0.12 : 0.1);
  ctx.fill(known);
  ctx.strokeStyle = color;
  ctx.stroke(known);
  ctx.fillStyle = withAlpha(palette.unknown, 0.24);
  ctx.fill(unknown);
  ctx.strokeStyle = palette.unknown;
  ctx.stroke(unknown);
  ctx.fillStyle = withAlpha(color, 0.38);
  ctx.fill(dense);
  ctx.strokeStyle = palette.highZ;
  ctx.stroke(highZ);
  for (const label of labels) {
    if (label.kind === ValueState.AllHighZ) {
      const textWidth = label.text.length * charWidth;
      ctx.fillStyle = palette.background;
      ctx.fillRect(label.x - 2, high + 1, textWidth + 4, low - high - 2);
      ctx.fillStyle = palette.highZ;
    } else {
      ctx.fillStyle = label.kind === ValueState.Known ? palette.foreground : palette.unknown;
    }
    ctx.fillText(label.text, label.x, textY);
  }
}

/** Collapsed group: short ticks wherever any member changes. */
function drawGroupActivity(context: WaveRenderContext, store: WaveStore, data: WaveformData, group: GroupRow, top: number): void {
  const { ctx, palette, width } = context;
  const columns = new Uint8Array(Math.ceil(width) + 1);
  const busy = new Path2D();
  const ticks = new Path2D();
  const middle = top + rowHeight / 2;
  for (const child of group.children) {
    if (child.varIndex < 0) {
      continue;
    }
    const track = data.vars[child.varIndex].track;
    visitSegments(data.tracks, track, store.view, width, data.endTime, {
      value(x0) {
        const column = Math.round(x0);
        if (x0 > 0 && column < columns.length && !columns[column]) {
          columns[column] = 1;
          ticks.moveTo(column + 0.5, middle - 4);
          ticks.lineTo(column + 0.5, middle + 4);
        }
      },
      dense(x0, x1) {
        busy.rect(Math.max(0, x0), middle - 4, Math.max(1, x1 - Math.max(0, x0)), 8);
      }
    });
  }
  ctx.strokeStyle = withAlpha(palette.foreground, 0.12);
  ctx.beginPath();
  ctx.moveTo(0, snap(middle, context.dpr));
  ctx.lineTo(width, snap(middle, context.dpr));
  ctx.stroke();
  ctx.fillStyle = withAlpha(palette.dim, 0.35);
  ctx.fill(busy);
  ctx.strokeStyle = withAlpha(palette.dim, 0.9);
  ctx.stroke(ticks);
}

function drawGrid(context: WaveRenderContext, store: WaveStore, scale: TimeScale): void {
  const { ctx, width, height, palette, dpr } = context;
  const view = store.view;
  const ticksPerPixel = (view.end - view.start) / Math.max(1, width);
  const step = chooseTickStep(ticksPerPixel, 90, scale);
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.grid;
  ctx.beginPath();
  for (let time = Math.ceil(view.start / step.major) * step.major; time <= view.end; time += step.major) {
    const x = snap(timeToX(view, width, time), dpr);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  ctx.stroke();
  const cycles = store.cycles;
  if (!cycles) {
    return;
  }
  const edges = cycles.edgesInRange(view.start, view.end, Math.floor(width / 8));
  if (!edges.length) {
    return;
  }
  ctx.strokeStyle = palette.gridStrong;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  for (const edge of edges) {
    const x = snap(timeToX(view, width, edge), dpr);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawMeasureBand(context: WaveRenderContext, store: WaveStore): void {
  const marker = store.markers.active;
  if (marker === undefined) {
    return;
  }
  const { ctx, width, height, palette } = context;
  const x0 = timeToX(store.view, width, Math.min(marker.time, store.cursor));
  const x1 = timeToX(store.view, width, Math.max(marker.time, store.cursor));
  if (x1 < 0 || x0 > width) {
    return;
  }
  ctx.fillStyle = withAlpha(palette.marker, palette.dark ? 0.07 : 0.06);
  ctx.fillRect(Math.max(0, x0), 0, Math.min(width, x1) - Math.max(0, x0), height);
}

function drawOverlays(context: WaveRenderContext, store: WaveStore, overlay: WaveOverlay): void {
  const { ctx, width, height, palette, dpr } = context;
  const view: TimeRange = store.view;
  if (overlay.hoverX !== undefined && !overlay.dragRange) {
    ctx.strokeStyle = withAlpha(palette.foreground, 0.4);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    const x = snap(overlay.hoverX, dpr);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const active = store.markers.active;
  for (const marker of store.markers.all) {
    const x = timeToX(view, width, marker.time);
    if (x < -1 || x > width + 1) {
      continue;
    }
    const isActive = marker.label === active?.label;
    ctx.strokeStyle = palette.marker;
    ctx.lineWidth = isActive ? 1.5 : 1;
    ctx.setLineDash(isActive ? [] : [5, 3]);
    ctx.beginPath();
    ctx.moveTo(snap(x, dpr), 0);
    ctx.lineTo(snap(x, dpr), height);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const cursorX = timeToX(view, width, store.cursor);
  if (cursorX >= -1 && cursorX <= width + 1) {
    ctx.strokeStyle = palette.cursor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(snap(cursorX, dpr), 0);
    ctx.lineTo(snap(cursorX, dpr), height);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  if (overlay.dragRange) {
    const x0 = Math.min(overlay.dragRange.x0, overlay.dragRange.x1);
    const x1 = Math.max(overlay.dragRange.x0, overlay.dragRange.x1);
    ctx.fillStyle = withAlpha(palette.cursor, 0.13);
    ctx.fillRect(x0, 0, x1 - x0, height);
    ctx.strokeStyle = withAlpha(palette.cursor, 0.7);
    ctx.beginPath();
    ctx.moveTo(snap(x0, dpr), 0);
    ctx.lineTo(snap(x0, dpr), height);
    ctx.moveTo(snap(x1, dpr), 0);
    ctx.lineTo(snap(x1, dpr), height);
    ctx.stroke();
  }
}

/** Truncate to the pixel budget of a monospace font; returns '' when nothing useful fits. */
export function fitText(text: string, available: number, charWidth: number): string {
  const capacity = Math.floor(available / charWidth);
  if (capacity <= 0) {
    return '';
  }
  if (text.length <= capacity) {
    return text;
  }
  return capacity >= 2 ? `${text.slice(0, capacity - 1)}…` : '';
}

/** Align a 1-CSS-px line to device pixels for crisp rendering. */
export function snap(value: number, dpr: number): number {
  const devicePixels = Math.round(dpr);
  const offset = devicePixels % 2 === 1 ? 0.5 : 0;
  return (Math.round(value * dpr - offset) + offset) / dpr;
}
