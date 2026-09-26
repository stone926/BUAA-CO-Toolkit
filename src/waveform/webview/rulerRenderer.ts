// @index waveform-webview-ruler — 时间标尺绘制：自适应刻度与单位、时钟周期序号、trace 事件刻痕、标记/游标旗标与 Δ 测量

import { chooseTickStep, formatTicks, timeUnitFemtoseconds } from '../model/timeScale';
import { markerName } from '../view/markers';
import { lowerBound, visitPoints } from '../view/waveSegments';
import { timeToX, TimeRange } from '../view/viewport';
import type { WaveStore } from './store';
import { Palette, withAlpha } from './theme';
import { snap } from './waveRenderer';

export const rulerHeight = 36;
const labelFont = 11;
const cycleFont = 10;

export interface RulerOverlay {
  readonly dragRange?: { readonly x0: number; readonly x1: number };
}

export function renderRuler(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  width: number,
  palette: Palette,
  store: WaveStore,
  overlay: RulerOverlay
): void {
  const height = rulerHeight;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = palette.rulerBackground;
  ctx.fillRect(0, 0, width, height);
  const data = store.data;
  if (!data) {
    return;
  }
  const view = store.view;
  const scale = data.timescale;
  const ticksPerPixel = (view.end - view.start) / Math.max(1, width);
  const step = chooseTickStep(ticksPerPixel, 90, scale);
  const unitScale = timeUnitFemtoseconds(step.unit);
  const stepInUnit = (step.major * scale.femtoseconds) / unitScale;
  const digits = Math.max(0, Math.ceil(-Math.log10(stepInUnit) + 1e-9));

  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.gridStrong;
  ctx.beginPath();
  const minor = step.major / step.minorCount;
  const firstMinor = Math.ceil(view.start / minor) * minor;
  for (let time = firstMinor; time <= view.end; time += minor) {
    const x = snap(timeToX(view, width, time), dpr);
    const isMajor = Math.abs(time / step.major - Math.round(time / step.major)) < 1e-6;
    ctx.moveTo(x, isMajor ? height - 12 : height - 5);
    ctx.lineTo(x, height);
  }
  ctx.stroke();

  ctx.font = `${labelFont}px ${palette.uiFamily}`;
  const flags: Flag[] = [];
  for (const marker of store.markers.all) {
    const x = timeToX(view, width, marker.time);
    if (x >= -20 && x <= width + 20) {
      flags.push(layoutFlag(ctx, width, x, markerName(marker), palette.marker));
    }
  }
  const cursorX = timeToX(view, width, store.cursor);
  if (cursorX >= -1 && cursorX <= width + 1) {
    flags.push(layoutFlag(ctx, width, cursorX, formatTicks(store.cursor, scale), palette.cursor));
  }
  ctx.textBaseline = 'middle';
  ctx.fillStyle = palette.dim;
  for (let time = Math.ceil(view.start / step.major) * step.major; time <= view.end; time += step.major) {
    const x = timeToX(view, width, time);
    const label = formatTicks(time, scale, { unit: step.unit, maximumFractionDigits: digits });
    const right = x + 4 + ctx.measureText(label).width;
    // Flags win over the tick label they would overlap.
    if (!flags.some((flag) => x + 1 < flag.left + flag.width + 3 && right + 3 > flag.left)) {
      ctx.fillText(label, x + 4, 10);
    }
  }

  drawCycleNumbers(ctx, width, palette, store, view);
  drawTraceTicks(ctx, width, palette, store, view);

  ctx.strokeStyle = palette.gridStrong;
  ctx.beginPath();
  ctx.moveTo(0, height - 0.5);
  ctx.lineTo(width, height - 0.5);
  ctx.stroke();

  drawMeasurement(ctx, width, palette, store, view);
  if (overlay.dragRange) {
    drawDragRange(ctx, width, palette, store, view, overlay.dragRange);
  }
  for (const flag of flags) {
    drawFlag(ctx, flag, palette);
  }
}

function drawCycleNumbers(ctx: CanvasRenderingContext2D, width: number, palette: Palette, store: WaveStore, view: TimeRange): void {
  const cycles = store.cycles;
  if (!cycles) {
    return;
  }
  const edges = cycles.edgesInRange(view.start, view.end, Math.floor(width / 26));
  if (edges.length < 2) {
    return;
  }
  const spacing = timeToX(view, width, edges[1]) - timeToX(view, width, edges[0]);
  const every = spacing >= 26 ? 1 : 0;
  if (!every) {
    return;
  }
  ctx.font = `${cycleFont}px ${palette.uiFamily}`;
  ctx.fillStyle = withAlpha(palette.dim, 0.85);
  ctx.textAlign = 'center';
  const firstCycle = cycles.cycleAt(edges[0]);
  edges.forEach((edge, index) => {
    ctx.fillText(String(firstCycle + index), timeToX(view, width, edge), 22);
  });
  ctx.textAlign = 'left';
}

