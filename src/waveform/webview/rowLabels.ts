// @index waveform-webview-labels — 信号名/当前值列：虚拟化行池、GRF 别名与重名前缀、x/z 与本刻跳变高亮、选择、拖动排序、分组重命名

import { changeIndexAt, changeTime, valueState, ValueState } from '../model/signalValues';
import { formatTrackValue } from '../model/valueFormat';
import { shortestUniqueNames } from '../view/displayNames';
import { registerAlias } from '../view/signalDefaults';
import type { SignalRow, VisibleRow } from '../view/waveRows';
import { rowHeight, WaveActions } from './actions';
import { h, setText, toggleClass } from './dom';
import { icons } from './icons';
import type { WaveStore } from './store';
import type { Palette } from './theme';

interface RowElement {
  readonly root: HTMLDivElement;
  readonly twisty: HTMLSpanElement;
  readonly swatch: HTMLSpanElement;
  readonly prefix: HTMLSpanElement;
  readonly leaf: HTMLSpanElement;
  readonly alias: HTMLSpanElement;
  readonly badge: HTMLSpanElement;
  readonly value: HTMLDivElement;
  id: number;
}

export interface LabelCallbacks {
  readonly onContextMenu: (event: MouseEvent, id: number) => void;
  readonly onOpenSource: (row: SignalRow) => void;
}

export class RowLabels {
  readonly element: HTMLDivElement;
  private readonly indicator: HTMLDivElement;
  private readonly pool: RowElement[] = [];
  private rows: readonly VisibleRow[] = [];
  private names = new Map<number, { prefix: string; leaf: string }>();
  private namesKey = '';
  private renaming: number | undefined;

  constructor(
    private readonly store: WaveStore,
    private readonly actions: WaveActions,
    private readonly palette: () => Palette,
    private readonly callbacks: LabelCallbacks
  ) {
    this.element = h('div', { className: 'labels' });
    this.indicator = h('div', { className: 'drop-indicator' });
    this.element.append(this.indicator);
    this.element.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.element.addEventListener('dblclick', (event) => this.onDoubleClick(event));
    this.element.addEventListener('contextmenu', (event) => {
      const id = this.rowIdAt(event);
      if (id !== undefined) {
        event.preventDefault();
        if (!this.store.selection.has(id)) {
          this.actions.select(id, 'replace');
        }
        this.callbacks.onContextMenu(event, id);
      }
    });
  }

  /** Rebuild the visible window of rows. */
  render(rows: readonly VisibleRow[], viewportHeight: number): void {
    this.rows = rows;
    this.refreshNames();
    this.element.style.height = `${rows.length * rowHeight}px`;
    const first = Math.max(0, Math.floor(this.store.scrollTop / rowHeight) - 4);
    const last = Math.min(rows.length - 1, Math.ceil((this.store.scrollTop + viewportHeight) / rowHeight) + 4);
    let used = 0;
    for (let index = first; index <= last; index++) {
      const element = this.pool[used] ?? this.createRow();
      used++;
      this.fillRow(element, rows[index], index);
    }
    for (let index = used; index < this.pool.length; index++) {
      this.pool[index].root.hidden = true;
    }
    this.updateValues();
  }

  /** Refresh only the value column (cursor moved). */
  updateValues(): void {
    const data = this.store.data;
    for (const element of this.pool) {
      if (element.root.hidden) {
        continue;
      }
      const row = this.store.rows.find(element.id)?.row;
      if (!row || row.kind !== 'signal' || !data || row.varIndex < 0) {
        setText(element.value, row?.kind === 'group' ? `${row.children.length} 个信号` : '');
        element.value.className = 'cell value dim';
        continue;
      }
      const track = data.vars[row.varIndex].track;
      const index = changeIndexAt(data.tracks, track, this.store.cursor);
      if (index < 0) {
        setText(element.value, '—');
        element.value.className = 'cell value dim';
        continue;
      }
      const state = valueState(data.tracks, track, index);
      setText(element.value, formatTrackValue(data.tracks, track, index, row.radix));
      const changedHere = changeTime(data.tracks, track, index) === this.store.cursor && index > 0;
      element.value.className = `cell value${state === ValueState.AllHighZ ? ' highz' : state === ValueState.Known ? '' : ' unknown'}${changedHere ? ' changed' : ''}`;
      element.value.title = element.value.textContent ?? '';
    }
  }

