// @index waveform-webview-ruler-view — 时间标尺交互：点击放游标、拖动框选放大、拖动标记、右键菜单（带旗标下的标记）、滚轮缩放、双击适配全部

import type { WaveMarker } from '../view/markers';
import { xToTime } from '../view/viewport';
import type { WaveActions } from './actions';
import { fitCanvas } from './dom';
import { renderRuler, rulerHeight } from './rulerRenderer';
import type { WaveStore } from './store';
import type { Palette } from './theme';

/** Roughly half a marker flag's width: how far from its line the flag can be grabbed. */
const flagGrabPixels = 12;

export class RulerView {
  readonly element: HTMLCanvasElement;
  private width = 0;
  private externalRange: { x0: number; x1: number } | undefined;
  private localRange: { x0: number; x1: number } | undefined;

  constructor(
    private readonly store: WaveStore,
    private readonly actions: WaveActions,
    private readonly palette: () => Palette,
    /** `marker` is the marker whose flag is under the pointer, if any. */
    private readonly onContextMenu: (event: MouseEvent, time: number, marker: WaveMarker | undefined) => void
  ) {
    this.element = document.createElement('canvas');
    this.element.className = 'ruler';
    this.element.title = '点击放置游标，拖动选择区间放大，双击显示全部；拖动标记旗标可移动标记，右键旗标可删除';
    this.element.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.element.addEventListener('wheel', (event) => {
      event.preventDefault();
      const factor = Math.exp(-(event.deltaY || event.deltaX) * (event.deltaMode === 1 ? 0.05 : 0.0022));
      this.actions.zoom(factor, xToTime(this.store.view, this.width, event.offsetX));
    }, { passive: false });
    this.element.addEventListener('dblclick', () => this.actions.zoomFit());
    this.element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.onContextMenu(event, xToTime(this.store.view, this.width, event.offsetX), this.markerAt(event.offsetX));
    });
  }

  resize(width: number): void {
    this.width = width;
  }

  /** Range selection from the waveform canvas, mirrored here with its Δ label. */
  setExternalRange(range: { x0: number; x1: number } | undefined): void {
    this.externalRange = range;
  }

  render(): void {
    const { ctx, dpr } = fitCanvas(this.element, this.width, rulerHeight);
    renderRuler(ctx, dpr, this.width, this.palette(), this.store, { dragRange: this.localRange ?? this.externalRange });
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.store.data) {
      return;
    }
    event.preventDefault();
    this.element.setPointerCapture(event.pointerId);
    const startX = event.offsetX;
    const marker = this.markerAt(startX);
    let mode: 'pending' | 'range' | 'marker' = marker ? 'marker' : 'pending';
    if (marker) {
      this.actions.activateMarker(marker.label);
    }
    const move = (moveEvent: PointerEvent): void => {
      const x = Math.max(0, Math.min(this.width, moveEvent.offsetX));
      if (marker) {
        this.actions.moveMarker(marker.label, xToTime(this.store.view, this.width, x));
        return;
      }
      if (mode === 'pending' && Math.abs(x - startX) > 3) {
        mode = 'range';
      }
      if (mode === 'range') {
        this.localRange = { x0: startX, x1: x };
        this.store.invalidate('ruler', 'waves');
      }
    };
    const up = (upEvent: PointerEvent): void => {
      this.element.removeEventListener('pointermove', move);
      this.element.removeEventListener('pointerup', up);
      this.element.removeEventListener('pointercancel', up);
      const range = this.localRange;
      this.localRange = undefined;
      if (upEvent.type !== 'pointerup') {
        this.store.invalidate('ruler');
        return;
      }
      if (mode === 'pending') {
        this.actions.setCursor(xToTime(this.store.view, this.width, startX));
      } else if (mode === 'range' && range) {
        this.actions.zoomToRange(
          xToTime(this.store.view, this.width, Math.min(range.x0, range.x1)),
          xToTime(this.store.view, this.width, Math.max(range.x0, range.x1))
        );
      }
      this.store.invalidate('ruler', 'waves');
    };
    this.element.addEventListener('pointermove', move);
    this.element.addEventListener('pointerup', up);
    this.element.addEventListener('pointercancel', up);
  }

  /** Marker whose flag (top half of the ruler) is under x. */
  private markerAt(x: number): WaveMarker | undefined {
    return this.actions.nearestMarker(xToTime(this.store.view, this.width, x), flagGrabPixels);
  }

  /** The marker range drawn in the waveform canvas mirrors the local ruler drag too. */
  get activeRange(): { x0: number; x1: number } | undefined {
    return this.localRange;
  }
}
