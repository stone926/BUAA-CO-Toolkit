// @index waveform-webview-pane — 波形主区装配：表头（信号/值/标尺）、粘性画布 + 虚拟标签行的纵向滚动、缩略条、列宽拖拽、空状态与从信号树拖入

import { rowHeight, WaveActions } from './actions';
import { showContextMenu, MenuEntry } from './contextMenu';
import { h, listen } from './dom';
import { decodeSignalDrag, signalDragType } from './dragData';
import type { HostChannel } from './hostChannel';
import { Overview } from './overview';
import { RowLabels } from './rowLabels';
import { rowMenuEntries } from './rowMenu';
import { RulerView } from './rulerView';
import type { DirtyFlag, WaveStore } from './store';
import type { Palette } from './theme';
import { Tooltip } from './tooltip';
import { WaveCanvas } from './waveCanvas';

export class WavePane {
  readonly element: HTMLElement;
  private readonly viewport: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly labels: RowLabels;
  private readonly canvas: WaveCanvas;
  private readonly ruler: RulerView;
  private readonly overview: Overview;
  private readonly empty: HTMLDivElement;
  private readonly canvasLayer: HTMLDivElement;
  private dragRange: { x0: number; x1: number } | undefined;
  private viewportHeight = 0;
  private applyingScroll = false;

  constructor(
    private readonly store: WaveStore,
    private readonly actions: WaveActions,
    private readonly host: HostChannel,
    private readonly palette: () => Palette,
    tooltip: Tooltip
  ) {
    const menuContext = () => ({ store, actions, host, palette: palette(), renameGroup: (id: number) => this.labels.startRename(id) });
    this.labels = new RowLabels(store, actions, palette, {
      onContextMenu: (event, id) => showContextMenu(event.clientX, event.clientY, rowMenuEntries(menuContext(), id)),
      onOpenSource: (row) => host.openSource(row.path, false)
    });
    this.canvas = new WaveCanvas(store, actions, palette, tooltip, {
      onContextMenu: (event, rowId, time) => {
        if (rowId !== undefined) {
          if (!store.selection.has(rowId)) {
            actions.select(rowId, 'replace');
          }
          showContextMenu(event.clientX, event.clientY, [
            ...this.timeMenu(time),
            'separator',
            ...rowMenuEntries(menuContext(), rowId)
          ]);
        } else {
          showContextMenu(event.clientX, event.clientY, this.timeMenu(time));
        }
      },
      onDragRange: (range) => {
        this.dragRange = range;
        this.ruler.setExternalRange(range);
      }
    });
    this.ruler = new RulerView(store, actions, palette, (event, time) => showContextMenu(event.clientX, event.clientY, this.timeMenu(time)));
    this.canvas.externalRange = () => this.ruler.activeRange;
    this.overview = new Overview(store, actions, palette);

    const nameHeader = h('div', { className: 'header-cell name-header', text: '信号' }, [this.resizer('name')]);
    const valueHeader = h('div', { className: 'header-cell value-header', text: '游标处的值' }, [this.resizer('value')]);
    const header = h('div', { className: 'wave-header' }, [nameHeader, valueHeader, this.ruler.element]);

    this.canvasLayer = h('div', { className: 'canvas-layer' }, [this.canvas.element]);
    this.empty = h('div', { className: 'empty-hint' }, [
      h('div', { className: 'empty-title', text: '还没有信号' }),
      h('div', { text: '在左侧信号树中双击、点击 + 或拖入信号即可显示波形' })
    ]);
    this.content = h('div', { className: 'rows-content' }, [this.labels.element]);
    this.viewport = h('div', { className: 'rows-viewport', attrs: { tabindex: '0' } }, [
      h('div', { className: 'rows-sticky' }, [this.canvasLayer, this.empty]),
      this.content
    ]);
    this.element = h('section', { className: 'wave-pane' }, [header, this.viewport, this.overview.element]);

    listen(this.viewport, 'scroll', () => {
      if (this.applyingScroll) {
        return;
      }
      store.scrollTop = this.viewport.scrollTop;
      store.invalidate('labels', 'waves');
    });
    this.installDropTarget();
    new ResizeObserver(() => this.measure()).observe(this.viewport);
  }

  focus(): void {
    this.viewport.focus({ preventScroll: true });
  }

  /** Escape: cancel an in-flight canvas drag. */
  cancelInteraction(): boolean {
    return this.canvas.cancelDrag();
  }

