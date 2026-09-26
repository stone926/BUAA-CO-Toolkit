// @index waveform-webview-actions — 用户意图到状态变更：缩放/平移/游标/跳变与周期步进/标记/信号增删分组/进制颜色/选择/trace 联动

import { gprNames } from '../../mips/core/assembler/registers';
import type { WaveformTraceEvent } from '../model/protocol';
import type { Radix } from '../model/radix';
import { changeIndexAt, changeTime, nextChangeTime, previousChangeTime } from '../model/signalValues';
import type { WaveMarker } from '../view/markers';
import { registerAlias } from '../view/signalDefaults';
import type { TimeInputTarget } from '../view/timeInput';
import {
  centerView,
  clampView,
  ensureVisible,
  fitView,
  panView,
  rangeView,
  TimeRange,
  viewSpan,
  zoomView
} from '../view/viewport';
import type { RowInsertion, SignalRow } from '../view/waveRows';
import type { DirtyFlag, WaveStore } from './store';

export const rowHeight = 24;
const snapPixels = 6;

export class WaveActions {
  /** Width of the waveform canvas in CSS pixels (kept current by the wave pane). */
  waveWidth = 800;
  /** Height of the rows viewport in CSS pixels. */
  viewportHeight = 400;

  constructor(private readonly store: WaveStore) {}

  // ── view ─────────────────────────────────────────────────────────────

  setView(view: TimeRange): void {
    const next = clampView(view, this.store.bounds);
    if (next.start === this.store.view.start && next.end === this.store.view.end) {
      return;
    }
    this.store.view = next;
    this.changed('waves', 'ruler', 'overview', 'status');
  }

  zoom(factor: number, anchor?: number): void {
    const view = this.store.view;
    const center = anchor ?? (this.cursorVisible() ? this.store.cursor : (view.start + view.end) / 2);
    this.setView(zoomView(view, factor, center, this.store.bounds));
  }

  zoomFit(): void {
    this.setView(fitView(this.store.bounds));
  }

  zoomToRange(from: number, to: number): void {
    this.setView(rangeView(from, to, this.store.bounds));
  }

  panPixels(pixels: number): void {
    this.setView(panView(this.store.view, (pixels * viewSpan(this.store.view)) / Math.max(1, this.waveWidth), this.store.bounds));
  }

  centerOn(time: number): void {
    this.setView(centerView(this.store.view, time, this.store.bounds));
  }

  // ── cursor & navigation ──────────────────────────────────────────────

  setCursor(time: number, options: { reveal?: boolean } = {}): void {
    const bounded = Math.round(Math.min(Math.max(time, this.store.bounds.start), this.store.bounds.end));
    this.store.cursor = bounded;
    if (options.reveal) {
      this.store.view = ensureVisible(this.store.view, bounded, this.store.bounds);
    }
    this.changed('waves', 'ruler', 'overview', 'values', 'toolbar', 'trace');
  }

