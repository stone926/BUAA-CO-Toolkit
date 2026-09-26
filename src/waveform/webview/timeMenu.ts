// @index waveform-webview-time-menu — 波形/标尺时间点右键菜单：放游标、添加标记、删除指针下的标记或从列表中选择删除、清除标记、缩放

import { formatTicks } from '../model/timeScale';
import { markerName, type WaveMarker } from '../view/markers';
import type { WaveActions } from './actions';
import type { MenuEntry, MenuItem } from './contextMenu';
import type { WaveStore } from './store';

/** Entries for a right-click at `time`; `marker` is the marker under the pointer, if any. */
export function timeMenuEntries(store: WaveStore, actions: WaveActions, time: number, marker: WaveMarker | undefined): MenuEntry[] {
  const rounded = Math.round(time);
  return [
    { label: '游标移到此处', action: () => actions.setCursor(rounded) },
    { label: '在此处添加标记', shortcut: 'M', action: () => actions.addMarker(rounded) },
    marker
      ? { label: `删除标记 ${markerName(marker)}`, action: () => actions.removeMarker(marker.label) }
      : deleteMarkerMenu(store, actions),
    { label: '清除全部标记', disabled: !store.markers.size, action: () => actions.clearMarkers() },
    'separator',
    { label: '以此处为中心放大', shortcut: 'Ctrl+滚轮', action: () => actions.zoom(2, rounded) },
    { label: '显示全部', shortcut: 'F', action: () => actions.zoomFit() }
  ];
}

/** Choose any marker to delete, including ones outside the visible range. */
function deleteMarkerMenu(store: WaveStore, actions: WaveActions): MenuItem {
  const timescale = store.data?.timescale;
  const markers = [...store.markers.all].sort((left, right) => left.label - right.label);
  return {
    label: '删除标记',
    disabled: !markers.length,
    submenu: markers.map((marker) => ({
      label: markerName(marker),
      shortcut: timescale ? formatTicks(marker.time, timescale) : undefined,
      action: () => actions.removeMarker(marker.label)
    }))
  };
}
