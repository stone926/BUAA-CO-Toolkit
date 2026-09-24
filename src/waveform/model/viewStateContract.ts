// @index waveform-state — 持久化的波形视图状态契约（信号行/分组/进制/颜色/游标/标记/布局）与宿主侧不信任输入的清洗

import { isRadix, Radix } from './radix';

export const persistedViewStateVersion = 1;
export const maximumPersistedRows = 2000;
export const maximumPersistedMarkers = 64;
const maximumTextLength = 1024;
export const rowColorCount = 8;

export interface PersistedSignalRow {
  readonly kind: 'signal';
  /** WaveVar.path of the displayed signal. */
  readonly path: string;
  readonly radix?: Radix;
  /** Index into the row color palette; absent means the default color. */
  readonly color?: number;
}

export interface PersistedGroupRow {
  readonly kind: 'group';
  readonly name: string;
  readonly collapsed?: boolean;
  readonly rows: readonly PersistedSignalRow[];
}

export type PersistedRow = PersistedSignalRow | PersistedGroupRow;

export type SidebarPanel = 'signals' | 'trace' | 'hidden';

export interface PersistedLayout {
  readonly sidebarWidth?: number;
  readonly nameWidth?: number;
  readonly valueWidth?: number;
  readonly sidebar?: SidebarPanel;
}

export interface PersistedViewState {
  readonly version: typeof persistedViewStateVersion;
  readonly rows: readonly PersistedRow[];
  /** WaveVar.path of the clock used for cycle counting, or null when disabled. */
  readonly clock?: string | null;
  readonly viewStart?: number;
  readonly viewEnd?: number;
  readonly cursor?: number;
  readonly markers?: readonly number[];
  readonly layout?: PersistedLayout;
}

/** Validate an untrusted value (e.g. from a webview or old storage); returns undefined when unusable. */
export function sanitizePersistedViewState(value: unknown): PersistedViewState | undefined {
  if (!isRecord(value) || value.version !== persistedViewStateVersion || !Array.isArray(value.rows)) {
    return undefined;
  }
  const rows: PersistedRow[] = [];
  let rowCount = 0;
  for (const row of value.rows) {
    if (rowCount >= maximumPersistedRows) {
      break;
    }
    if (isRecord(row) && row.kind === 'group' && typeof row.name === 'string' && Array.isArray(row.rows)) {
      const children = row.rows
        .map(sanitizeSignalRow)
        .filter((child): child is PersistedSignalRow => child !== undefined)
        .slice(0, maximumPersistedRows - rowCount);
      rowCount += children.length + 1;
      rows.push({
        kind: 'group',
        name: row.name.slice(0, maximumTextLength),
        ...(row.collapsed === true ? { collapsed: true } : {}),
        rows: children
      });
      continue;
    }
    const signal = sanitizeSignalRow(row);
    if (signal) {
      rows.push(signal);
      rowCount++;
    }
  }
  const markers = Array.isArray(value.markers)
    ? value.markers.filter(isFiniteNumber).slice(0, maximumPersistedMarkers)
    : undefined;
  const layout = sanitizeLayout(value.layout);
  return {
    version: persistedViewStateVersion,
    rows,
    ...(typeof value.clock === 'string' && value.clock.length <= maximumTextLength ? { clock: value.clock } : {}),
    ...(value.clock === null ? { clock: null } : {}),
    ...(isFiniteNumber(value.viewStart) ? { viewStart: value.viewStart } : {}),
    ...(isFiniteNumber(value.viewEnd) ? { viewEnd: value.viewEnd } : {}),
    ...(isFiniteNumber(value.cursor) ? { cursor: value.cursor } : {}),
    ...(markers && markers.length ? { markers } : {}),
    ...(layout ? { layout } : {})
  };
}

function sanitizeSignalRow(value: unknown): PersistedSignalRow | undefined {
  if (!isRecord(value) || value.kind !== 'signal' || typeof value.path !== 'string'
    || !value.path || value.path.length > maximumTextLength) {
    return undefined;
  }
  return {
    kind: 'signal',
    path: value.path,
    ...(isRadix(value.radix) ? { radix: value.radix } : {}),
    ...(Number.isInteger(value.color) && (value.color as number) >= 0 && (value.color as number) < rowColorCount
      ? { color: value.color as number }
      : {})
  };
}

function sanitizeLayout(value: unknown): PersistedLayout | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const width = (candidate: unknown): number | undefined =>
    isFiniteNumber(candidate) && candidate >= 40 && candidate <= 4000 ? Math.round(candidate) : undefined;
  const sidebarWidth = width(value.sidebarWidth);
  const nameWidth = width(value.nameWidth);
  const valueWidth = width(value.valueWidth);
  const sidebar = value.sidebar === 'signals' || value.sidebar === 'trace' || value.sidebar === 'hidden'
    ? value.sidebar
    : undefined;
  return {
    ...(sidebarWidth !== undefined ? { sidebarWidth } : {}),
    ...(nameWidth !== undefined ? { nameWidth } : {}),
    ...(valueWidth !== undefined ? { valueWidth } : {}),
    ...(sidebar ? { sidebar } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
