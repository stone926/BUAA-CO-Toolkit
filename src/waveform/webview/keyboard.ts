// @index waveform-webview-keys — 全局快捷键分派（输入框内不拦截）与快捷键帮助浮层

import { radixes } from '../model/radix';
import type { WaveActions } from './actions';
import { h } from './dom';
import type { WaveStore } from './store';

export interface KeyboardTargets {
  readonly store: WaveStore;
  readonly actions: WaveActions;
  readonly focusSearch: () => void;
  readonly focusTime: () => void;
  readonly toggleHelp: () => void;
  /** Escape handling for transient UI; returns true when something was dismissed. */
  readonly dismiss: () => boolean;
}

export const shortcutHelp: ReadonlyArray<readonly [string, string]> = [
  ['单击波形', '放置游标（吸附到附近的跳变，按住 Alt 不吸附）'],
  ['拖动波形 / 标尺', '框选时间区间并放大（拖动时显示 Δt 与周期数）'],
  ['拖动游标或标记线', '移动它们'],
  ['Ctrl + 滚轮', '以指针为中心缩放'],
  ['Shift + 滚轮 / 中键拖动', '左右平移'],
  ['← / →', '所选信号的上一次 / 下一次跳变（未选信号时按周期）'],
  ['Shift + ← / →', '上一个 / 下一个时钟上升沿'],
  ['Home / End', '游标移到开头 / 结尾'],
  ['+ / - / F', '放大 / 缩小 / 显示全部'],
  ['C', '以游标为中心'],
  ['M / Shift + M', '在游标处添加标记 / 删除最近的标记'],
  ['[ / ]', '跳到上一个 / 下一个标记'],
  ['↑ / ↓（Shift 扩选）', '选择上 / 下一行'],
  ['R', '切换所选信号的进制'],
  ['G', '将所选信号编成分组'],
  ['Delete', '移除所选行'],
  ['Ctrl + A', '全选信号行'],
  ['Ctrl + G', '跳转到输入的时间或时钟周期（如 500ns、c120）'],
  ['Ctrl + F 或 /', '搜索信号'],
  ['双击信号名', '跳转到 Verilog 源码'],
  ['Esc', '取消拖动 / 关闭浮层']
];

export function installKeyboard(targets: KeyboardTargets): void {
  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
      return;
    }
    if (handleKey(targets, event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

function handleKey(targets: KeyboardTargets, event: KeyboardEvent): boolean {
  const { actions, store } = targets;
  const control = event.ctrlKey || event.metaKey;
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      if (control) {
        actions.panPixels(direction * actions.waveWidth * 0.25);
      } else if (event.shiftKey) {
        actions.navigateCycle(direction);
      } else {
        actions.navigateEdge(direction);
      }
      return true;
    }
    case 'ArrowUp':
    case 'ArrowDown':
      actions.moveSelection(event.key === 'ArrowUp' ? -1 : 1, event.shiftKey);
      return true;
    case 'Home':
    case 'End':
      actions.goToBoundary(event.key === 'End');
      return true;
    case '+':
    case '=':
      actions.zoom(2);
      return true;
    case '-':
    case '_':
      actions.zoom(0.5);
      return true;
    case 'Delete':
    case 'Backspace':
      actions.removeSelected();
      return true;
    case 'Escape':
      if (!targets.dismiss() && store.selection.size) {
        actions.selectOnly([]);
      }
      return true;
    case '[':
    case ']':
      actions.navigateMarker(event.key === '[' ? -1 : 1);
      return true;
    case '?':
    case 'F1':
      targets.toggleHelp();
      return true;
    case '/':
      targets.focusSearch();
      return true;
    default:
      break;
  }
  const key = event.key.toLowerCase();
  if (control) {
    switch (key) {
      case 'a':
        actions.selectAll();
        return true;
      case 'f':
        targets.focusSearch();
        return true;
      case 'g':
        targets.focusTime();
        return true;
      default:
        return false;
    }
  }
  if (event.altKey) {
    return false;
  }
  switch (key) {
    case 'f':
      actions.zoomFit();
      return true;
    case 'c':
      actions.centerOn(store.cursor);
      return true;
    case 'm':
      if (event.shiftKey) {
        actions.removeNearestMarker();
      } else {
        actions.addMarker();
      }
      return true;
    case 'g':
      actions.groupSelected();
      return true;
    case 'r': {
      const signals = actions.targetSignals();
      if (signals.length) {
        const next = radixes[(radixes.indexOf(signals[0].radix) + 1) % radixes.length];
        actions.setRadix(next);
      }
      return true;
    }
    default:
      return false;
  }
}

/** Modal list of shortcuts. */
export class HelpOverlay {
  readonly element: HTMLElement;

  constructor() {
    const rows = shortcutHelp.map(([keys, description]) => h('tr', {}, [
      h('td', {}, [h('kbd', { text: keys })]),
      h('td', { text: description })
    ]));
    const close = h('button', { className: 'primary-button', text: '知道了' });
    close.addEventListener('click', () => this.hide());
    this.element = h('div', { className: 'help-overlay', attrs: { role: 'dialog', 'aria-label': '快捷键' } }, [
      h('div', { className: 'overlay-card help-card' }, [
        h('div', { className: 'overlay-title', text: '波形查看器操作' }),
        h('table', { className: 'help-table' }, [h('tbody', {}, rows)]),
        close
      ])
    ]);
    this.element.hidden = true;
    this.element.addEventListener('click', (event) => {
      if (event.target === this.element) {
        this.hide();
      }
    });
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  toggle(): void {
    this.element.hidden = !this.element.hidden;
  }

  hide(): void {
    this.element.hidden = true;
  }
}
