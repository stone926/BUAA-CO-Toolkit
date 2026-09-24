// @index waveform-webview-sidebar — 侧栏容器：信号/Trace 标签页切换、宽度拖拽与隐藏

import { h, setText, toggleClass } from './dom';
import type { SignalBrowser } from './signalBrowser';
import type { DirtyFlag, WaveStore } from './store';
import type { TracePanel } from './tracePanel';

export class Sidebar {
  readonly element: HTMLElement;
  private readonly signalsTab: HTMLButtonElement;
  private readonly traceTab: HTMLButtonElement;
  private readonly traceCount: HTMLSpanElement;

  constructor(private readonly store: WaveStore, private readonly browser: SignalBrowser, private readonly trace: TracePanel) {
    this.signalsTab = h('button', { className: 'tab', text: '信号' });
    this.traceCount = h('span', { className: 'tab-count' });
    this.traceTab = h('button', { className: 'tab', title: 'testbench 打印的 GRF/DM 写入记录' }, ['Trace', this.traceCount]);
    this.signalsTab.addEventListener('click', () => this.show('signals'));
    this.traceTab.addEventListener('click', () => this.show('trace'));
    const resizer = h('div', { className: 'sidebar-resizer', title: '拖动调整侧栏宽度' });
    resizer.addEventListener('pointerdown', (event) => this.startResize(event, resizer));
    this.element = h('aside', { className: 'sidebar' }, [
      h('div', { className: 'tabs', attrs: { role: 'tablist' } }, [this.signalsTab, this.traceTab]),
      h('div', { className: 'panel-host' }, [browser.element, trace.element]),
      resizer
    ]);
  }

  show(panel: 'signals' | 'trace'): void {
    this.store.layout.sidebar = panel;
    this.store.invalidate('layout', 'browser', 'trace');
    this.store.persist();
  }

  toggle(): void {
    this.store.layout.sidebar = this.store.layout.sidebar === 'hidden' ? 'signals' : 'hidden';
    this.store.invalidate('layout', 'browser', 'trace');
    this.store.persist();
  }

  render(dirty: ReadonlySet<DirtyFlag>): void {
    const layout = this.store.layout;
    if (dirty.has('layout')) {
      this.element.hidden = layout.sidebar === 'hidden';
      this.element.style.width = `${layout.sidebarWidth}px`;
      toggleClass(this.signalsTab, 'active', layout.sidebar !== 'trace');
      toggleClass(this.traceTab, 'active', layout.sidebar === 'trace');
      this.browser.element.hidden = layout.sidebar === 'trace';
      this.trace.element.hidden = layout.sidebar !== 'trace';
      this.trace.setVisible(layout.sidebar === 'trace');
    }
    const events = this.store.trace?.events.length;
    setText(this.traceCount, events ? String(events) : '');
    if (layout.sidebar === 'hidden') {
      return;
    }
    this.browser.render(dirty);
    this.trace.render(dirty);
  }

  private startResize(event: PointerEvent, handle: HTMLElement): void {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const start = this.store.layout.sidebarWidth;
    const move = (moveEvent: PointerEvent): void => {
      this.store.layout.sidebarWidth = Math.max(160, Math.min(Math.round(window.innerWidth * 0.6), start + moveEvent.clientX - startX));
      this.store.invalidate('layout');
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      this.store.persist();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }
}
