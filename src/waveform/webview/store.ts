// @index waveform-webview-store — Webview 状态中心：文档、视窗/游标/标记、信号行与选择、时钟周期、trace；rAF 合批的脏区通知与状态持久化

import type { WaveformTraceData } from '../model/protocol';
import { isRadix, Radix } from '../model/radix';
import type { PersistedLayout, PersistedViewState, SidebarPanel } from '../model/viewStateContract';
import { persistedViewStateVersion } from '../model/viewStateContract';
import type { WaveformData } from '../model/waveformData';
import { CycleCounter } from '../view/cycleCounter';
import { defaultRadix, defaultSignalPlan, detectClock } from '../view/signalDefaults';
import { buildSignalTree, TreeNode } from '../view/signalTree';
import { clampView, dataBounds, fitView, TimeRange } from '../view/viewport';
import { SignalRowInput, WaveRowList } from '../view/waveRows';

export type DirtyFlag = 'waves' | 'ruler' | 'overview' | 'labels' | 'values' | 'toolbar' | 'browser' | 'trace' | 'layout' | 'status';

export const allDirty: readonly DirtyFlag[] = ['waves', 'ruler', 'overview', 'labels', 'values', 'toolbar', 'browser', 'trace', 'layout', 'status'];

export interface Layout {
  sidebarWidth: number;
  nameWidth: number;
  valueWidth: number;
  sidebar: SidebarPanel;
}

export interface TraceIndex {
  readonly grf: Float64Array;
  readonly dm: Float64Array;
  /** Time of every event, index-aligned with trace.events. */
  readonly all: Float64Array;
}

/** Clock cycles shown when a long CPU dump is opened for the first time. */
const initialVisibleCycles = 48;

/**
 * A readable first view: fitting 50 000 cycles squeezes every bus into a solid
 * band, so long clocked dumps open on their first few dozen cycles instead.
 */
export function initialCycleView(cycles: CycleCounter, bounds: TimeRange): TimeRange {
  const end = cycles.edgeTime(initialVisibleCycles + 1);
  return cycles.totalCycles > initialVisibleCycles * 2 && end !== undefined
    ? { start: bounds.start, end }
    : fitView(bounds);
}

export class WaveStore {
  data: WaveformData | undefined;
  fileName = '';
  bounds: TimeRange = { start: 0, end: 2 };
  view: TimeRange = { start: 0, end: 2 };
  cursor = 0;
  hoverTime: number | undefined;
  markers: number[] = [];
  /** Marker used for Δ measurements, or -1. */
  activeMarker = -1;
  readonly rows = new WaveRowList();
  readonly selection = new Set<number>();
  selectionAnchor: number | undefined;
  clockVar: number | undefined;
  /** Persisted clock preference: a path, null (cycle counting disabled) or undefined (auto-detect). */
  clockPreference: string | null | undefined;
  cycles: CycleCounter | undefined;
  trace: WaveformTraceData | undefined;
  traceIndex: TraceIndex | undefined;
  tree: TreeNode[] = [];
  readonly layout: Layout = { sidebarWidth: 280, nameWidth: 180, valueWidth: 140, sidebar: 'signals' };
  scrollTop = 0;
  loading: { loaded: number; total: number } | undefined;
  error: { message: string; canRetry: boolean } | undefined;

  private readonly pathToVar = new Map<string, number>();
  private readonly listeners: Array<(dirty: ReadonlySet<DirtyFlag>) => void> = [];
  private readonly pending = new Set<DirtyFlag>();
  private frame = 0;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private savedState: PersistedViewState | undefined;
  private persistEnabled = false;

  constructor(private readonly persistCallback: (state: PersistedViewState) => void) {}

  onChange(listener: (dirty: ReadonlySet<DirtyFlag>) => void): void {
    this.listeners.push(listener);
  }

