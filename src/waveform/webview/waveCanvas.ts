// @index waveform-webview-canvas — 波形画布交互：点击放游标（吸附跳变）、拖动框选放大、拖动游标/标记、右键菜单（带指针下的标记）、中键平移、Ctrl+滚轮缩放、悬停值提示

import { radixLabels } from '../model/radix';
import { changeCount, changeIndexAt, changeTime } from '../model/signalValues';
import { formatTicks } from '../model/timeScale';
import { formatTrackValue } from '../model/valueFormat';
import { markerName, type WaveMarker } from '../view/markers';
import { timeToX, xToTime } from '../view/viewport';
import type { VisibleRow } from '../view/waveRows';
import { rowHeight, WaveActions } from './actions';
import { fitCanvas } from './dom';
import { measurementLabel } from './rulerRenderer';
import type { WaveStore } from './store';
import type { Palette } from './theme';
import { Tooltip, TooltipLine } from './tooltip';
import { renderWaves, waveFont, WaveOverlay } from './waveRenderer';

const grabPixels = 4;
const dragThreshold = 3;

export interface CanvasCallbacks {
  /** `marker` is the marker line under the pointer, if any. */
  readonly onContextMenu: (event: MouseEvent, rowId: number | undefined, time: number, marker: WaveMarker | undefined) => void;
  /** Range selection changed (for the ruler's Δ tag); undefined when it ends. */
  readonly onDragRange: (range: { x0: number; x1: number } | undefined) => void;
}

type DragMode =
  | { kind: 'pending'; startX: number; startY: number; rowId: number | undefined; additive: boolean }
  | { kind: 'range'; startX: number; currentX: number }
  | { kind: 'cursor' }
  | { kind: 'marker'; label: number }
  | { kind: 'pan'; lastX: number };

export class WaveCanvas {
  readonly element: HTMLCanvasElement;
  private width = 0;
  private height = 0;
  private rows: readonly VisibleRow[] = [];
  private hoverX: number | undefined;
  private drag: DragMode | undefined;
  private charWidth = 7;
  private charWidthFont = '';
  /** Range being dragged on the ruler, mirrored in the waveform area. */
  externalRange: (() => { x0: number; x1: number } | undefined) | undefined;