  render(dirty: ReadonlySet<DirtyFlag>): void {
    if (dirty.has('layout')) {
      this.applyLayout();
    }
    const rows = this.store.rows.visibleRows();
    if (dirty.has('labels') || dirty.has('layout')) {
      const maximumScroll = Math.max(0, rows.length * rowHeight - this.viewportHeight);
      if (this.store.scrollTop > maximumScroll) {
        this.store.scrollTop = maximumScroll;
      }
      this.content.style.height = `${rows.length * rowHeight}px`;
      if (Math.abs(this.viewport.scrollTop - this.store.scrollTop) > 0.5) {
        this.applyingScroll = true;
        this.viewport.scrollTop = this.store.scrollTop;
        this.applyingScroll = false;
      }
      this.labels.render(rows, this.viewportHeight);
      this.empty.hidden = !(this.store.data && rows.length === 0);
    } else if (dirty.has('values')) {
      this.labels.updateValues();
    }
    if (dirty.has('waves') || dirty.has('labels') || dirty.has('layout')) {
      this.canvas.render(rows);
    }
    if (dirty.has('ruler') || dirty.has('layout')) {
      this.ruler.render();
    }
    if (dirty.has('overview') || dirty.has('layout')) {
      this.overview.render();
    }
  }

  private measure(): void {
    const labelsWidth = this.store.layout.nameWidth + this.store.layout.valueWidth;
    const width = Math.max(40, this.viewport.clientWidth - labelsWidth);
    this.viewportHeight = this.viewport.clientHeight;
    this.actions.waveWidth = width;
    this.actions.viewportHeight = this.viewportHeight;
    this.canvas.resize(width, this.viewportHeight);
    // The ruler maps time over the same width as the canvas; the header area
    // above the scrollbar stays empty.
    this.ruler.resize(width);
    this.overview.resize(this.element.clientWidth);
    this.store.invalidate('layout');
  }

  private applyLayout(): void {
    const { nameWidth, valueWidth } = this.store.layout;
    this.element.style.setProperty('--name-width', `${nameWidth}px`);
    this.element.style.setProperty('--value-width', `${valueWidth}px`);
    this.element.style.setProperty('--labels-width', `${nameWidth + valueWidth}px`);
    const labelsWidth = nameWidth + valueWidth;
    const width = Math.max(40, this.viewport.clientWidth - labelsWidth);
    if (width !== this.actions.waveWidth) {
      this.actions.waveWidth = width;
      this.canvas.resize(width, this.viewportHeight);
      this.ruler.resize(width);
    }
  }

  private resizer(column: 'name' | 'value'): HTMLDivElement {
    const handle = h('div', { className: 'column-resizer', title: '拖动调整列宽' });
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const start = column === 'name' ? this.store.layout.nameWidth : this.store.layout.valueWidth;
      const move = (moveEvent: PointerEvent): void => {
        const next = Math.max(60, Math.min(600, start + moveEvent.clientX - startX));
        if (column === 'name') {
          this.store.layout.nameWidth = next;
        } else {
          this.store.layout.valueWidth = next;
        }
        this.store.invalidate('layout');
      };
      const up = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        this.store.persist();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    return handle;
  }

  private installDropTarget(): void {
    const accepts = (event: DragEvent): boolean => event.dataTransfer?.types.includes(signalDragType) ?? false;
    this.viewport.addEventListener('dragover', (event) => {
      if (!accepts(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer!.dropEffect = 'copy';
      const target = this.labels.dropTarget(event.clientY);
      this.labels.showDropIndicator(target.index, target.into !== undefined);
    });
    this.viewport.addEventListener('dragleave', (event) => {
      if (!this.viewport.contains(event.relatedTarget as Node)) {
        this.labels.hideDropIndicator();
      }
    });
    this.viewport.addEventListener('drop', (event) => {
      this.labels.hideDropIndicator();
      if (!accepts(event)) {
        return;
      }
      event.preventDefault();
      const payload = decodeSignalDrag(event.dataTransfer!.getData(signalDragType));
      const vars = (payload?.vars ?? []).filter((index) => index < (this.store.data?.vars.length ?? 0));
      if (!payload || !vars.length) {
        return;
      }
      const target = this.labels.dropTarget(event.clientY);
      const beforeId = this.labels.rowIdBefore(target.index);
      const insertion = target.into !== undefined
        ? { kind: 'group-end' as const, groupId: target.into }
        : beforeId !== undefined ? { kind: 'before' as const, rowId: beforeId } : { kind: 'end' as const };
      if (payload.group !== undefined && target.into === undefined) {
        this.actions.addGroup(payload.group, vars, insertion);
      } else {
        this.actions.addSignals(vars, insertion);
      }
      this.focus();
    });
  }

  private timeMenu(time: number): MenuEntry[] {
    const rounded = Math.round(time);
    return [
      { label: '游标移到此处', action: () => this.actions.setCursor(rounded) },
      { label: '在此处添加标记', shortcut: 'M', action: () => this.actions.addMarker(rounded) },
      { label: '清除全部标记', disabled: !this.store.markers.length, action: () => this.actions.clearMarkers() },
      'separator',
      { label: '以此处为中心放大', shortcut: 'Ctrl+滚轮', action: () => this.actions.zoom(2, rounded) },
      { label: '显示全部', shortcut: 'F', action: () => this.actions.zoomFit() }
    ];
  }

  /** Keep the dragged range reference alive for debugging overlays. */
  get currentDragRange(): { x0: number; x1: number } | undefined {
    return this.dragRange;
  }
}
