// @index waveform-webview-trace — 侧栏 trace 列表：GRF/DM 写入事件（虚拟列表）、类型开关与过滤、跟随游标高亮、点击或方向键联动游标与寄存器行

import { gprNames } from '../../mips/core/assembler/registers';
import type { WaveformTraceEvent } from '../model/protocol';
import { formatTicks } from '../model/timeScale';
import { lowerBound } from '../view/waveSegments';
import type { WaveActions } from './actions';
import { h, setText, toggleClass } from './dom';
import type { DirtyFlag, WaveStore } from './store';

const traceRowHeight = 22;

interface TraceRowElement {
  readonly root: HTMLDivElement;
  readonly time: HTMLSpanElement;
  readonly pc: HTMLSpanElement;
  readonly target: HTMLSpanElement;
  readonly value: HTMLSpanElement;
}

export class TracePanel {
  readonly element: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private readonly grfToggle: HTMLButtonElement;
  private readonly dmToggle: HTMLButtonElement;
  private readonly note: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly pool: TraceRowElement[] = [];
  /** Indexes into trace.events that pass the type toggles and filter, ascending. */
  private filtered: number[] = [];
  /** Time of each filtered event, index-aligned with `filtered`. */
  private filteredTimes = new Float64Array(0);
  private trace: WaveStore['trace'];
  private showGrf = true;
  private showDm = true;
  private filter = '';
  /** Highlighted event as an index into trace.events (not into `filtered`), or -1. */
  private current = -1;
  private visible = false;

