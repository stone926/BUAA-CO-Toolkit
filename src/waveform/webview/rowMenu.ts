// @index waveform-webview-row-menu — 信号行/分组右键菜单与信号值复制：进制、颜色、源码跳转、时钟、跳变导航、分组与移除

import { radixes, radixLabels } from '../model/radix';
import { changeIndexAt } from '../model/signalValues';
import { formatEventAt, formatTrackValue } from '../model/valueFormat';
import type { SignalRow } from '../view/waveRows';
import type { WaveActions } from './actions';
import type { MenuEntry } from './contextMenu';
import type { HostChannel } from './hostChannel';
import type { WaveStore } from './store';
import { Palette, rowColorNames } from './theme';

export interface RowMenuContext {
  readonly store: WaveStore;
  readonly actions: WaveActions;
  readonly host: HostChannel;
  readonly palette: Palette;
  /** Start inline renaming of a group row. */
  readonly renameGroup: (groupId: number) => void;
}

/** Entries for a right-click on row `id` (the selection is updated to include it first). */
export function rowMenuEntries(context: RowMenuContext, id: number): MenuEntry[] {
  const { store, actions, host, palette } = context;
  const found = store.rows.find(id);
  if (!found) {
    return [];
  }
  const signals = actions.targetSignals();
  const radixSet = new Set(signals.map((row) => row.radix));
  const colorSet = new Set(signals.map((row) => row.color ?? 0));
  const entries: MenuEntry[] = [];
  if (signals.length) {
    entries.push(
      {
        label: '显示进制',
        submenu: radixes.map((radix) => ({
          label: radixLabels[radix],
          checked: radixSet.size === 1 && radixSet.has(radix),
          action: () => actions.setRadix(radix)
        }))
      },
      {
        label: '颜色',
        submenu: palette.rowColors.map((color, index) => ({
          label: rowColorNames[index] ?? `颜色 ${index + 1}`,
          swatch: color,
          checked: colorSet.size === 1 && colorSet.has(index),
          action: () => actions.setColor(index === 0 ? undefined : index)
        }))
      }
    );
  }
  const row = found.row;
  if (row.kind === 'signal') {
    const variable = row.varIndex >= 0 ? store.data?.vars[row.varIndex] : undefined;
    entries.push(
      'separator',
      { label: '跳转到源码', disabled: !variable, action: () => host.openSource(row.path, false) },
      { label: '上一次跳变', shortcut: '←', disabled: !variable, action: () => actions.navigateEdge(-1) },
      { label: '下一次跳变', shortcut: '→', disabled: !variable, action: () => actions.navigateEdge(1) }
    );
    if (variable && variable.width === 1) {
      const isClock = store.clockVar === row.varIndex;
      entries.push({
        label: isClock ? '不再用作时钟（关闭周期计数）' : '设为时钟（按上升沿计周期）',
        action: () => actions.setClock(isClock ? undefined : row.varIndex)
      });
    }
    entries.push(
      'separator',
      { label: '复制游标处的值', disabled: !variable, action: () => host.copyText(valueAtCursor(store, row)) },
      { label: '复制完整路径', action: () => host.copyText(row.path) }
    );
  }
  entries.push('separator');
  if (row.kind === 'group') {
    entries.push(
      { label: row.collapsed ? '展开分组' : '折叠分组', action: () => actions.toggleGroup(row.id) },
      { label: '重命名分组', action: () => context.renameGroup(row.id) },
      { label: '取消分组', action: () => actions.ungroup(row.id) }
    );
  } else if (store.selection.size > 1 || !found.group) {
    entries.push({ label: '将所选信号编成分组', shortcut: 'G', action: () => actions.groupSelected() });
  }
  entries.push({ label: store.selection.size > 1 ? `移除所选 ${store.selection.size} 行` : '移除', shortcut: 'Delete', action: () => actions.removeSelected() });
  return entries;
}

export function valueAtCursor(store: WaveStore, row: SignalRow): string {
  const data = store.data;
  if (!data || row.varIndex < 0) {
    return '';
  }
  const variable = data.vars[row.varIndex];
  if (variable.kind === 'event') {
    return formatEventAt(data.tracks, variable.track, store.cursor);
  }
  const index = changeIndexAt(data.tracks, variable.track, store.cursor);
  return index < 0 ? '' : formatTrackValue(data.tracks, variable.track, index, row.radix);
}