function drawTraceTicks(ctx: CanvasRenderingContext2D, width: number, palette: Palette, store: WaveStore, view: TimeRange): void {
  const index = store.traceIndex;
  if (!index) {
    return;
  }
  const draw = (times: Float64Array, color: string, y: number): void => {
    ctx.fillStyle = color;
    visitPoints(times, view, width, (x) => {
      ctx.fillRect(Math.round(x) - 0.5, y, 2, 3);
    });
  };
  draw(index.grf, palette.traceGrf, rulerHeight - 8);
  draw(index.dm, palette.traceDm, rulerHeight - 4);
}

function drawMeasurement(ctx: CanvasRenderingContext2D, width: number, palette: Palette, store: WaveStore, view: TimeRange): void {
  const marker = store.markers.active;
  if (marker === undefined || marker.time === store.cursor || !store.data) {
    return;
  }
  const from = Math.min(marker.time, store.cursor);
  const to = Math.max(marker.time, store.cursor);
  const x0 = timeToX(view, width, from);
  const x1 = timeToX(view, width, to);
  if (x1 < 0 || x0 > width) {
    return;
  }
  const y = 24.5;
  ctx.strokeStyle = palette.marker;
  ctx.beginPath();
  ctx.moveTo(Math.max(x0, 0), y);
  ctx.lineTo(Math.min(x1, width), y);
  ctx.stroke();
  const label = measurementLabel(store, from, to);
  drawCenteredTag(ctx, width, (Math.max(x0, 0) + Math.min(x1, width)) / 2, y, label, palette.marker, palette);
}

function drawDragRange(
  ctx: CanvasRenderingContext2D,
  width: number,
  palette: Palette,
  store: WaveStore,
  view: TimeRange,
  range: { readonly x0: number; readonly x1: number }
): void {
  const x0 = Math.min(range.x0, range.x1);
  const x1 = Math.max(range.x0, range.x1);
  ctx.fillStyle = withAlpha(palette.cursor, 0.18);
  ctx.fillRect(x0, 0, x1 - x0, rulerHeight);
  const from = view.start + (x0 / width) * (view.end - view.start);
  const to = view.start + (x1 / width) * (view.end - view.start);
  drawCenteredTag(ctx, width, (x0 + x1) / 2, 24.5, measurementLabel(store, from, to), palette.cursor, palette);
}

/** `Δ 12 ns · 3 周期` between two times. */
export function measurementLabel(store: WaveStore, from: number, to: number): string {
  const delta = formatTicks(Math.round(to - from), store.data!.timescale);
  const cycles = store.cycles ? store.cycles.cyclesBetween(from, to) : undefined;
  return cycles !== undefined ? `Δ ${delta} · ${cycles} 周期` : `Δ ${delta}`;
}

function drawCenteredTag(ctx: CanvasRenderingContext2D, width: number, center: number, y: number, text: string, color: string, palette: Palette): void {
  ctx.font = `${cycleFont}px ${palette.uiFamily}`;
  const textWidth = ctx.measureText(text).width;
  const boxWidth = textWidth + 10;
  const left = Math.min(Math.max(center - boxWidth / 2, 1), width - boxWidth - 1);
  ctx.fillStyle = palette.rulerBackground;
  roundRect(ctx, left, y - 7, boxWidth, 14, 3);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + 5, y + 0.5);
}

interface Flag {
  readonly x: number;
  readonly left: number;
  readonly width: number;
  readonly text: string;
  readonly color: string;
}

const flagTop = 2;

/** Measure a flag (expects the label font to be set) and keep it inside the ruler. */
function layoutFlag(ctx: CanvasRenderingContext2D, width: number, x: number, text: string, color: string): Flag {
  const boxWidth = ctx.measureText(text).width + 10;
  return { x, left: Math.min(Math.max(x - boxWidth / 2, 0), width - boxWidth), width: boxWidth, text, color };
}

function drawFlag(ctx: CanvasRenderingContext2D, flag: Flag, palette: Palette): void {
  ctx.font = `${labelFont}px ${palette.uiFamily}`;
  ctx.fillStyle = flag.color;
  roundRect(ctx, flag.left, flagTop, flag.width, 15, 3);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(flag.x - 3.5, flagTop + 15);
  ctx.lineTo(flag.x + 3.5, flagTop + 15);
  ctx.lineTo(flag.x, flagTop + 19);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = palette.cursorText;
  ctx.textBaseline = 'middle';
  ctx.fillText(flag.text, flag.left + 5, flagTop + 8);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/** Trace events per pixel column across the whole dump, for the overview. */
export function traceDensity(times: Float64Array, start: number, end: number, width: number): Uint16Array {
  const counts = new Uint16Array(Math.max(1, Math.ceil(width)));
  const span = Math.max(1, end - start);
  let index = lowerBound(times, start);
  for (; index < times.length && times[index] <= end; index++) {
    const column = Math.min(counts.length - 1, Math.floor(((times[index] - start) / span) * width));
    if (counts[column] < 65535) {
      counts[column]++;
    }
  }
  return counts;
}
