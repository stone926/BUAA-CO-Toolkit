// @index waveform-rows — 波形信号行模型：信号/分组行、按路径解析与去重、增删移动、分组、进制/颜色与持久化往返

import type { Radix } from '../model/radix';
import type { PersistedRow, PersistedSignalRow, PersistedViewState } from '../model/viewStateContract';

export interface SignalRow {
  readonly kind: 'signal';
  readonly id: number;
  readonly path: string;
  /** Index into WaveformData.vars, or -1 when the path is absent from the current dump. */
  varIndex: number;
  radix: Radix;
  color?: number;
}

export interface GroupRow {
  readonly kind: 'group';
  readonly id: number;
  name: string;
  collapsed: boolean;
  readonly children: SignalRow[];
}

export type WaveRow = SignalRow | GroupRow;

/** One line of the rendered list: a group header or a signal (possibly inside a group). */
export interface VisibleRow {
  readonly row: WaveRow;
  readonly group?: GroupRow;
}

export interface SignalRowInput {
  readonly path: string;
  readonly varIndex: number;
  readonly radix: Radix;
  readonly color?: number;
}

/** Where new rows go: before a row, at the end of a group, or at the end of the list. */
export type RowInsertion =
  | { readonly kind: 'end' }
  | { readonly kind: 'before'; readonly rowId: number }
  | { readonly kind: 'group-end'; readonly groupId: number };

export class WaveRowList {
  private rows: WaveRow[] = [];
  private nextId = 1;

  get topLevel(): readonly WaveRow[] {
    return this.rows;
  }

  get isEmpty(): boolean {
    return this.rows.length === 0;
  }

  visibleRows(): VisibleRow[] {
    const visible: VisibleRow[] = [];
    for (const row of this.rows) {
      visible.push({ row });
      if (row.kind === 'group' && !row.collapsed) {
        for (const child of row.children) {
          visible.push({ row: child, group: row });
        }
      }
    }
    return visible;
  }

  allSignals(): SignalRow[] {
    return this.rows.flatMap((row) => (row.kind === 'group' ? row.children : [row]));
  }

  find(id: number): { row: WaveRow; group?: GroupRow } | undefined {
    for (const row of this.rows) {
      if (row.id === id) {
        return { row };
      }
      if (row.kind === 'group') {
        const child = row.children.find((candidate) => candidate.id === id);
        if (child) {
          return { row: child, group: row };
        }
      }
    }
    return undefined;
  }

  /** Add signals not already present in the target container; returns the ids of the rows added. */
  addSignals(inputs: readonly SignalRowInput[], insertion: RowInsertion = { kind: 'end' }): number[] {
    const container = this.containerFor(insertion);
    const existing = new Set(container.list.map((row) => (row.kind === 'signal' ? row.path : '')));
    const created: SignalRow[] = [];
    for (const input of inputs) {
      if (existing.has(input.path)) {
        continue;
      }
      existing.add(input.path);
      created.push(this.createSignal(input));
    }
    container.list.splice(container.index, 0, ...created);
    return created.map((row) => row.id);
  }

  addGroup(name: string, inputs: readonly SignalRowInput[], collapsed = false, insertion: RowInsertion = { kind: 'end' }): number {
    const seen = new Set<string>();
    const children = inputs
      .filter((input) => (seen.has(input.path) ? false : (seen.add(input.path), true)))
      .map((input) => this.createSignal(input));
    const group: GroupRow = { kind: 'group', id: this.nextId++, name, collapsed, children };
    const container = this.containerFor(insertion.kind === 'group-end' ? { kind: 'end' } : insertion);
    container.list.splice(container.index, 0, group);
    return group.id;
  }

  remove(ids: ReadonlySet<number>): void {
    this.detach(ids);
  }

  clear(): void {
    this.rows = [];
  }

  /**
   * Move rows (signals and/or whole groups) before `beforeId` (or to the end when
   * undefined). Signals moved before a grouped signal join that group; groups are
   * never nested, so a group dropped inside another lands before it.
   */
  move(ids: readonly number[], beforeId: number | undefined): void {
    const moving = new Set(ids);
    if (beforeId !== undefined && moving.has(beforeId)) {
      return;
    }
    const picked: WaveRow[] = [];
    for (const row of this.visibleRowsIncludingCollapsed()) {
      if (moving.has(row.row.id)) {
        if (row.group && moving.has(row.group.id)) {
          continue;
        }
        picked.push(row.row);
      }
    }
    if (!picked.length) {
      return;
    }
    this.detach(moving);
    const target = beforeId === undefined ? undefined : this.find(beforeId);
    if (target?.group) {
      const signals = picked.filter((row): row is SignalRow => row.kind === 'signal');
      const groups = picked.filter((row): row is GroupRow => row.kind === 'group');
      const index = target.group.children.indexOf(target.row as SignalRow);
      target.group.children.splice(index, 0, ...signals);
      const groupIndex = this.rows.indexOf(target.group);
      this.rows.splice(groupIndex, 0, ...groups);
      return;
    }
    const index = target ? this.rows.indexOf(target.row) : this.rows.length;
    this.rows.splice(index < 0 ? this.rows.length : index, 0, ...picked);
  }