  constructor(private readonly store: WaveStore, private readonly actions: WaveActions) {
    this.filterInput = h('input', {
      className: 'search-input',
      attrs: { type: 'search', placeholder: '过滤：$8 / t0 / *00000100 / 00003004', spellcheck: 'false' }
    });
    this.filterInput.addEventListener('input', () => {
      this.filter = this.filterInput.value.trim().toLowerCase();
      this.refilter();
    });
    this.grfToggle = h('button', { className: 'chip grf active', text: 'GRF', title: '显示寄存器写入' });
    this.dmToggle = h('button', { className: 'chip dm active', text: 'DM', title: '显示存储器写入' });
    this.grfToggle.addEventListener('click', () => {
      this.showGrf = !this.showGrf;
      this.refilter();
    });
    this.dmToggle.addEventListener('click', () => {
      this.showDm = !this.showDm;
      this.refilter();
    });
    this.note = h('div', { className: 'trace-note' });
    this.spacer = h('div', { className: 'tree-spacer' });
    this.list = h('div', { className: 'trace-list', attrs: { tabindex: '0', role: 'listbox' } }, [this.spacer]);
    this.list.addEventListener('scroll', () => this.renderRows());
    this.list.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('.trace-row');
      if (row?.dataset.index) {
        this.activate(Number(row.dataset.index));
      }
    });
    this.list.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const position = this.positionOf(this.current);
        this.activate(Math.max(0, Math.min(this.filtered.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1))));
      }
    });
    this.element = h('div', { className: 'trace-panel' }, [
      h('div', { className: 'search-box' }, [this.filterInput]),
      h('div', { className: 'chip-row' }, [this.grfToggle, this.dmToggle]),
      this.note,
      this.list
    ]);
    new ResizeObserver(() => this.renderRows()).observe(this.list);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.followCursor();
    }
  }

  render(dirty: ReadonlySet<DirtyFlag>): void {
    if (this.store.trace !== this.trace) {
      this.trace = this.store.trace;
      this.current = -1;
      this.refilter();
      return;
    }
    if (dirty.has('trace') && this.visible) {
      this.followCursor();
    }
  }

  private followCursor(): void {
    if (this.syncCurrent()) {
      this.revealCurrent();
    }
    this.renderRows();
  }

  private refilter(): void {
    const events = this.trace?.events ?? [];
    toggleClass(this.grfToggle, 'active', this.showGrf);
    toggleClass(this.dmToggle, 'active', this.showDm);
    this.filtered = [];
    events.forEach((event, index) => {
      if ((event.kind === 'grf' ? this.showGrf : this.showDm) && matches(event, this.filter)) {
        this.filtered.push(index);
      }
    });
    this.filteredTimes = Float64Array.from(this.filtered, (index) => events[index].time);
    this.spacer.style.height = `${this.filtered.length * traceRowHeight}px`;
    if (!this.trace) {
      setText(this.note, '没有与此波形配对的 trace。用「仿真并查看波形」生成的波形会自动附带 GRF/DM 写入记录（来自 testbench 的 $display）。');
    } else {
      const counts = `${this.trace.source} · ${events.length} 条写入${this.filtered.length !== events.length ? `，显示 ${this.filtered.length} 条` : ''}`;
      setText(this.note, this.trace.note ? `${counts}\n${this.trace.note}` : counts);
    }
    // Rows moved, so reveal the current event even when it stayed the same.
    this.syncCurrent();
    this.revealCurrent();
    this.renderRows();
  }

  /**
   * Highlight the last filtered event at or before the cursor. Several writes can
   * share a timestamp; the one picked by click or arrow key stays current while
   * the cursor remains at its time. Returns whether the current event changed.
   */
  private syncCurrent(): boolean {
    const times = this.filteredTimes;
    const last = lowerBound(times, this.store.cursor + 0.5) - 1;
    const position = this.positionOf(this.current);
    const next = position >= 0 && last >= 0 && times[position] === times[last]
      ? this.current
      : last >= 0 ? this.filtered[last] : -1;
    const changed = next !== this.current;
    this.current = next;
    return changed;
  }

  /** Position of an event within `filtered`, or -1 when it is filtered out. */
  private positionOf(eventIndex: number): number {
    const position = lowerBound(this.filtered, eventIndex);
    return eventIndex >= 0 && this.filtered[position] === eventIndex ? position : -1;
  }

  private revealCurrent(): void {
    const position = this.positionOf(this.current);
    if (position >= 0) {
      this.scrollIntoView(position);
    }
  }

  private scrollIntoView(index: number): void {
    const top = index * traceRowHeight;
    const height = this.list.clientHeight;
    if (top < this.list.scrollTop || top + traceRowHeight > this.list.scrollTop + height) {
      this.list.scrollTop = Math.max(0, top - height / 2);
    }
  }

  private activate(index: number): void {
    const event = this.trace?.events[this.filtered[index]];
    if (!event) {
      return;
    }
    this.current = this.filtered[index];
    this.scrollIntoView(index);
    this.actions.activateTraceEvent(event);
    this.renderRows();
  }

  private renderRows(): void {
    if (!this.visible) {
      return;
    }
    const events = this.trace?.events ?? [];
    const scale = this.store.data?.timescale;
    const top = this.list.scrollTop;
    const height = this.list.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / traceRowHeight) - 3);
    const last = Math.min(this.filtered.length - 1, Math.ceil((top + height) / traceRowHeight) + 3);
    let used = 0;
    for (let index = first; index <= last; index++) {
      const element = this.pool[used] ?? this.createRow();
      used++;
      const event = events[this.filtered[index]];
      element.root.hidden = false;
      element.root.dataset.index = String(index);
      element.root.style.top = `${index * traceRowHeight}px`;
      toggleClass(element.root, 'current', this.filtered[index] === this.current);
      toggleClass(element.root, 'dm', event.kind === 'dm');
      setText(element.time, scale ? formatTicks(event.time, scale) : String(event.time));
      setText(element.pc, event.pc);
      setText(element.target, targetLabel(event));
      setText(element.value, event.value);
    }
    for (let index = used; index < this.pool.length; index++) {
      this.pool[index].root.hidden = true;
    }
  }

  private createRow(): TraceRowElement {
    const time = h('span', { className: 'trace-time' });
    const pc = h('span', { className: 'trace-pc' });
    const target = h('span', { className: 'trace-target' });
    const value = h('span', { className: 'trace-value' });
    const write = h('span', { className: 'trace-write' }, [target, h('span', { className: 'trace-arrow', text: '←' }), value]);
    const root = h('div', { className: 'trace-row', attrs: { role: 'option' } }, [time, pc, write]);
    this.list.append(root);
    const element = { root, time, pc, target, value };
    this.pool.push(element);
    return element;
  }
}

function targetLabel(event: WaveformTraceEvent): string {
  if (event.kind === 'dm') {
    return `*${event.target}`;
  }
  const register = Number.parseInt(event.target, 10);
  const alias = gprNames[register]?.names[0];
  return alias ? `$${register} ${alias.slice(1)}` : `$${event.target}`;
}

function matches(event: WaveformTraceEvent, filter: string): boolean {
  if (!filter) {
    return true;
  }
  const text = `${event.pc} ${targetLabel(event)} ${event.value} ${event.kind === 'grf' ? `$${event.target}` : ''}`.toLowerCase();
  return filter.split(/\s+/).every((part) => text.includes(part));
}