  constructor(
    private readonly store: WaveStore,
    private readonly actions: WaveActions,
    private readonly palette: () => Palette,
    private readonly tooltip: Tooltip,
    private readonly callbacks: CanvasCallbacks
  ) {
    this.element = document.createElement('canvas');
    this.element.className = 'wave-canvas';
    this.element.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.element.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.element.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.element.addEventListener('pointercancel', () => this.cancelDrag());
    this.element.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.hoverX = undefined;
        this.tooltip.hide();
        this.store.invalidate('waves');
      }
    });
    this.element.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const time = this.timeAt(event.offsetX);
      this.callbacks.onContextMenu(event, this.rowAt(event.offsetY), time, this.actions.nearestMarker(time, grabPixels));
    });
    this.element.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
      }
    });
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  get canvasWidth(): number {
    return this.width;
  }

  render(rows: readonly VisibleRow[]): void {
    this.rows = rows;
    const { ctx, dpr } = fitCanvas(this.element, this.width, this.height);
    const palette = this.palette();
    const font = waveFont(palette);
    if (font !== this.charWidthFont) {
      ctx.font = font;
      this.charWidth = ctx.measureText('0123456789abcdef').width / 16 || 7;
      this.charWidthFont = font;
    }
    const overlay: WaveOverlay = {
      hoverX: this.hoverX,
      dragRange: this.drag?.kind === 'range' ? { x0: this.drag.startX, x1: this.drag.currentX } : this.externalRange?.()
    };
    renderWaves({ ctx, dpr, width: this.width, height: this.height, palette, charWidth: this.charWidth }, this.store, rows, overlay);
  }

  /** Cancel an in-progress drag (Escape). Returns true when one was active. */
  cancelDrag(): boolean {
    if (!this.drag) {
      return false;
    }
    const wasRange = this.drag.kind === 'range';
    this.drag = undefined;
    this.element.classList.remove('panning');
    if (wasRange) {
      this.callbacks.onDragRange(undefined);
    }
    this.store.invalidate('waves', 'ruler');
    return true;
  }

  private timeAt(x: number): number {
    return xToTime(this.store.view, this.width, x);
  }

  private rowAt(y: number): number | undefined {
    const index = Math.floor((y + this.store.scrollTop) / rowHeight);
    return this.rows[index]?.row.id;
  }

  private signalVarAt(y: number): number | undefined {
    const id = this.rowAt(y);
    const row = id !== undefined ? this.store.rows.find(id)?.row : undefined;
    return row?.kind === 'signal' && row.varIndex >= 0 ? row.varIndex : undefined;
  }

  private onPointerDown(event: PointerEvent): void {
    this.tooltip.hide();
    if (!this.store.data) {
      return;
    }
    if (event.button === 1) {
      event.preventDefault();
      this.drag = { kind: 'pan', lastX: event.offsetX };
      this.element.classList.add('panning');
      this.element.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) {
      return;
    }
    this.element.setPointerCapture(event.pointerId);
    const cursorX = timeToX(this.store.view, this.width, this.store.cursor);
    if (Math.abs(cursorX - event.offsetX) <= grabPixels) {
      this.drag = { kind: 'cursor' };
      return;
    }
    const marker = this.actions.nearestMarker(this.timeAt(event.offsetX), grabPixels);
    if (marker) {
      this.drag = { kind: 'marker', label: marker.label };
      return;
    }
    this.drag = {
      kind: 'pending',
      startX: event.offsetX,
      startY: event.offsetY,
      rowId: this.rowAt(event.offsetY),
      additive: event.ctrlKey || event.metaKey
    };
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) {
      this.hoverX = event.offsetX;
      this.store.hoverTime = this.timeAt(event.offsetX);
      this.store.invalidate('waves');
      this.element.style.cursor = this.hoverCursor(event.offsetX);
      this.tooltip.schedule(event.clientX, event.clientY, () => this.tooltipLines(event.offsetX, event.offsetY));
      return;
    }
    this.tooltip.hide();
    switch (drag.kind) {
      case 'pending':
        if (Math.abs(event.offsetX - drag.startX) > dragThreshold) {
          this.drag = { kind: 'range', startX: drag.startX, currentX: event.offsetX };
          this.callbacks.onDragRange({ x0: drag.startX, x1: event.offsetX });
          this.store.invalidate('waves', 'ruler');
        }
        return;
      case 'range':
        drag.currentX = Math.max(0, Math.min(this.width, event.offsetX));
        this.callbacks.onDragRange({ x0: drag.startX, x1: drag.currentX });
        this.store.invalidate('waves', 'ruler');
        return;
      case 'cursor':
        this.actions.setCursor(this.actions.snapTime(this.timeAt(event.offsetX), this.signalVarAt(event.offsetY)));
        return;
      case 'marker':
        this.actions.moveMarker(drag.label, this.actions.snapTime(this.timeAt(event.offsetX), this.signalVarAt(event.offsetY)));
        return;
      case 'pan':
        this.actions.panPixels(drag.lastX - event.offsetX);
        drag.lastX = event.offsetX;
        return;
    }
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = undefined;
    this.element.classList.remove('panning');
    if (!drag) {
      return;
    }
    if (drag.kind === 'pending') {
      if (drag.rowId !== undefined) {
        this.actions.select(drag.rowId, drag.additive ? 'toggle' : 'replace');
      }
      const varIndex = event.altKey ? undefined : this.signalVarAt(drag.startY);
      this.actions.setCursor(this.actions.snapTime(this.timeAt(drag.startX), varIndex));
    } else if (drag.kind === 'range') {
      this.callbacks.onDragRange(undefined);
      const from = this.timeAt(Math.min(drag.startX, drag.currentX));
      const to = this.timeAt(Math.max(drag.startX, drag.currentX));
      if (Math.abs(drag.currentX - drag.startX) > dragThreshold) {
        this.actions.zoomToRange(from, to);
      }
      this.store.invalidate('waves', 'ruler');
    }
  }

  private onWheel(event: WheelEvent): void {
    if (!this.store.data) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0022));
      this.actions.zoom(factor, this.timeAt(event.offsetX));
      return;
    }
    const horizontal = event.shiftKey ? event.deltaY : event.deltaX;
    if (horizontal !== 0 && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
      event.preventDefault();
      this.actions.panPixels(horizontal * (event.deltaMode === 1 ? 20 : 1));
    }
    // Plain vertical wheel falls through to the rows viewport and scrolls rows.
  }

  private hoverCursor(x: number): string {
    const cursorX = timeToX(this.store.view, this.width, this.store.cursor);
    if (Math.abs(cursorX - x) <= grabPixels || this.actions.nearestMarker(this.timeAt(x), grabPixels)) {
      return 'ew-resize';
    }
    return 'crosshair';
  }

  private tooltipLines(x: number, y: number): readonly TooltipLine[] | undefined {
    const data = this.store.data;
    if (!data) {
      return undefined;
    }
    const time = Math.round(this.timeAt(x));
    const lines: TooltipLine[] = [];
    const id = this.rowAt(y);
    const row = id !== undefined ? this.store.rows.find(id)?.row : undefined;
    if (row?.kind === 'signal' && row.varIndex >= 0) {
      const variable = data.vars[row.varIndex];
      const track = variable.track;
      const index = changeIndexAt(data.tracks, track, time);
      lines.push({ value: variable.path, className: 'title' });
      if (variable.kind === 'event') {
        // Events have no level to hold: show the surrounding triggers instead.
        const next = index + 1 < changeCount(data.tracks, track) ? changeTime(data.tracks, track, index + 1) : undefined;
        lines.push({ label: '上次触发', value: index >= 0 ? formatTicks(changeTime(data.tracks, track, index), data.timescale) : '无' });
        lines.push({ label: '下次触发', value: next !== undefined ? formatTicks(next, data.timescale) : '无' });
      } else if (index >= 0) {
        lines.push({ label: radixLabels[row.radix], value: formatTrackValue(data.tracks, track, index, row.radix) });
        if (variable.width > 1 && row.radix !== 'hex') {
          lines.push({ label: radixLabels.hex, value: formatTrackValue(data.tracks, track, index, 'hex') });
        }
        if (variable.width > 1 && row.radix !== 'sdec' && row.radix !== 'udec') {
          lines.push({ label: radixLabels.udec, value: formatTrackValue(data.tracks, track, index, 'udec') });
        }
        const since = changeTime(data.tracks, track, index);
        const next = index + 1 < data.tracks.changeStart[track + 1] - data.tracks.changeStart[track]
          ? changeTime(data.tracks, track, index + 1)
          : undefined;
        lines.push({
          label: '保持',
          value: `${formatTicks(since, data.timescale)} → ${next !== undefined ? formatTicks(next, data.timescale) : '结束'}`
        });
      } else {
        lines.push({ value: '（尚无值）' });
      }
    }
    lines.push({ label: '时刻', value: formatTicks(time, data.timescale) + (this.store.cycles ? ` · 第 ${this.store.cycles.cycleAt(time)} 周期` : '') });
    if (time !== this.store.cursor) {
      lines.push({ label: '距游标', value: measurementLabel(this.store, Math.min(time, this.store.cursor), Math.max(time, this.store.cursor)) });
    }
    const marker = this.actions.nearestMarker(this.timeAt(x), grabPixels);
    if (marker) {
      lines.push({ label: `标记 ${markerName(marker)}`, value: '拖动可移动，右键可删除' });
    }
    return lines;
  }
}