  startRename(groupId: number): void {
    const element = this.pool.find((candidate) => candidate.id === groupId && !candidate.root.hidden);
    const row = this.store.rows.find(groupId)?.row;
    if (!element || row?.kind !== 'group') {
      return;
    }
    this.renaming = groupId;
    const input = h('input', { className: 'rename-input', attrs: { value: row.name, spellcheck: 'false' } });
    element.leaf.replaceChildren(input);
    input.select();
    input.focus();
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) {
        return;
      }
      done = true;
      this.renaming = undefined;
      if (commit) {
        this.actions.renameGroup(groupId, input.value);
      }
      this.store.invalidate('labels');
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        finish(true);
      } else if (event.key === 'Escape') {
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  /** Show the drop indicator before visible row `index` (or after the last one). */
  showDropIndicator(index: number, into: boolean): void {
    this.indicator.hidden = false;
    toggleClass(this.indicator, 'into', into);
    this.indicator.style.top = `${index * rowHeight + (into ? 0 : -1)}px`;
    this.indicator.style.height = into ? `${rowHeight}px` : '2px';
  }

  hideDropIndicator(): void {
    this.indicator.hidden = true;
  }

  /** Where a drop at client y would go: before visible row `index`, or into a group header. */
  dropTarget(clientY: number): { index: number; into?: number } {
    const rect = this.element.getBoundingClientRect();
    const y = clientY - rect.top;
    const index = Math.max(0, Math.min(this.rows.length, Math.floor(y / rowHeight)));
    const within = y - index * rowHeight;
    const row = this.rows[index]?.row;
    if (row?.kind === 'group' && within > rowHeight * 0.3 && within < rowHeight * 0.7) {
      return { index, into: row.id };
    }
    return { index: within > rowHeight / 2 ? index + 1 : index };
  }

  /** First row at or after `index` that is not being moved (undefined = end of list). */
  rowIdBefore(index: number): number | undefined {
    for (let position = index; position < this.rows.length; position++) {
      const visible = this.rows[position];
      if (!this.store.selection.has(visible.row.id) && !(visible.group && this.store.selection.has(visible.group.id))) {
        return visible.row.id;
      }
    }
    return undefined;
  }

  private refreshNames(): void {
    const signals = this.store.rows.allSignals();
    const key = signals.map((row) => `${row.id}:${row.path}`).join('\n');
    if (key === this.namesKey) {
      return;
    }
    this.namesKey = key;
    const names = shortestUniqueNames(signals.map((row) => row.path));
    this.names = new Map(signals.map((row, index) => [row.id, names[index]]));
  }

  private createRow(): RowElement {
    const twisty = h('span', { className: 'twisty' });
    const swatch = h('span', { className: 'swatch' });
    const prefix = h('span', { className: 'prefix' });
    const leaf = h('span', { className: 'leaf' });
    const alias = h('span', { className: 'alias' });
    const badge = h('span', { className: 'badge' });
    const value = h('div', { className: 'cell value' });
    const root = h('div', { className: 'row' }, [
      h('div', { className: 'cell name' }, [twisty, swatch, h('span', { className: 'name-text' }, [prefix, leaf, alias]), badge]),
      value
    ]);
    this.element.append(root);
    const element: RowElement = { root, twisty, swatch, prefix, leaf, alias, badge, value, id: -1 };
    this.pool.push(element);
    return element;
  }

  private fillRow(element: RowElement, visible: VisibleRow, index: number): void {
    const row = visible.row;
    element.id = row.id;
    element.root.hidden = false;
    element.root.dataset.id = String(row.id);
    element.root.style.top = `${index * rowHeight}px`;
    toggleClass(element.root, 'selected', this.store.selection.has(row.id));
    toggleClass(element.root, 'group', row.kind === 'group');
    toggleClass(element.root, 'child', visible.group !== undefined);
    toggleClass(element.root, 'odd', index % 2 === 1);
    if (this.renaming === row.id) {
      return;
    }
    if (row.kind === 'group') {
      element.twisty.innerHTML = row.collapsed ? icons.chevronRight : icons.chevronDown;
      element.swatch.hidden = true;
      setText(element.prefix, '');
      setText(element.leaf, row.name);
      setText(element.alias, '');
      setText(element.badge, '');
      element.root.title = `${row.name}（${row.children.length} 个信号）`;
      toggleClass(element.root, 'missing', false);
      return;
    }
    element.twisty.textContent = '';
    element.swatch.hidden = false;
    element.swatch.style.background = this.palette().rowColors[row.color ?? 0];
    const name = this.names.get(row.id) ?? { prefix: '', leaf: row.path };
    setText(element.prefix, name.prefix);
    setText(element.leaf, name.leaf);
    const data = this.store.data;
    const variable = data && row.varIndex >= 0 ? data.vars[row.varIndex] : undefined;
    setText(element.alias, variable && data ? registerAlias(data, variable) ?? '' : '');
    setText(element.badge, this.store.clockVar !== undefined && this.store.clockVar === row.varIndex ? '时钟' : '');
    toggleClass(element.root, 'missing', !variable);
    element.root.title = variable
      ? `${row.path}\n${variable.kind} ${variable.range ?? ''}（${variable.width} 位）\n双击跳转到源码`
      : `${row.path}\n当前波形中没有此信号`;
  }

  private rowIdAt(event: Event): number | undefined {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.row');
    return target?.dataset.id ? Number(target.dataset.id) : undefined;
  }

  private onDoubleClick(event: MouseEvent): void {
    const id = this.rowIdAt(event);
    const row = id !== undefined ? this.store.rows.find(id)?.row : undefined;
    if (!row || (event.target as HTMLElement).closest('.twisty')) {
      return;
    }
    if (row.kind === 'group') {
      this.startRename(row.id);
    } else if (row.varIndex >= 0) {
      this.callbacks.onOpenSource(row);
    }
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.rename-input')) {
      return;
    }
    const id = this.rowIdAt(event);
    if (id === undefined) {
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
        this.actions.selectOnly([]);
      }
      return;
    }
    if ((event.target as HTMLElement).closest('.twisty')) {
      this.actions.toggleGroup(id);
      return;
    }
    const additive = event.ctrlKey || event.metaKey;
    const wasSelected = this.store.selection.has(id);
    if (event.shiftKey) {
      this.actions.select(id, 'range');
    } else if (additive) {
      this.actions.select(id, 'toggle');
    } else if (!wasSelected) {
      this.actions.select(id, 'replace');
    }
    const startY = event.clientY;
    let dragging = false;
    this.element.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      if (!dragging && Math.abs(moveEvent.clientY - startY) > 4 && !additive && !event.shiftKey) {
        dragging = true;
        this.element.classList.add('dragging');
      }
      if (dragging) {
        const target = this.dropTarget(moveEvent.clientY);
        this.showDropIndicator(target.index, target.into !== undefined);
      }
    };
    const up = (upEvent: PointerEvent): void => {
      this.element.removeEventListener('pointermove', move);
      this.element.removeEventListener('pointerup', up);
      this.element.removeEventListener('pointercancel', up);
      this.element.classList.remove('dragging');
      this.hideDropIndicator();
      if (dragging && upEvent.type === 'pointerup') {
        const target = this.dropTarget(upEvent.clientY);
        const ids = [...this.store.selection];
        if (target.into !== undefined) {
          this.actions.moveRowsIntoGroup(ids, target.into);
        } else {
          this.actions.moveRows(ids, this.rowIdBefore(target.index));
        }
      } else if (!dragging && wasSelected && !additive && !event.shiftKey) {
        this.actions.select(id, 'replace');
      }
    };
    this.element.addEventListener('pointermove', move);
    this.element.addEventListener('pointerup', up);
    this.element.addEventListener('pointercancel', up);
  }
}