  invalidate(...flags: DirtyFlag[]): void {
    for (const flag of flags.length ? flags : allDirty) {
      this.pending.add(flag);
    }
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => this.flush());
    }
  }

  private flush(): void {
    this.frame = 0;
    const dirty = new Set(this.pending);
    this.pending.clear();
    for (const listener of this.listeners) {
      listener(dirty);
    }
  }

  /** Remember persisted state from the host until the document arrives. */
  setSavedState(state: PersistedViewState | undefined): void {
    this.savedState = state;
    if (state?.layout) {
      this.applyLayout(state.layout);
    }
  }

  /** Install a (re)loaded dump, restoring rows and view from saved state or defaults. */
  setDocument(data: WaveformData, reload: boolean): void {
    this.data = data;
    this.loading = undefined;
    this.error = undefined;
    this.pathToVar.clear();
    data.vars.forEach((variable, index) => this.pathToVar.set(variable.path, index));
    this.bounds = dataBounds(data.startTime, data.endTime);
    this.tree = buildSignalTree(data);
    if (reload) {
      this.rows.rebind((path) => this.varIndex(path));
      this.view = clampView(this.view, this.bounds);
      this.cursor = Math.min(Math.max(this.cursor, this.bounds.start), this.bounds.end);
      this.markers = this.markers.filter((marker) => marker >= this.bounds.start && marker <= this.bounds.end);
      this.activeMarker = Math.min(this.activeMarker, this.markers.length - 1);
    } else if (this.savedState) {
      this.restore(this.savedState);
    } else {
      this.applyDefaults(data);
    }
    const firstOpen = !reload && !this.savedState;
    this.savedState = undefined;
    this.refreshClock();
    if (firstOpen && this.cycles) {
      this.view = clampView(initialCycleView(this.cycles, this.bounds), this.bounds);
    }
    this.persistEnabled = true;
    this.invalidate();
  }

  setTrace(trace: WaveformTraceData | undefined): void {
    this.trace = trace;
    if (!trace) {
      this.traceIndex = undefined;
    } else {
      const all = Float64Array.from(trace.events, (event) => event.time);
      this.traceIndex = {
        all,
        grf: Float64Array.from(trace.events.filter((event) => event.kind === 'grf'), (event) => event.time),
        dm: Float64Array.from(trace.events.filter((event) => event.kind === 'dm'), (event) => event.time)
      };
    }
    this.invalidate('trace', 'ruler', 'overview', 'toolbar');
  }

  varIndex(path: string): number {
    return this.pathToVar.get(path) ?? -1;
  }

  signalInput(varIndex: number, radix?: Radix, color?: number): SignalRowInput {
    const variable = this.data!.vars[varIndex];
    return {
      path: variable.path,
      varIndex,
      radix: radix ?? defaultRadix(variable),
      ...(color !== undefined ? { color } : {})
    };
  }

  setClock(varIndex: number | undefined): void {
    this.clockPreference = varIndex === undefined ? null : this.data?.vars[varIndex]?.path;
    this.refreshClock();
    this.invalidate('waves', 'ruler', 'toolbar', 'labels');
    this.persist();
  }

  private refreshClock(): void {
    const data = this.data;
    if (!data) {
      return;
    }
    let clock: number | undefined;
    if (this.clockPreference === null) {
      clock = undefined;
    } else if (typeof this.clockPreference === 'string') {
      const index = this.varIndex(this.clockPreference);
      clock = index >= 0 && data.vars[index].width === 1 ? index : detectClock(data);
    } else {
      clock = detectClock(data);
    }
    this.clockVar = clock;
    this.cycles = clock === undefined ? undefined : new CycleCounter(data.tracks, data.vars[clock].track);
  }

  private restore(state: PersistedViewState): void {
    this.rows.restore(state, (row) => {
      const varIndex = this.varIndex(row.path);
      const variable = varIndex >= 0 ? this.data!.vars[varIndex] : undefined;
      return {
        path: row.path,
        varIndex,
        radix: isRadix(row.radix) ? row.radix : variable ? defaultRadix(variable) : 'hex',
        ...(row.color !== undefined ? { color: row.color } : {})
      };
    });
    this.clockPreference = state.clock;
    const view = state.viewStart !== undefined && state.viewEnd !== undefined && state.viewEnd > state.viewStart
      ? { start: state.viewStart, end: state.viewEnd }
      : fitView(this.bounds);
    this.view = clampView(view, this.bounds);
    this.cursor = state.cursor !== undefined ? Math.min(Math.max(state.cursor, this.bounds.start), this.bounds.end) : this.bounds.start;
    this.markers = (state.markers ?? []).filter((marker) => marker >= this.bounds.start && marker <= this.bounds.end);
    this.activeMarker = this.markers.length ? 0 : -1;
  }

  private applyDefaults(data: WaveformData): void {
    const plan = defaultSignalPlan(data);
    this.rows.clear();
    this.rows.addSignals(plan.signals.map((index) => this.signalInput(index)));
    if (plan.registerFile) {
      this.rows.addGroup(
        `${plan.registerFile.name}（寄存器堆）`,
        plan.registerFile.words.map((index) => this.signalInput(index)),
        true
      );
    }
    this.view = fitView(this.bounds);
    this.cursor = this.bounds.start;
  }

  private applyLayout(layout: PersistedLayout): void {
    this.layout.sidebarWidth = layout.sidebarWidth ?? this.layout.sidebarWidth;
    this.layout.nameWidth = layout.nameWidth ?? this.layout.nameWidth;
    this.layout.valueWidth = layout.valueWidth ?? this.layout.valueWidth;
    this.layout.sidebar = layout.sidebar ?? this.layout.sidebar;
  }

  /** Debounced save of everything the user would expect to survive a reopen. */
  persist(): void {
    if (!this.persistEnabled) {
      return;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistCallback(this.snapshot());
    }, 400);
  }

  snapshot(): PersistedViewState {
    return {
      version: persistedViewStateVersion,
      rows: this.rows.toPersisted(),
      ...(this.clockPreference !== undefined ? { clock: this.clockPreference } : {}),
      viewStart: this.view.start,
      viewEnd: this.view.end,
      cursor: this.cursor,
      ...(this.markers.length ? { markers: [...this.markers] } : {}),
      layout: { ...this.layout }
    };
  }
}
