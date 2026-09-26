// @index waveform-webview-overview — 全程缩略条：trace 写入密度、当前视窗框、游标与标记；拖动视窗框平移、点击定位、滚轮缩放

import { timeToX, viewSpan, xToTime } from '../view/viewport';
import type { WaveActions } from './actions';
import { fitCanvas, listen } from './dom';
import { traceDensity } from './rulerRenderer';
import type { WaveStore } from './store';
import { Palette, withAlpha } from './theme';
import { snap } from './waveRenderer';

export const overviewHeight = 26;

export class Overview {
  readonly element: HTMLCanvasElement;
  private width = 0;
  private density: { grf: Uint16Array; dm: Uint16Array; width: number; trace: unknown } | undefined;

  constructor(private readonly store: WaveStore, private readonly actions: WaveActions, private readonly palette: () => Palette) {
    this.element = document.createElement('canvas');
    this.element.className = 'overview';
    this.element.title = '全程缩略图：拖动蓝框平移，点击定位，滚轮缩放';
    listen(this.element, 'pointerdown', (event) => this.onPointerDown(event));
    listen(this.element, 'wheel', (event) => {
      event.preventDefault();
      const time = xToTime(this.store.bounds, this.width, event.offsetX);
      this.actions.zoom(event.deltaY < 0 ? 1.25 : 0.8, time);
    }, { passive: false });
  }

  resize(width: number): void {
    this.width = width;
  }

  render(): void {
    const { ctx, dpr } = fitCanvas(this.element, this.width, overviewHeight);
    const palette = this.palette();
    const width = this.width;
    ctx.clearRect(0, 0, width, overviewHeight);
    ctx.fillStyle = palette.rulerBackground;
    ctx.fillRect(0, 0, width, overviewHeight);
    const bounds = this.store.bounds;
    const trace = this.store.traceIndex;
    if (trace) {
      if (!this.density || this.density.width !== width || this.density.trace !== trace) {
        this.density = {
          grf: traceDensity(trace.grf, bounds.start, bounds.end, width),
          dm: traceDensity(trace.dm, bounds.start, bounds.end, width),
          width,
          trace
        };
      }
      const maximum = Math.max(1, ...this.density.grf, ...this.density.dm);
      const bar = (counts: Uint16Array, color: string, bottom: number, heightLimit: number): void => {
        ctx.fillStyle = color;
        counts.forEach((count, column) => {
          if (count) {
            const h = Math.max(1.5, (Math.log1p(count) / Math.log1p(maximum)) * heightLimit);
            ctx.fillRect(column, bottom - h, 1, h);
          }
        });
      };
      bar(this.density.grf, withAlpha(palette.traceGrf, 0.75), overviewHeight / 2, overviewHeight / 2 - 3);
      bar(this.density.dm, withAlpha(palette.traceDm, 0.75), overviewHeight - 2, overviewHeight / 2 - 3);
    }
    const view = this.store.view;
    const x0 = timeToX(bounds, width, view.start);
    const x1 = timeToX(bounds, width, view.end);
    const left = Math.max(0, x0);
    const right = Math.min(width, Math.max(x1, x0 + 3));
    ctx.fillStyle = withAlpha(palette.cursor, 0.16);
    ctx.fillRect(left, 0, right - left, overviewHeight);
    ctx.strokeStyle = withAlpha(palette.cursor, 0.85);
    ctx.lineWidth = 1;
    ctx.strokeRect(snap(left, dpr), 0.5, Math.max(1, snap(right, dpr) - snap(left, dpr)), overviewHeight - 1);
    ctx.strokeStyle = palette.marker;
    for (const marker of this.store.markers.all) {
      const x = snap(timeToX(bounds, width, marker.time), dpr);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, overviewHeight);
      ctx.stroke();
    }
    const cursor = snap(timeToX(bounds, width, this.store.cursor), dpr);
    ctx.strokeStyle = palette.cursor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cursor, 0);
    ctx.lineTo(cursor, overviewHeight);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = palette.gridStrong;
    ctx.beginPath();
    ctx.moveTo(0, 0.5);
    ctx.lineTo(width, 0.5);
    ctx.stroke();
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.store.data) {
      return;
    }
    event.preventDefault();
    const bounds = this.store.bounds;
    const view = this.store.view;
    const clickTime = xToTime(bounds, this.width, event.offsetX);
    const span = viewSpan(view);
    let offset: number;
    if (clickTime >= view.start && clickTime <= view.end) {
      offset = clickTime - view.start;
    } else {
      offset = span / 2;
      this.actions.setView({ start: clickTime - offset, end: clickTime - offset + span });
    }
    this.element.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      const time = xToTime(bounds, this.width, moveEvent.offsetX);
      this.actions.setView({ start: time - offset, end: time - offset + span });
    };
    const up = (): void => {
      this.element.removeEventListener('pointermove', move);
      this.element.removeEventListener('pointerup', up);
      this.element.removeEventListener('pointercancel', up);
    };
    this.element.addEventListener('pointermove', move);
    this.element.addEventListener('pointerup', up);
    this.element.addEventListener('pointercancel', up);
  }
}