  /** Snap `time` to the nearest change of `varIndex` within a few pixels. */
  snapTime(time: number, varIndex: number | undefined): number {
    const data = this.store.data;
    if (!data || varIndex === undefined || varIndex < 0) {
      return time;
    }
    const track = data.vars[varIndex].track;
    const tolerance = (snapPixels * viewSpan(this.store.view)) / Math.max(1, this.waveWidth);
    const before = changeIndexAt(data.tracks, track, time);
    let best = time;
    let bestDistance = tolerance;
    for (const index of [before, before + 1]) {
      if (index < 0 || index >= data.tracks.changeStart[track + 1] - data.tracks.changeStart[track]) {
        continue;
      }
      const candidate = changeTime(data.tracks, track, index);
      const distance = Math.abs(candidate - time);
      if (distance <= bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Jump to the previous/next change of the focused signal, or by one clock cycle. */
  navigateEdge(direction: -1 | 1): void {
    const row = this.focusedSignal();
    const data = this.store.data;
    if (!row || !data || row.varIndex < 0) {
      this.navigateCycle(direction);
      return;
    }
    const track = data.vars[row.varIndex].track;
    const target = direction > 0
      ? nextChangeTime(data.tracks, track, this.store.cursor)
      : previousChangeTime(data.tracks, track, this.store.cursor);
    if (target !== undefined) {
      this.setCursor(target, { reveal: true });
    }
  }

  navigateCycle(direction: -1 | 1): void {
    const cycles = this.store.cycles;
    if (!cycles) {
      return;
    }
    const target = direction > 0 ? cycles.nextEdge(this.store.cursor) : cycles.previousEdge(this.store.cursor);
    if (target !== undefined) {
      this.setCursor(target, { reveal: true });
    }
  }

  goTo(target: TimeInputTarget): boolean {
    if (target.kind === 'cycle') {
      const time = this.store.cycles?.edgeTime(target.cycle);
      if (time === undefined) {
        return false;
      }
      this.setCursor(time);
      this.centerOn(time);
      return true;
    }
    this.setCursor(target.ticks);
    this.centerOn(this.store.cursor);
    return true;
  }

  goToBoundary(end: boolean): void {
    this.setCursor(end ? this.store.bounds.end : this.store.bounds.start, { reveal: true });
  }

  /** Use a 1-bit signal as the cycle-counting clock, or disable cycle counting. */
  setClock(varIndex: number | undefined): void {
    this.store.setClock(varIndex);
  }

  // ── markers ──────────────────────────────────────────────────────────

  addMarker(time = this.store.cursor): void {
    this.store.markers.add(time);
    this.markersChanged();
  }

  moveMarker(label: number, time: number): void {
    const bounded = Math.round(Math.min(Math.max(time, this.store.bounds.start), this.store.bounds.end));
    if (this.store.markers.move(label, bounded)) {
      this.markersChanged();
    }
  }

  /** Measure Δ against this marker. */
  activateMarker(label: number): void {
    this.store.markers.activate(label);
    this.markersChanged();
  }

  removeMarker(label: number): void {
    if (this.store.markers.remove(label)) {
      this.markersChanged();
    }
  }

  clearMarkers(): void {
    this.store.markers.clear();
    this.markersChanged();
  }

  /** Remove the marker closest to the cursor. */
  removeNearestMarker(): void {
    const marker = this.store.markers.nearest(this.store.cursor);
    if (marker) {
      this.removeMarker(marker.label);
    }
  }

  navigateMarker(direction: -1 | 1): void {
    const target = this.store.markers.adjacent(this.store.cursor, direction);
    if (target) {
      this.store.markers.activate(target.label);
      this.setCursor(target.time, { reveal: true });
    }
  }

  /** The marker closest to `time` within `maximumPixels` on screen. */
  nearestMarker(time: number, maximumPixels: number): WaveMarker | undefined {
    return this.store.markers.nearest(time, (maximumPixels * viewSpan(this.store.view)) / Math.max(1, this.waveWidth));
  }

  // ── rows ─────────────────────────────────────────────────────────────

  addSignals(varIndexes: readonly number[], insertion?: RowInsertion): void {
    if (!this.store.data || !varIndexes.length) {
      return;
    }
    const added = this.store.rows.addSignals(varIndexes.map((index) => this.store.signalInput(index)), insertion);
    if (added.length) {
      this.selectOnly(added);
      this.revealRow(added[added.length - 1]);
    }
    this.rowsChanged();
  }

  addGroup(name: string, varIndexes: readonly number[], insertion?: RowInsertion): void {
    if (!this.store.data || !varIndexes.length) {
      return;
    }
    const id = this.store.rows.addGroup(name, varIndexes.map((index) => this.store.signalInput(index)), false, insertion);
    this.selectOnly([id]);
    this.revealRow(id);
    this.rowsChanged();
  }

  removeSelected(): void {
    if (!this.store.selection.size) {
      return;
    }
    this.store.rows.remove(this.store.selection);
    this.store.selection.clear();
    this.rowsChanged();
  }

  removeAll(): void {
    this.store.rows.clear();
    this.store.selection.clear();
    this.rowsChanged();
  }

  groupSelected(name = '分组'): void {
    const id = this.store.rows.groupSignals([...this.store.selection], name);
    if (id !== undefined) {
      this.selectOnly([id]);
      this.rowsChanged();
    }
  }

  ungroup(groupId: number): void {
    const group = this.store.rows.find(groupId)?.row;
    // A selected group hands its selection (and anchor) to the signals it releases.
    const released = group?.kind === 'group' && this.store.selection.has(groupId) ? group.children.map((child) => child.id) : [];
    this.store.rows.ungroup(groupId);
    released.forEach((id) => this.store.selection.add(id));
    if (released.length && this.store.selectionAnchor === groupId) {
      this.store.selectionAnchor = released[0];
    }
    this.rowsChanged();
  }

  toggleGroup(groupId: number, collapsed?: boolean): void {
    const row = this.store.rows.find(groupId)?.row;
    if (row?.kind === 'group') {
      row.collapsed = collapsed ?? !row.collapsed;
      this.rowsChanged();
    }
  }

  renameGroup(groupId: number, name: string): void {
    const row = this.store.rows.find(groupId)?.row;
    if (row?.kind === 'group' && name.trim()) {
      row.name = name.trim();
      this.rowsChanged();
    }
  }

  moveRows(ids: readonly number[], beforeId: number | undefined): void {
    this.store.rows.move(ids, beforeId);
    this.rowsChanged();
  }

  moveRowsIntoGroup(ids: readonly number[], groupId: number): void {
    this.store.rows.moveIntoGroup(ids, groupId);
    this.rowsChanged();
  }

  /** Signals affected by a row-level command: the selection, expanded through groups. */
  targetSignals(ids: Iterable<number> = this.store.selection): SignalRow[] {
    const result: SignalRow[] = [];
    for (const id of ids) {
      const found = this.store.rows.find(id);
      if (!found) {
        continue;
      }
      if (found.row.kind === 'group') {
        result.push(...found.row.children);
      } else {
        result.push(found.row);
      }
    }
    return result;
  }

  setRadix(radix: Radix, ids?: Iterable<number>): void {
    for (const row of this.targetSignals(ids)) {
      row.radix = radix;
    }
    this.rowsChanged();
  }

  setColor(color: number | undefined, ids?: Iterable<number>): void {
    for (const row of this.targetSignals(ids)) {
      if (color === undefined) {
        delete row.color;
      } else {
        row.color = color;
      }
    }
    this.rowsChanged();
  }

  // ── selection ────────────────────────────────────────────────────────

  select(id: number, mode: 'replace' | 'toggle' | 'range'): void {
    const selection = this.store.selection;
    const range = mode === 'range' ? this.visibleRange(this.store.selectionAnchor, id) : undefined;
    if (mode === 'toggle') {
      if (selection.has(id)) {
        selection.delete(id);
      } else {
        selection.add(id);
      }
      this.store.selectionAnchor = id;
    } else if (range) {
      selection.clear();
      range.forEach((rowId) => selection.add(rowId));
    } else {
      // A plain click, or a range without a visible anchor to extend from.
      selection.clear();
      selection.add(id);
      this.store.selectionAnchor = id;
    }
    this.changed('labels', 'waves', 'toolbar');
  }

  selectOnly(ids: readonly number[]): void {
    this.store.selection.clear();
    ids.forEach((id) => this.store.selection.add(id));
    this.store.selectionAnchor = ids[ids.length - 1];
    this.changed('labels', 'waves', 'toolbar');
  }

  selectAll(): void {
    this.selectOnly(this.store.rows.visibleRows().map((row) => row.row.id));
  }

  /** Ids of the visible rows from `from` to `to` inclusive, or undefined when either is not visible. */
  private visibleRange(from: number | undefined, to: number): number[] | undefined {
    const visible = this.store.rows.visibleRows().map((row) => row.row.id);
    const start = from === undefined ? -1 : visible.indexOf(from);
    const end = visible.indexOf(to);
    return start >= 0 && end >= 0 ? visible.slice(Math.min(start, end), Math.max(start, end) + 1) : undefined;
  }

  /** Move the single selection up/down through visible rows. */
  moveSelection(direction: -1 | 1, extend: boolean): void {
    const visible = this.store.rows.visibleRows().map((row) => row.row.id);
    if (!visible.length) {
      return;
    }
    const current = this.store.selectionAnchor !== undefined ? visible.indexOf(this.store.selectionAnchor) : -1;
    const nextIndex = Math.min(Math.max(current + direction, 0), visible.length - 1);
    const next = visible[nextIndex];
    if (extend) {
      this.store.selection.add(next);
      this.store.selectionAnchor = next;
      this.changed('labels', 'waves', 'toolbar');
    } else {
      this.select(next, 'replace');
    }
    this.revealRow(next);
  }

  focusedSignal(): SignalRow | undefined {
    const anchor = this.store.selectionAnchor;
    const candidates = anchor !== undefined && this.store.selection.has(anchor) ? [anchor, ...this.store.selection] : [...this.store.selection];
    for (const id of candidates) {
      const row = this.store.rows.find(id)?.row;
      if (row?.kind === 'signal') {
        return row;
      }
    }
    return undefined;
  }

  /** Scroll the rows viewport so the row is visible. */
  revealRow(id: number): void {
    const index = this.store.rows.visibleRows().findIndex((row) => row.row.id === id);
    if (index < 0) {
      return;
    }
    const top = index * rowHeight;
    if (top < this.store.scrollTop) {
      this.store.scrollTop = top;
    } else if (top + rowHeight > this.store.scrollTop + this.viewportHeight) {
      this.store.scrollTop = top + rowHeight - this.viewportHeight;
    }
    this.changed('layout', 'labels', 'waves');
  }

  // ── trace ────────────────────────────────────────────────────────────

  /** Move to a trace event and, for GRF writes, select the matching register row. */
  activateTraceEvent(event: WaveformTraceEvent): void {
    this.setCursor(event.time, { reveal: true });
    if (event.kind !== 'grf' || !this.store.data) {
      return;
    }
    const data = this.store.data;
    const alias = gprNames[Number.parseInt(event.target, 10)]?.names[0];
    // Only words of a 32 × 32-bit register file carry a GPR alias.
    const row = alias === undefined ? undefined : this.store.rows.allSignals().find((candidate) =>
      candidate.varIndex >= 0 && registerAlias(data, data.vars[candidate.varIndex]) === alias);
    if (row) {
      const group = this.store.rows.find(row.id)?.group;
      if (group?.collapsed) {
        group.collapsed = false;
        this.rowsChanged();
      }
      this.selectOnly([row.id]);
      this.revealRow(row.id);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private cursorVisible(): boolean {
    return this.store.cursor >= this.store.view.start && this.store.cursor <= this.store.view.end;
  }

  private rowsChanged(): void {
    this.reconcileSelection();
    this.changed('labels', 'values', 'waves', 'toolbar', 'layout', 'status');
  }

  private markersChanged(): void {
    this.changed('waves', 'ruler', 'overview', 'toolbar');
  }

  /**
   * Keep the selection and its anchor on visible rows after any change to the row
   * structure: a row hidden in a collapsed group is represented by that group, and
   * removed rows are dropped. An anchor that is gone falls back to the most
   * recently selected row, so ranges and edge stepping never act on hidden rows.
   */
  private reconcileSelection(): void {
    const shownAs = new Map<number, number>();
    for (const row of this.store.rows.topLevel) {
      shownAs.set(row.id, row.id);
      if (row.kind === 'group') {
        row.children.forEach((child) => shownAs.set(child.id, row.collapsed ? row.id : child.id));
      }
    }
    const selection = this.store.selection;
    const selected = [...selection].map((id) => shownAs.get(id)).filter((id): id is number => id !== undefined);
    selection.clear();
    selected.forEach((id) => selection.add(id));
    const anchor = this.store.selectionAnchor;
    this.store.selectionAnchor = (anchor !== undefined ? shownAs.get(anchor) : undefined) ?? selected[selected.length - 1];
  }

  private changed(...flags: DirtyFlag[]): void {
    this.store.invalidate(...flags);
    this.store.persist();
  }
}