  /** Move rows to the end of a group (drops on a group header). */
  moveIntoGroup(ids: readonly number[], groupId: number): void {
    const group = this.find(groupId)?.row;
    if (!group || group.kind !== 'group') {
      return;
    }
    const moving = new Set(ids.filter((id) => id !== groupId));
    const signals = this.allSignals().filter((row) => moving.has(row.id));
    if (!signals.length) {
      return;
    }
    this.detach(new Set(signals.map((row) => row.id)));
    group.children.push(...signals);
  }

  /** Wrap the selected signals into a new group placed where the first of them was. */
  groupSignals(ids: readonly number[], name: string): number | undefined {
    const selected = new Set(ids);
    const signals = this.allSignals().filter((row) => selected.has(row.id));
    if (!signals.length) {
      return undefined;
    }
    const first = this.find(signals[0].id)!;
    const anchor = first.group ?? first.row;
    const anchorIndex = this.rows.indexOf(anchor);
    this.detach(new Set(signals.map((row) => row.id)));
    const group: GroupRow = { kind: 'group', id: this.nextId++, name, collapsed: false, children: signals };
    const index = this.rows.indexOf(anchor);
    this.rows.splice(index >= 0 ? index : Math.min(anchorIndex, this.rows.length), 0, group);
    return group.id;
  }

  ungroup(groupId: number): void {
    const index = this.rows.findIndex((row) => row.id === groupId);
    const group = this.rows[index];
    if (!group || group.kind !== 'group') {
      return;
    }
    this.rows.splice(index, 1, ...group.children);
  }

  toPersisted(): PersistedRow[] {
    return this.rows.map((row) => (row.kind === 'group'
      ? {
          kind: 'group',
          name: row.name,
          ...(row.collapsed ? { collapsed: true } : {}),
          rows: row.children.map(persistSignal)
        }
      : persistSignal(row)));
  }

  /** Replace all rows from persisted state, resolving each path against the current dump. */
  restore(
    state: Pick<PersistedViewState, 'rows'>,
    resolve: (row: PersistedSignalRow) => SignalRowInput
  ): void {
    this.rows = state.rows.map((row) => (row.kind === 'group'
      ? {
          kind: 'group',
          id: this.nextId++,
          name: row.name,
          collapsed: row.collapsed === true,
          children: row.rows.map((child) => this.createSignal(resolve(child)))
        }
      : this.createSignal(resolve(row))));
  }

  /** Re-resolve every signal after the dump was reloaded. */
  rebind(resolvePath: (path: string) => number): void {
    for (const row of this.allSignals()) {
      row.varIndex = resolvePath(row.path);
    }
  }

  private createSignal(input: SignalRowInput): SignalRow {
    return {
      kind: 'signal',
      id: this.nextId++,
      path: input.path,
      varIndex: input.varIndex,
      radix: input.radix,
      ...(input.color !== undefined ? { color: input.color } : {})
    };
  }

  private containerFor(insertion: RowInsertion): { list: WaveRow[]; index: number } {
    if (insertion.kind === 'group-end') {
      const group = this.find(insertion.groupId)?.row;
      if (group?.kind === 'group') {
        return { list: group.children, index: group.children.length };
      }
    }
    if (insertion.kind === 'before') {
      const target = this.find(insertion.rowId);
      if (target?.group) {
        return { list: target.group.children, index: target.group.children.indexOf(target.row as SignalRow) };
      }
      if (target) {
        return { list: this.rows, index: this.rows.indexOf(target.row) };
      }
    }
    return { list: this.rows, index: this.rows.length };
  }

  private detach(ids: ReadonlySet<number>): void {
    this.rows = this.rows.filter((row) => !ids.has(row.id));
    for (const row of this.rows) {
      if (row.kind === 'group') {
        const kept = row.children.filter((child) => !ids.has(child.id));
        row.children.splice(0, row.children.length, ...kept);
      }
    }
  }

  private visibleRowsIncludingCollapsed(): VisibleRow[] {
    const all: VisibleRow[] = [];
    for (const row of this.rows) {
      all.push({ row });
      if (row.kind === 'group') {
        for (const child of row.children) {
          all.push({ row: child, group: row });
        }
      }
    }
    return all;
  }
}

function persistSignal(row: SignalRow): PersistedSignalRow {
  return {
    kind: 'signal',
    path: row.path,
    radix: row.radix,
    ...(row.color !== undefined ? { color: row.color } : {})
  };
}
