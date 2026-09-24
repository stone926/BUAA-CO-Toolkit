// @index waveform-webview-toolbar — 顶部工具栏：侧栏开关、缩放、跳变/周期步进、标记、游标时间输入（时间/#tick/周期）、周期与 Δ 读数、进制选择、重载与帮助

import { isRadix, radixes, radixLabels } from '../model/radix';
import { displayUnitFor, formatTicks } from '../model/timeScale';
import { parseTimeInput } from '../view/timeInput';
import type { WaveActions } from './actions';
import { h, setText, toggleClass } from './dom';
import type { HostChannel } from './hostChannel';
import { IconName, icons } from './icons';
import { measurementLabel } from './rulerRenderer';
import type { DirtyFlag, WaveStore } from './store';

export interface ToolbarCallbacks {
  readonly toggleSidebar: () => void;
  readonly showHelp: () => void;
  readonly notify: (message: string) => void;
}

export class Toolbar {
  readonly element: HTMLElement;
  private readonly timeInput: HTMLInputElement;
  private readonly cycleLabel: HTMLSpanElement;
  private readonly measureLabel: HTMLSpanElement;
  private readonly radixSelect: HTMLSelectElement;
  private readonly edgeButtons: HTMLButtonElement[] = [];
  private readonly cycleButtons: HTMLButtonElement[] = [];

  constructor(
    private readonly store: WaveStore,
    private readonly actions: WaveActions,
    private readonly host: HostChannel,
    private readonly callbacks: ToolbarCallbacks
  ) {
    this.timeInput = h('input', {
      className: 'time-input',
      title: '游标时刻。可输入 500ns、1.5us、#474000（原始 tick）或 c120（第 120 个时钟上升沿），回车跳转（Ctrl+G）',
      attrs: { spellcheck: 'false' }
    });
    this.timeInput.addEventListener('focus', () => this.timeInput.select());
    this.timeInput.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        this.submitTime();
      } else if (event.key === 'Escape') {
        this.timeInput.blur();
      }
    });
    this.timeInput.addEventListener('blur', () => {
      this.timeInput.classList.remove('invalid');
      this.store.invalidate('toolbar');
    });
    this.cycleLabel = h('span', { className: 'readout cycle', title: '游标所在的时钟周期（上升沿计数）' });
    this.measureLabel = h('span', { className: 'readout measure', title: '游标与当前标记之间的时间差' });
    this.radixSelect = h('select', { className: 'radix-select', title: '所选信号的显示进制' }, [
      h('option', { text: '进制…', attrs: { value: '', disabled: '' } }),
      ...radixes.map((radix) => h('option', { text: radixLabels[radix], attrs: { value: radix } }))
    ]);
    this.radixSelect.addEventListener('change', () => {
      const value = this.radixSelect.value;
      if (isRadix(value)) {
        this.actions.setRadix(value);
      }
    });

    const edge = (icon: IconName, title: string, action: () => void): HTMLButtonElement => {
      const button = this.button(icon, title, action);
      this.edgeButtons.push(button);
      return button;
    };
    const cycle = (icon: IconName, title: string, action: () => void): HTMLButtonElement => {
      const button = this.button(icon, title, action);
      this.cycleButtons.push(button);
      return button;
    };
    this.element = h('header', { className: 'toolbar' }, [
      this.button('sidebar', '显示/隐藏侧栏', () => this.callbacks.toggleSidebar()),
      h('span', { className: 'separator' }),
      this.button('fit', '显示全部 (F)', () => this.actions.zoomFit()),
      this.button('zoomOut', '缩小 (-)', () => this.actions.zoom(0.5)),
      this.button('zoomIn', '放大 (+)', () => this.actions.zoom(2)),
      h('span', { className: 'separator' }),
      edge('previousEdge', '所选信号的上一次跳变 (←)', () => this.actions.navigateEdge(-1)),
      edge('nextEdge', '所选信号的下一次跳变 (→)', () => this.actions.navigateEdge(1)),
      cycle('previousCycle', '上一个时钟上升沿 (Shift+←)', () => this.actions.navigateCycle(-1)),
      cycle('nextCycle', '下一个时钟上升沿 (Shift+→)', () => this.actions.navigateCycle(1)),
      h('span', { className: 'separator' }),
      this.button('marker', '在游标处添加标记 (M)，用于测量时间差', () => this.actions.addMarker()),
      h('span', { className: 'separator' }),
      h('span', { className: 'time-field' }, [h('span', { className: 'time-field-icon', html: icons.clock }), this.timeInput]),
      this.cycleLabel,
      this.measureLabel,
      h('span', { className: 'spacer' }),
      this.radixSelect,
      this.button('reload', '重新加载波形文件', () => this.host.reload()),
      this.button('help', '快捷键与操作说明 (?)', () => this.callbacks.showHelp())
    ]);
  }

  focusTimeInput(): void {
    this.timeInput.focus();
  }

  render(dirty: ReadonlySet<DirtyFlag>): void {
    if (!dirty.has('toolbar') && !dirty.has('labels')) {
      return;
    }
    const data = this.store.data;
    if (data && document.activeElement !== this.timeInput) {
      this.timeInput.value = formatTicks(this.store.cursor, data.timescale);
    }
    const cycles = this.store.cycles;
    setText(this.cycleLabel, cycles ? `第 ${cycles.cycleAt(this.store.cursor)} 周期` : '');
    this.cycleLabel.hidden = !cycles;
    const marker = this.store.markers[this.store.activeMarker];
    const measuring = data !== undefined && marker !== undefined && marker !== this.store.cursor;
    setText(this.measureLabel, measuring
      ? `M${this.store.activeMarker + 1} ${measurementLabel(this.store, Math.min(marker, this.store.cursor), Math.max(marker, this.store.cursor))}`
      : '');
    this.measureLabel.hidden = !measuring;
    for (const button of this.cycleButtons) {
      button.disabled = !cycles;
    }
    const hasSignal = this.actions.focusedSignal() !== undefined;
    for (const button of this.edgeButtons) {
      button.disabled = !hasSignal && !cycles;
    }
    const targets = this.actions.targetSignals();
    const radixSet = new Set(targets.map((row) => row.radix));
    this.radixSelect.disabled = targets.length === 0;
    this.radixSelect.value = radixSet.size === 1 ? [...radixSet][0] : '';
    toggleClass(this.radixSelect, 'mixed', radixSet.size > 1);
  }

  private submitTime(): void {
    const data = this.store.data;
    if (!data) {
      return;
    }
    // A bare number uses the unit currently shown in the readout (e.g. `474 ns` → ns).
    const target = parseTimeInput(this.timeInput.value, data.timescale, displayUnitFor(this.store.cursor * data.timescale.femtoseconds));
    if (!target || !this.actions.goTo(target)) {
      this.timeInput.classList.add('invalid');
      this.callbacks.notify(target?.kind === 'cycle' ? '没有这个时钟周期（未识别到时钟或超出范围）' : '无法识别的时间，例如：500ns、1.5us、#474000、c120');
      return;
    }
    this.timeInput.classList.remove('invalid');
    this.timeInput.blur();
  }

  private button(icon: IconName, title: string, action: () => void): HTMLButtonElement {
    const button = h('button', { className: 'tool-button', title, html: icons[icon], attrs: { 'aria-label': title } });
    button.addEventListener('click', action);
    return button;
  }
}
